// Editor-side half of the Premiere Pro package. Runs inside the Grid
// Editor's package-manager process (Node). It registers the action
// blocks, receives their gps("package-premiere-pro", ...) calls from
// the module over serial, and forwards them as commands to the
// Premiere-side CEP extension over a local TCP socket.
//
// Direction: this package is the SERVER. The CEP panel (which has
// Node integration) connects to it as a client and evaluates the
// commands through ExtendScript. This mirrors the Lightroom package,
// only the external half is a CEP extension instead of a .lrplugin.

const net = require("net");
const fs = require("fs");
const path = require("path");

// The port the CEP panel connects to. Kept distinct from the
// Lightroom package's ports so both can run side by side. The env
// override exists so tests can run while a real editor instance holds
// the default port.
const BRIDGE_PORT = Number(process.env.GRID_PP_BRIDGE_PORT) || 23120;

// Premiere's fixed tick rate; frame math mirrors host.jsx.
const TICKS_PER_SECOND = 254016000000;

// The package does not draw on the screen directly: the module profile
// repaints its own UI from the screen's draw event, so a one-shot frame
// pushed from outside is overwritten within one draw trigger (~25ms).
// Instead only the pptc global is kept fresh (a tiny immediate script),
// and the Timecode Display action block renders it from INSIDE the
// draw event, where it persists.
const SEND_MIN_MS = 100; // max ~10 pptc updates per second
const JOG_QUIET_MS = 600; // hold pptc updates while jog events stream

let controller;
let preferenceMessagePort = undefined;

let server; // net.Server
let panelSocket = undefined; // the connected CEP panel, if any
let packageShutDown = false;
let actionId = 0;

let isPanelConnected = false;
let lastLegacyValue = undefined;
let legacyWarned = false;

// Arrival telemetry for the module->editor leg: if the knob feels
// laggy while the panel-side evals are fast, the delay is upstream of
// this process. Aggregates land in the same stats log as the panel's.
let jogArrivals = 0;
let jogGapSum = 0;
let jogGapMax = 0;
let lastArrivalAt = 0;

setInterval(() => {
  if (jogArrivals === 0) return;
  try {
    fs.appendFileSync(
      "C:\\Users\\sabot\\AppData\\Local\\Temp\\pp-stats.log",
      new Date().toISOString() +
        " " +
        JSON.stringify({
          type: "editor-stats",
          jogN: jogArrivals,
          gapAvg: Math.round(jogGapSum / Math.max(1, jogArrivals - 1)),
          gapMax: jogGapMax,
        }) +
        "\n",
    );
  } catch (e) {}
  jogArrivals = 0;
  jogGapSum = 0;
  jogGapMax = 0;
}, 3000).unref?.();

// Playhead readout state. lastTc is the last timecode the panel
// reported; pendingTc waits on the throttle timer; sentAny tracks
// whether pptc was ever set (so the nil on disconnect/disable only
// fires when there is something to clear).
let screenEnabled = true;
let lastTc = undefined;
let pendingTc = undefined;
let sendTimer = undefined;
let lastSendAt = 0;
let lastJogAt = 0;
let sentAny = false;

function notifyStatusChange() {
  preferenceMessagePort?.postMessage({
    type: "status",
    isPanelConnected,
    screenReadout: screenEnabled,
  });
}

// hh:mm:ss:ff from Premiere ticks + ticks-per-frame. Non-drop-frame:
// on 29.97/59.94 drop-frame sequences this can drift a touch from
// Premiere's own display, which is fine for a hardware readout.
function formatTimecode(ticksStr, tpf) {
  const ticks = Number(ticksStr);
  if (!isFinite(ticks) || !isFinite(tpf) || tpf <= 0) return undefined;
  const fps = Math.max(1, Math.round(TICKS_PER_SECOND / tpf));
  const frames = Math.max(0, Math.round(ticks / tpf));
  const ff = frames % fps;
  let s = Math.floor(frames / fps);
  const ss = s % 60;
  s = Math.floor(s / 60);
  const mm = s % 60;
  const hh = Math.floor(s / 60);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

// Push the timecode string into the pptc module global. Broadcast to
// the whole chain; a bare assignment is harmless on modules without a
// screen and cheap enough not to disturb the module during jogs.
function sendTimecode(tc) {
  lastSendAt = Date.now();
  sentAny = true;
  controller?.sendMessageToEditor({
    type: "execute-lua-script",
    script: `pptc='${tc}'`,
  });
}

function clearTimecode() {
  if (sendTimer) {
    clearTimeout(sendTimer);
    sendTimer = undefined;
  }
  pendingTc = undefined;
  lastClipScript = undefined;
  if (!sentAny) return;
  sentAny = false;
  controller?.sendMessageToEditor({
    type: "execute-lua-script",
    script: "pptc=nil ppcn=nil ppct=nil",
  });
}

// --- Selected-clip readout -------------------------------------------
// The panel reports the clicked clip's name + track; both go to the
// modules as the ppcn / ppct Lua globals for the display block.

let lastClipScript = undefined;

// Module-font-safe name: map Hungarian accents to base letters, drop
// anything non-printable or Lua-quote-hostile, and truncate to the 22
// characters that fit the screen at glyph size 16.
const ACCENT_MAP = {
  "á": "a", "é": "e", "í": "i", "ó": "o",
  "ö": "o", "ő": "o", "ú": "u", "ü": "u",
  "ű": "u", "Á": "A", "É": "E", "Í": "I",
  "Ó": "O", "Ö": "O", "Ő": "O", "Ú": "U",
  "Ü": "U", "Ű": "U",
};

function moduleSafeName(name) {
  let s = Array.from(String(name))
    .map((ch) => {
      if (ACCENT_MAP[ch]) return ACCENT_MAP[ch];
      const code = ch.codePointAt(0);
      return code >= 32 && code < 127 ? ch : "?";
    })
    .join("")
    .replace(/['"\\]/g, " ")
    .trim();
  if (s.length > 21) s = s.slice(0, 18) + "...";
  return s;
}

// "V2" -> "Video 2", "A1" -> "Audio 1" for the display block.
function trackLabel(track) {
  const m = /^([AV])(\d{1,2})$/.exec(String(track));
  if (!m) return "?";
  return (m[1] === "A" ? "Audio " : "Video ") + m[2];
}

function sendClip(msg) {
  const script = msg.none
    ? "ppcn=nil ppct=nil"
    : `ppcn='${moduleSafeName(msg.name)}' ppct='${trackLabel(msg.track)}'`;
  if (script === lastClipScript) return;
  lastClipScript = script;
  controller?.sendMessageToEditor({ type: "execute-lua-script", script });
}

// Trailing-edge throttle: bursts collapse to at most one immediate-Lua
// packet per SEND_MIN_MS, and the final position always lands. While
// jog events are streaming, updates are held entirely: each pptc
// change makes the Timecode Display block repaint a full frame on the
// very module whose encoder produces the jog events, which reads as
// knob lag. The screen catches up the moment the twist pauses.
function queueTimecode(tc) {
  if (tc === lastTc) return;
  lastTc = tc;
  if (!screenEnabled) return;
  pendingTc = tc;
  scheduleSend(SEND_MIN_MS - (Date.now() - lastSendAt));
}

function scheduleSend(delayMs) {
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = undefined;
    if (pendingTc === undefined || !screenEnabled) return;
    const sinceJog = Date.now() - lastJogAt;
    if (sinceJog < JOG_QUIET_MS) {
      scheduleSend(JOG_QUIET_MS - sinceJog);
      return;
    }
    sendTimecode(pendingTc);
    pendingTc = undefined;
  }, Math.max(0, delayMs));
}

// Send one newline-delimited JSON command to the CEP panel. Silently
// no-ops when nothing is connected, so pressing a button with
// Premiere closed does nothing rather than erroring.
function sendToPanel(command) {
  if (!panelSocket || panelSocket.destroyed) return;
  try {
    panelSocket.write(JSON.stringify(command) + "\n");
  } catch (e) {
    // A broken pipe just means the panel went away; the server's
    // close handler will reset the connection state.
  }
}

function startServer() {
  if (packageShutDown) return;
  stopServer();

  server = net.createServer((socket) => {
    // Only one panel at a time: a new connection replaces the old.
    if (panelSocket && !panelSocket.destroyed) {
      panelSocket.destroy();
    }
    panelSocket = socket;
    isPanelConnected = true;
    // Tell the panel whether to run the readout at all: disabled means
    // zero polls and zero reports - the exact pre-readout behavior.
    sendToPanel({ cmd: "readout", enabled: screenEnabled });
    notifyStatusChange();

    socket.setEncoding("utf-8");
    socket.on("data", handlePanelData);
    socket.on("error", () => {});
    socket.on("close", () => {
      if (panelSocket === socket) {
        panelSocket = undefined;
        isPanelConnected = false;
        // Premiere went away: nil out the stale timecode (the display
        // block shows dashes) and forget it so a reconnect resends.
        lastTc = undefined;
        clearTimecode();
        notifyStatusChange();
      }
    });
  });

  server.on("error", (e) => {
    // Most likely EADDRINUSE from a stale instance; retry shortly.
    if (!packageShutDown) {
      setTimeout(startServer, 2000);
    }
  });

  server.listen(BRIDGE_PORT, "127.0.0.1");
}

function stopServer() {
  if (panelSocket) {
    panelSocket.destroy();
    panelSocket = undefined;
  }
  if (server) {
    server.close();
    server = undefined;
  }
  isPanelConnected = false;
}

// The panel can report back (e.g. current timeline position or an
// error). Kept minimal for now; surfaced to the editor log on failure.
let panelBuffer = "";
function handlePanelData(chunk) {
  panelBuffer += chunk;
  let index;
  while ((index = panelBuffer.indexOf("\n")) >= 0) {
    const line = panelBuffer.slice(0, index).trim();
    panelBuffer = panelBuffer.slice(index + 1);
    if (line === "") continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "error" && msg.message) {
        controller?.sendMessageToEditor({
          type: "show-message",
          message: `Premiere: ${msg.message}`,
          messageType: "fail",
        });
      } else if (msg.type === "stats") {
        // Timing telemetry from the panel (eval durations, queue
        // waits). Appended to a local file for diagnosing knob feel.
        try {
          fs.appendFileSync(
            "C:\\Users\\sabot\\AppData\\Local\\Temp\\pp-stats.log",
            new Date().toISOString() + " " + JSON.stringify(msg) + "\n",
          );
        } catch (e) {}
      } else if (msg.type === "playhead") {
        if (msg.none) {
          queueTimecode("--:--:--:--");
        } else {
          const tc = formatTimecode(msg.ticks, msg.tpf);
          if (tc) queueTimecode(tc);
        }
      } else if (msg.type === "clip") {
        if (screenEnabled) sendClip(msg);
      }
    } catch (e) {
      // Ignore malformed lines from the panel.
    }
  }
}

exports.loadPackage = async function (gridController, persistedData) {
  packageShutDown = false;
  controller = gridController;
  screenEnabled = persistedData?.screenReadout !== false;

  const actionIcon = fs.readFileSync(
    path.resolve(__dirname, "premiere-action-icon.svg"),
    { encoding: "utf-8" },
  );

  function createAction(overrides) {
    gridController.sendMessageToEditor({
      type: "add-action",
      info: {
        actionId: actionId++,
        rendering: "standard",
        category: "premiere",
        color: "#9999FF",
        icon: actionIcon,
        blockIcon: actionIcon,
        selectable: true,
        movable: true,
        hideIcon: false,
        type: "single",
        toggleable: true,
        ...overrides,
      },
    });
  }

  // Timeline Navigate — the hero. Signed detent delta from the
  // element's own 64-centered step state (endless epst, encoder est),
  // chosen at runtime so one script serves both. Same pattern the
  // editor's Scroll block hardware-proved. Off-element it yields 0.
  createAction({
    short: "xpptl",
    displayName: "Timeline Navigate",
    defaultLua:
      'gps("package-premiere-pro", "timeline", (((self.epst and self:epst()) or (self.est and self:est()) or 64)-64)*1)',
    actionComponent: "premiere-timeline-action",
  });

  // Markers — add at the playhead, or jump to the next/previous one.
  createAction({
    short: "xppmk",
    displayName: "Marker",
    defaultLua: 'gps("package-premiere-pro", "marker", "add")',
    actionComponent: "premiere-marker-action",
  });

  // In / Out points on the active sequence.
  createAction({
    short: "xppio",
    displayName: "In / Out Point",
    defaultLua: 'gps("package-premiere-pro", "inout", "in")',
    actionComponent: "premiere-inout-action",
  });

  // Premiere Display - goes INSIDE the screen element's draw event so
  // the profile's own draw loop cannot overwrite it. Three outlined
  // panels: clip name, channel, playhead timecode (yellow). Values
  // come from the pptc / ppcn / ppct globals. Repaints only when the
  // shown text changes (self.pptl remembers the last drawn key), swaps
  // its own frame, and guards on self.ldft so it is inert off-screen.
  createAction({
    short: "xpptc",
    displayName: "Premiere Display",
    defaultLua:
      "local t=pptc or '--:--:--:--' local n=ppcn or '-' " +
      "local c=ppct or '-' local k=t..n..c " +
      "if self.ldft and k~=self.pptl then self.pptl=k " +
      "self:ldaf(0,0,319,239,{0,0,0}) " +
      "self:ldrr(2,2,317,76,6,{255,255,255}) " +
      "self:ldft('Clip name',10,8,8,{255,255,255}) " +
      "self:ldft(n,10,38,16,{255,255,255}) " +
      "self:ldrr(2,82,317,156,6,{255,255,255}) " +
      "self:ldft('Channel',10,88,8,{255,255,255}) " +
      "self:ldft(c,10,114,24,{255,255,255}) " +
      "self:ldrr(2,162,317,236,6,{255,255,255}) " +
      "self:ldft('Playhead Position',10,168,8,{255,255,255}) " +
      "self:ldft(t,10,194,24,{215,255,60}) " +
      "self:ldsw() end",
    actionComponent: "premiere-timecode-action",
  });

  startServer();
  notifyStatusChange();
};

exports.unloadPackage = async function () {
  packageShutDown = true;
  while (actionId > 0) {
    controller.sendMessageToEditor({
      type: "remove-action",
      actionId: --actionId,
    });
  }
  clearTimecode();
  stopServer();
};

// The preference panel connects here for live connection status.
exports.addMessagePort = async function (port, senderId) {
  if (senderId === "premiere-preference") {
    preferenceMessagePort = port;
    port.on("message", (e) => {
      if (e.data?.type === "request-status") {
        notifyStatusChange();
      } else if (e.data?.type === "set-screen-readout") {
        screenEnabled = !!e.data.enabled;
        controller?.sendMessageToEditor({
          type: "persist-data",
          data: { screenReadout: screenEnabled },
        });
        sendToPanel({ cmd: "readout", enabled: screenEnabled });
        if (!screenEnabled) {
          clearTimecode();
        } else if (lastTc !== undefined) {
          // Resend the last known position right away instead of
          // waiting for the playhead to move again.
          sendTimecode(lastTc);
        }
        notifyStatusChange();
      }
    });
    port.start();
    notifyStatusChange();
  }
};

// gps("package-premiere-pro", <group>, ...args) lands here. Each group
// maps to one command shape the CEP panel understands.
exports.sendMessage = async function (args) {
  if (!Array.isArray(args)) return;
  const group = args[0];


  if (group === "timeline") {
    // Current scripts send one signed delta: ["timeline", delta].
    // Legacy scripts (pre-fix) sent ["timeline", absoluteValue, mode];
    // derive a delta from the change so old blocks degrade gracefully
    // instead of scrubbing one way forever.
    let delta;
    if (args.length >= 3) {
      const value = Number(args[1]);
      if (!isFinite(value)) return;
      delta =
        typeof lastLegacyValue === "number" ? value - lastLegacyValue : 0;
      lastLegacyValue = value;
      if (!legacyWarned) {
        legacyWarned = true;
        controller?.sendMessageToEditor({
          type: "show-message",
          message:
            "Timeline Navigate block uses an outdated script - remove and re-add it for exact jogging.",
          messageType: "fail",
        });
      }
    } else {
      delta = Number(args[1]);
    }
    if (!isFinite(delta) || delta === 0) return;
    lastJogAt = Date.now();
    if (jogArrivals > 0 && lastArrivalAt) {
      const gap = lastJogAt - lastArrivalAt;
      jogGapSum += gap;
      if (gap > jogGapMax) jogGapMax = gap;
    }
    jogArrivals++;
    lastArrivalAt = lastJogAt;
    if (delta > 240) delta = 240;
    if (delta < -240) delta = -240;
    sendToPanel({ cmd: "timeline", delta });
    return;
  }

  if (group === "marker") {
    // args: ["marker", "add" | "next" | "prev"]
    sendToPanel({ cmd: "marker", action: String(args[1] ?? "add") });
    return;
  }

  if (group === "inout") {
    // args: ["inout", "in" | "out" | "clear"]
    sendToPanel({ cmd: "inout", action: String(args[1] ?? "in") });
    return;
  }
};

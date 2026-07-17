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

let controller;
let preferenceMessagePort = undefined;

let server; // net.Server
let panelSocket = undefined; // the connected CEP panel, if any
let packageShutDown = false;
let actionId = 0;

let isPanelConnected = false;
let lastLegacyValue = undefined;
let legacyWarned = false;

// Playhead readout state. lastTc is the last timecode the panel
// reported; pendingTc waits on the throttle timer; sentAny tracks
// whether pptc was ever set (so the nil on disconnect/disable only
// fires when there is something to clear).
let screenEnabled = true;
let lastTc = undefined;
let pendingTc = undefined;
let sendTimer = undefined;
let lastSendAt = 0;
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
  if (!sentAny) return;
  sentAny = false;
  controller?.sendMessageToEditor({
    type: "execute-lua-script",
    script: "pptc=nil",
  });
}

// Trailing-edge throttle: bursts (playback, fast jogs) collapse to at
// most one immediate-Lua packet per SEND_MIN_MS, and the final
// position always lands.
function queueTimecode(tc) {
  if (tc === lastTc) return;
  lastTc = tc;
  if (!screenEnabled) return;
  pendingTc = tc;
  if (sendTimer) return;
  const wait = Math.max(0, SEND_MIN_MS - (Date.now() - lastSendAt));
  sendTimer = setTimeout(() => {
    sendTimer = undefined;
    if (pendingTc !== undefined && screenEnabled) {
      sendTimecode(pendingTc);
      pendingTc = undefined;
    }
  }, wait);
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
      } else if (msg.type === "playhead") {
        if (msg.none) {
          queueTimecode("--:--:--:--");
        } else {
          const tc = formatTimecode(msg.ticks, msg.tpf);
          if (tc) queueTimecode(tc);
        }
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

  // Timecode Display - goes INSIDE the screen element's draw event so
  // the profile's own draw loop cannot overwrite it. Repaints only when
  // pptc changed (self.pptl remembers the last drawn value), swaps its
  // own frame, and guards on self.ldft so it is inert off-screen.
  createAction({
    short: "xpptc",
    displayName: "Timecode Display",
    defaultLua:
      "if self.ldft and pptc~=self.pptl then self.pptl=pptc " +
      "self:ldaf(0,0,319,239,{0,0,0}) " +
      "self:ldft(pptc or '--:--:--:--',40,108,24,{255,255,255}) " +
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

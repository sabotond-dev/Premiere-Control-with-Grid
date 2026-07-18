// Editor-side half of the Premiere Pro package. Runs inside the Grid
// Editor's package-manager process (Node). It registers the action
// blocks, receives their gps("package-premiere-pro", ...) calls from
// the module over serial, and forwards them as commands to the
// Premiere-side UXP plugin over a local WebSocket.
//
// Direction: this package is the SERVER. The UXP plugin connects to it
// as a client (UXP has no Node and no raw TCP, but standard WebSocket
// works with a manifest network permission). Same architecture as the
// Photoshop package, only the host app half is Premiere.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const openExplorer = require("open-file-explorer");

// The port the UXP plugin connects to. Kept distinct from the
// Photoshop package's 3542 so both can run side by side. The env
// override exists so tests can run while a real editor instance holds
// the default port.
const BRIDGE_PORT = Number(process.env.GRID_PP_BRIDGE_PORT) || 3543;

// Premiere's fixed tick rate; frame math mirrors the plugin.
const TICKS_PER_SECOND = 254016000000;

// The package does not draw on the screen directly: the module profile
// repaints its own UI from the screen's draw event, so a one-shot frame
// pushed from outside is overwritten within one draw trigger (~25ms).
// Instead only the pptc/ppcn/ppct globals are kept fresh (tiny
// immediate scripts), and the Premiere Display action block renders
// them from INSIDE the draw event, where they persist.
const SEND_MIN_MS = 100; // max ~10 pptc updates per second
const JOG_QUIET_MS = 600; // hold pptc updates while jog events stream

let controller;
let preferenceMessagePort = undefined;

let wss = undefined; // WebSocket.Server
let panelWs = undefined; // the connected UXP plugin, if any
let packageShutDown = false;
let actionId = 0;

let isPanelConnected = false;
let lastLegacyValue = undefined;
let legacyWarned = false;

// Playhead readout state. lastTc is the last timecode the plugin
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
// screen.
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
// The plugin reports the clicked clip's name + track; both go to the
// modules as the ppcn / ppct Lua globals for the display block.

let lastClipScript = undefined;

// Module-font-safe name: map Hungarian accents to base letters, drop
// anything non-printable or Lua-quote-hostile, and truncate to the 21
// characters that fit the screen at glyph size 16.
const ACCENT_MAP = {
  á: "a",
  é: "e",
  í: "i",
  ó: "o",
  ö: "o",
  ő: "o",
  ú: "u",
  ü: "u",
  ű: "u",
  Á: "A",
  É: "E",
  Í: "I",
  Ó: "O",
  Ö: "O",
  Ő: "O",
  Ú: "U",
  Ü: "U",
  Ű: "U",
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
// change makes the Premiere Display block repaint a full frame on the
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
  sendTimer = setTimeout(
    () => {
      sendTimer = undefined;
      if (pendingTc === undefined || !screenEnabled) return;
      const sinceJog = Date.now() - lastJogAt;
      if (sinceJog < JOG_QUIET_MS) {
        scheduleSend(JOG_QUIET_MS - sinceJog);
        return;
      }
      sendTimecode(pendingTc);
      pendingTc = undefined;
    },
    Math.max(0, delayMs),
  );
}

// --- Timeline zoom ---------------------------------------------------
// Premiere's UXP API has no timeline-view zoom, and keyboard shortcuts
// are keyboard-layout-dependent (HID positions, not characters). The
// real gesture is Ctrl+scroll over the timeline, so we synthesize
// exactly that at the OS level: a persistent PowerShell helper holds a
// SendInput binding and turns each knob burst into ONE native
// ctrl+wheel event with a multiplied delta - no message flood, no
// layout dependence, works wherever the mouse hovers (like the real
// gesture; no panel focus needed). Windows-only for now.

const ZOOM_HELPER_PS = `
$cs = @"
using System;
using System.Runtime.InteropServices;
public class GridZoom {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static void Wheel(int delta) {
    INPUT[] list = new INPUT[3];
    list[0].type = 1; list[0].U.ki = new KEYBDINPUT { wVk = 0x11 };
    list[1].type = 0; list[1].U.mi = new MOUSEINPUT { mouseData = unchecked((uint)delta), dwFlags = 0x0800 };
    list[2].type = 1; list[2].U.ki = new KEYBDINPUT { wVk = 0x11, dwFlags = 0x0002 };
    SendInput(3, list, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
Add-Type -TypeDefinition $cs
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $n = 0
  if ([int]::TryParse($line, [ref]$n) -and $n -ne 0) { [GridZoom]::Wheel($n * 120) }
}
`;

let zoomProc = undefined;
let zoomAccum = 0;
let zoomTimer = undefined;

function ensureZoomHelper() {
  if (zoomProc || packageShutDown) return;
  if (process.platform !== "win32" || process.env.GRID_PP_DISABLE_ZOOM) return;
  try {
    const encoded = Buffer.from(ZOOM_HELPER_PS, "utf16le").toString("base64");
    zoomProc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NoLogo", "-NonInteractive", "-EncodedCommand", encoded],
      { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
    );
    zoomProc.on("exit", () => {
      zoomProc = undefined;
    });
    zoomProc.on("error", () => {
      zoomProc = undefined;
    });
  } catch (e) {
    zoomProc = undefined;
  }
}

function stopZoomHelper() {
  if (zoomTimer) {
    clearTimeout(zoomTimer);
    zoomTimer = undefined;
  }
  zoomAccum = 0;
  if (zoomProc) {
    try {
      zoomProc.stdin.end();
      zoomProc.kill();
    } catch (e) {}
    zoomProc = undefined;
  }
}

// Detent bursts coalesce for 25ms and leave as a single wheel event.
function queueZoom(delta) {
  ensureZoomHelper();
  zoomAccum += delta;
  if (zoomTimer) return;
  zoomTimer = setTimeout(() => {
    zoomTimer = undefined;
    const n = zoomAccum;
    zoomAccum = 0;
    if (n === 0 || !zoomProc) return;
    try {
      zoomProc.stdin.write(String(n) + "\n");
    } catch (e) {}
  }, 25);
}

// Send one JSON command to the UXP plugin. Silently no-ops when
// nothing is connected, so pressing a button with Premiere closed
// does nothing rather than erroring.
function sendToPanel(command) {
  if (!panelWs || panelWs.readyState !== WebSocket.OPEN) return;
  try {
    panelWs.send(JSON.stringify(command));
  } catch (e) {
    // A failed send just means the plugin went away; the close
    // handler will reset the connection state.
  }
}

function startServer() {
  if (packageShutDown) return;
  stopServer();

  wss = new WebSocket.Server({ port: BRIDGE_PORT, host: "127.0.0.1" });

  wss.on("connection", (ws) => {
    // Only one plugin at a time: a new connection replaces the old.
    if (panelWs && panelWs.readyState === WebSocket.OPEN) {
      panelWs.close();
    }
    panelWs = ws;
    isPanelConnected = true;
    // Tell the plugin whether to run the readout at all: disabled
    // means zero polls and zero reports.
    sendToPanel({ cmd: "readout", enabled: screenEnabled });
    notifyStatusChange();

    ws.on("message", handlePanelMessage);
    ws.on("error", () => {});
    ws.on("close", () => {
      if (panelWs === ws) {
        panelWs = undefined;
        isPanelConnected = false;
        // Premiere went away: nil out the stale readout values (the
        // display block shows dashes) and forget them so a reconnect
        // resends.
        lastTc = undefined;
        clearTimecode();
        notifyStatusChange();
      }
    });
  });

  wss.on("error", (e) => {
    // Most likely EADDRINUSE from a stale instance; retry shortly.
    if (!packageShutDown) {
      setTimeout(startServer, 2000);
    }
  });
}

function stopServer() {
  if (panelWs) {
    try {
      panelWs.close();
    } catch (e) {}
    panelWs = undefined;
  }
  if (wss) {
    try {
      wss.close();
    } catch (e) {}
    wss = undefined;
  }
  isPanelConnected = false;
}

// The plugin reports back: playhead position, selected clip, errors.
function handlePanelMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (e) {
    return; // Ignore malformed messages from the plugin.
  }
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
  } else if (msg.type === "clip") {
    if (screenEnabled) sendClip(msg);
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
  // chosen at runtime so one script serves both. Off-element it
  // yields 0.
  createAction({
    short: "xpptl",
    displayName: "Timeline Navigate",
    defaultLua:
      'gps("package-premiere-pro", "timeline", (((self.epst and self:epst()) or (self.est and self:est()) or 64)-64)*1)',
    actionComponent: "premiere-timeline-action",
  });

  // Markers — add at the playhead, or jump to the next/previous one.
  // Edge-latched: Grid button events fire on press AND release, so a
  // bare gps() would trigger twice per press.
  createAction({
    short: "xppmk",
    displayName: "Marker",
    defaultLua:
      "if self:bst()>0 then if self.ppmk~=1 then self.ppmk=1 " +
      'gps("package-premiere-pro", "marker", "add") end ' +
      "else self.ppmk=0 end",
    actionComponent: "premiere-marker-action",
  });

  // In / Out points on the active sequence.
  createAction({
    short: "xppio",
    displayName: "In / Out Point",
    defaultLua:
      "if self:bst()>0 then if self.ppio~=1 then self.ppio=1 " +
      'gps("package-premiere-pro", "inout", "in") end ' +
      "else self.ppio=0 end",
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

  // Tool / Playhead / Clip / Project / View / Modifier / Zoom - the
  // command blocks. Their defaults must generate the same Lua as the
  // corresponding components (whitespace-insensitively), since the
  // dropdowns recognize options by regenerating and comparing scripts.
  createAction({
    short: "xpptool",
    displayName: "Tool",
    defaultLua:
      "if self:bst()>0 then if self.pptool~=1 then self.pptool=1 " +
      "gks(25,0,2,25) end else self.pptool=0 end",
    actionComponent: "premiere-tool-action",
  });

  createAction({
    short: "xpphd",
    displayName: "Playhead Edit",
    defaultLua:
      "if self:bst()>0 then if self.pphd~=1 then self.pphd=1 " +
      'gps("package-premiere-pro", "phead", "select") end ' +
      "else self.pphd=0 end",
    actionComponent: "premiere-phead-action",
  });

  createAction({
    short: "xppcl",
    displayName: "Clip",
    defaultLua:
      "if self:bst()>0 then if self.ppcl~=1 then self.ppcl=1 " +
      'gps("package-premiere-pro", "clipop", "toggle") end ' +
      "else self.ppcl=0 end",
    actionComponent: "premiere-clip-action",
  });

  createAction({
    short: "xpppj",
    displayName: "Project",
    defaultLua:
      "if self:bst()>0 then if self.pppr~=1 then self.pppr=1 " +
      'gps("package-premiere-pro", "project", "save") end ' +
      "else self.pppr=0 end",
    actionComponent: "premiere-project-action",
  });

  createAction({
    short: "xppvw",
    displayName: "View",
    defaultLua:
      "if self:bst()>0 then if self.ppvw~=1 then self.ppvw=1 " +
      "gks(25,0,2,22) end else self.ppvw=0 end",
    actionComponent: "premiere-view-action",
  });

  createAction({
    short: "xppmd",
    displayName: "Modifier Hold",
    defaultLua:
      "if self:bst()>0 then if self.ppmd~=1 then self.ppmd=1 " +
      "gks(25,1,1,4) end else " +
      "if self.ppmd==1 then self.ppmd=0 gks(25,1,0,4) end end",
    actionComponent: "premiere-modifier-action",
  });

  createAction({
    short: "xppzm",
    displayName: "Timeline Zoom",
    defaultLua:
      'gps("package-premiere-pro", "zoom", (((self.epst and self:epst()) or (self.est and self:est()) or 64)-64)*1)',
    actionComponent: "premiere-zoom-action",
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
  stopZoomHelper();
  preferenceMessagePort?.close();
};

// The preference panel connects here for live connection status.
exports.addMessagePort = async function (port, senderId) {
  if (senderId === "premiere-preference") {
    preferenceMessagePort = port;
    port.on("message", (e) => {
      if (e.data?.type === "request-status") {
        notifyStatusChange();
      } else if (e.data?.type === "open-plugin-folder") {
        // The built .ccx installer sits in the package root.
        openExplorer(__dirname);
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
// maps to one command shape the UXP plugin understands.
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
      delta = typeof lastLegacyValue === "number" ? value - lastLegacyValue : 0;
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

  if (group === "phead") {
    // args: ["phead", "select"] - playhead-scoped edits via the API.
    sendToPanel({ cmd: "phead", action: String(args[1] ?? "select") });
    return;
  }

  if (group === "clipop") {
    // args: ["clipop", "toggle" | "delete"] - selection-scoped edits.
    sendToPanel({ cmd: "clipop", action: String(args[1] ?? "toggle") });
    return;
  }

  if (group === "project") {
    // args: ["project", "save"]
    sendToPanel({ cmd: "project", action: String(args[1] ?? "save") });
    return;
  }

  if (group === "zoom") {
    // args: ["zoom", delta] - OS-level ctrl+wheel, not the plugin.
    let delta = Number(args[1]);
    if (!isFinite(delta) || delta === 0) return;
    if (delta > 10) delta = 10;
    if (delta < -10) delta = -10;
    queueZoom(delta);
    return;
  }
};

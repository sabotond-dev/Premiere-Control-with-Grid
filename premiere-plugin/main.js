// Premiere-side half of the Grid Premiere Pro package, as a UXP
// plugin. Connects to the Grid Editor package (WebSocket server on
// 127.0.0.1:3543), executes timeline/marker/in-out commands through
// the Premiere UXP DOM, and reports the playhead position and the
// selected clip back for the module-screen readout.
//
// Everything runs in modern JS against `require("premierepro")` - no
// ExtendScript, no eval bridge, no serialized single engine.

const ppro = require("premierepro");

const BRIDGE_URL = "ws://localhost:3543";
const RECONNECT_MS = 2000;

// Polling is adaptive: rare while the playhead is static, tighter once
// movement is seen (playback, mouse scrubs), silent around jogs (the
// jog op itself reports the fresh position).
const POLL_IDLE_MS = 500;
const POLL_ACTIVE_MS = 250;
const JOG_QUIET_MS = 800;

let socket = null;
let connected = false;
let readoutEnabled = true;

let pendingDelta = 0;
let opBusy = false;
let lastJogAt = 0;

let lastPlayheadKey = null;
let lastClipKey = null;
let pollMoving = false;

// --- Panel UI --------------------------------------------------------

function setStatus(text, on) {
  const dot = document.getElementById("dot");
  const label = document.getElementById("status");
  if (dot) dot.className = "dot" + (on ? " on" : "");
  if (label) label.textContent = text;
}

function logLine(text) {
  const el = document.getElementById("log");
  if (!el) return;
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  el.textContent = `${stamp}  ${text}\n${el.textContent}`.slice(0, 4000);
}

// --- Bridge ----------------------------------------------------------

function send(obj) {
  if (socket && connected) {
    try {
      socket.send(JSON.stringify(obj));
    } catch (e) {
      /* close handler resets state */
    }
  }
}

function sendError(e) {
  const message = String(e?.message ?? e).slice(0, 200);
  logLine("error: " + message);
  send({ type: "error", message });
}

function connect() {
  try {
    socket = new WebSocket(BRIDGE_URL);
  } catch (e) {
    // A synchronous throw here is almost always a manifest network
    // permission problem - log the real reason so it is diagnosable.
    setStatus("Cannot open WebSocket", false);
    logLine("WebSocket ctor: " + String(e?.message ?? e));
    setTimeout(connect, RECONNECT_MS);
    return;
  }

  socket.onopen = () => {
    connected = true;
    // Re-send state on a fresh connection: a restarted editor has no
    // idea where the timeline is until something changes.
    lastPlayheadKey = null;
    lastClipKey = null;
    setStatus("Connected to Grid Editor", true);
    logLine("connected");
  };

  socket.onmessage = (event) => {
    try {
      dispatch(JSON.parse(event.data));
    } catch (e) {
      logLine("bad command: " + String(event.data).slice(0, 80));
    }
  };

  socket.onerror = () => {
    /* handled by close */
  };

  socket.onclose = () => {
    const wasConnected = connected;
    connected = false;
    socket = null;
    if (wasConnected) logLine("disconnected");
    setStatus("Waiting for Grid Editor…", false);
    setTimeout(connect, RECONNECT_MS);
  };
}

function dispatch(command) {
  if (!command || !command.cmd) return;

  if (command.cmd === "readout") {
    readoutEnabled = !!command.enabled;
    lastPlayheadKey = null;
    lastClipKey = null;
    logLine("readout " + (readoutEnabled ? "on" : "off"));
    return;
  }

  if (command.cmd === "timeline") {
    const d = Number(command.delta);
    if (!isFinite(d) || d === 0) return;
    lastJogAt = Date.now();
    pendingDelta += d;
    runJog();
    return;
  }

  if (command.cmd === "marker") {
    runMarker(String(command.action || "add"));
    return;
  }

  if (command.cmd === "inout") {
    runInOut(String(command.action || "in"));
    return;
  }

  if (command.cmd === "phead") {
    runPlayheadOp(String(command.action || "select"));
    return;
  }

  if (command.cmd === "clipop") {
    runClipOp(String(command.action || "toggle"));
    return;
  }

  if (command.cmd === "project") {
    runProjectOp(String(command.action || "save"));
    return;
  }
}

// --- Premiere access -------------------------------------------------

async function activeSequence() {
  const project = await ppro.Project.getActiveProject();
  if (!project) return { project: null, seq: null };
  const seq = await project.getActiveSequence();
  return { project, seq };
}

// --- Timeline jog ----------------------------------------------------
// One operation in flight; deltas accumulate while busy and flush as
// one jump, so fast twists coalesce instead of queueing.

async function runJog() {
  if (opBusy || pendingDelta === 0) return;
  opBusy = true;
  let d = pendingDelta;
  pendingDelta = 0;
  if (d > 2000) d = 2000;
  if (d < -2000) d = -2000;

  try {
    const { seq } = await activeSequence();
    if (seq) {
      const pos = await seq.getPlayerPosition();
      const tpf = Number(await seq.getTimebase());
      if (isFinite(tpf) && tpf > 0) {
        let ticks = Number(pos.ticks) + d * tpf;
        if (ticks < 0) ticks = 0;
        const ticksString = String(Math.round(ticks));
        await seq.setPlayerPosition(ppro.TickTime.createWithTicks(ticksString));
        reportPlayhead(ticksString, tpf);
      }
    }
  } catch (e) {
    sendError(e);
  }

  opBusy = false;
  if (pendingDelta !== 0) runJog();
}

// --- Markers ---------------------------------------------------------

async function runMarker(action) {
  try {
    const { project, seq } = await activeSequence();
    if (!seq) return sendError("No active sequence");
    const pos = await seq.getPlayerPosition();

    if (action === "add") {
      const markers = await ppro.Markers.getMarkers(seq);
      const addAction = markers.createAddMarkerAction(
        "",
        "Comment",
        pos,
        ppro.TickTime.TIME_ZERO,
        "",
      );
      project.executeTransaction((compound) => {
        compound.addAction(addAction);
      }, "Add marker");
      return;
    }

    // next / prev: jump between existing marker start times.
    const markers = await ppro.Markers.getMarkers(seq);
    const list = markers.getMarkers();
    const times = [];
    for (const marker of list) {
      times.push(marker.getStart().ticksNumber);
    }
    if (times.length === 0) return;
    times.sort((a, b) => a - b);

    const here = pos.ticksNumber;
    const EPS = 1000; // ~4 microseconds in ticks; playhead-on-marker slack
    let target = undefined;
    if (action === "next") {
      target = times.find((t) => t > here + EPS);
    } else if (action === "prev") {
      target = [...times].reverse().find((t) => t < here - EPS);
    }
    if (target === undefined) return;
    await seq.setPlayerPosition(
      ppro.TickTime.createWithTicks(String(Math.round(target))),
    );
  } catch (e) {
    sendError(e);
  }
}

// --- In / Out points -------------------------------------------------

async function runInOut(action) {
  try {
    const { project, seq } = await activeSequence();
    if (!seq) return sendError("No active sequence");
    const pos = await seq.getPlayerPosition();

    if (action === "in") {
      project.executeTransaction((compound) => {
        compound.addAction(seq.createSetInPointAction(pos));
      }, "Set in point");
    } else if (action === "out") {
      project.executeTransaction((compound) => {
        compound.addAction(seq.createSetOutPointAction(pos));
      }, "Set out point");
    } else if (action === "clear") {
      const end = await seq.getEndTime();
      project.executeTransaction((compound) => {
        compound.addAction(seq.createSetInPointAction(ppro.TickTime.TIME_ZERO));
        compound.addAction(seq.createSetOutPointAction(end));
      }, "Clear in/out");
    }
  } catch (e) {
    sendError(e);
  }
}

// --- Playhead / clip / project commands (API-backed blocks) ----------

async function clipsUnderPlayhead(seq) {
  const pos = (await seq.getPlayerPosition()).ticksNumber;
  const clipType =
    (ppro.Constants &&
      ppro.Constants.TrackItemType &&
      ppro.Constants.TrackItemType.CLIP) ??
    1;
  const under = [];

  async function scanTrack(track) {
    if (!track) return;
    const items = (await track.getTrackItems(clipType, false)) || [];
    for (const item of items) {
      const start = (await item.getStartTime()).ticksNumber;
      const end = (await item.getEndTime()).ticksNumber;
      if (pos >= start && pos < end) under.push(item);
    }
  }

  const vCount = await seq.getVideoTrackCount();
  for (let i = 0; i < vCount; i++) await scanTrack(await seq.getVideoTrack(i));
  const aCount = await seq.getAudioTrackCount();
  for (let i = 0; i < aCount; i++) await scanTrack(await seq.getAudioTrack(i));
  return under;
}

async function runPlayheadOp(action) {
  try {
    if (action !== "select") return;
    const { seq } = await activeSequence();
    if (!seq) return sendError("No active sequence");

    const under = await clipsUnderPlayhead(seq);
    if (under.length === 0) return;
    ppro.TrackItemSelection.createEmptySelection((selection) => {
      for (const item of under) selection.addItem(item, false);
      seq.setSelection(selection);
    });
  } catch (e) {
    sendError(e);
  }
}

async function runClipOp(action) {
  try {
    const { project, seq } = await activeSequence();
    if (!seq) return sendError("No active sequence");
    const selection = await seq.getSelection();
    const items = selection ? await selection.getTrackItems() : [];
    if (!items || items.length === 0) return sendError("No clip selected");

    if (action === "toggle") {
      const actions = [];
      for (const item of items) {
        const disabled = await item.isDisabled();
        actions.push(item.createSetDisabledAction(!disabled));
      }
      project.executeTransaction((compound) => {
        for (const a of actions) compound.addAction(a);
      }, "Toggle clip enable");
      return;
    }

    if (action === "delete") {
      const editor = await ppro.SequenceEditor.getEditor(seq);
      const mediaType =
        (ppro.Constants &&
          ppro.Constants.MediaType &&
          (ppro.Constants.MediaType.ANY ?? ppro.Constants.MediaType.ALL)) ??
        undefined;
      const removeAction = editor.createRemoveItemsAction(
        selection,
        false,
        mediaType,
        false,
      );
      project.executeTransaction((compound) => {
        compound.addAction(removeAction);
      }, "Delete clips");
    }
  } catch (e) {
    sendError(e);
  }
}

async function runProjectOp(action) {
  try {
    if (action !== "save") return;
    const { project } = await activeSequence();
    if (!project) return sendError("No open project");
    await project.save();
  } catch (e) {
    sendError(e);
  }
}

// --- Playhead + selection readout ------------------------------------

function reportPlayhead(ticks, tpf) {
  if (!readoutEnabled) return;
  const key = ticks + "/" + tpf;
  if (key === lastPlayheadKey) return;
  lastPlayheadKey = key;
  send({ type: "playhead", ticks: String(ticks), tpf: Number(tpf) });
}

function reportNoSequence() {
  if (!readoutEnabled) return;
  if (lastPlayheadKey === "none") return;
  lastPlayheadKey = "none";
  send({ type: "playhead", none: true });
}

function reportClip(name, track) {
  if (!readoutEnabled) return;
  const key = name === null ? "none" : name + "|" + track;
  if (key === lastClipKey) return;
  lastClipKey = key;
  if (name === null) {
    send({ type: "clip", none: true });
  } else {
    send({ type: "clip", name: String(name), track: String(track || "?") });
  }
}

// Which track does the selected item live on? getTrackIndex gives the
// index inside its track group; audio vs video comes from the wrapper
// class name, with a track-scan fallback for safety. Only runs when
// the selection changes.
async function resolveTrack(seq, item) {
  const index = await item.getTrackIndex();
  const ctor = String(item?.constructor?.name ?? "");
  if (/audio/i.test(ctor)) return "A" + (index + 1);
  if (/video/i.test(ctor)) return "V" + (index + 1);

  // Fallback: see whether this item is among the video track's clips.
  try {
    const name = await item.getName();
    const start = (await item.getStartTime()).ticksNumber;
    const vt = await seq.getVideoTrack(index);
    if (vt) {
      const clipType = ppro.Constants?.TrackItemType?.CLIP ?? 1;
      const clips = vt.getTrackItems(clipType, false);
      for (const clip of clips) {
        const cName = await clip.getName();
        const cStart = (await clip.getStartTime()).ticksNumber;
        if (cName === name && cStart === start) return "V" + (index + 1);
      }
    }
  } catch (e) {
    /* fall through */
  }
  return "A" + (index + 1);
}

let selCacheKey = null;
let selCacheTrack = "?";

async function pollOnce() {
  if (!connected || !readoutEnabled) return;
  if (Date.now() - lastJogAt < JOG_QUIET_MS) return;
  if (opBusy) return;

  try {
    const { seq } = await activeSequence();
    if (!seq) {
      pollMoving = false;
      reportNoSequence();
      reportClip(null);
      return;
    }

    const pos = await seq.getPlayerPosition();
    const tpf = Number(await seq.getTimebase());
    if (isFinite(tpf) && tpf > 0) {
      const prevKey = lastPlayheadKey;
      reportPlayhead(String(pos.ticks), tpf);
      pollMoving = lastPlayheadKey !== prevKey;
    }

    // Selected clip: name + track, resolved only when the selection
    // changes.
    const selection = await seq.getSelection();
    const items = selection ? await selection.getTrackItems() : [];
    if (items && items.length > 0) {
      const item = items[0];
      const name = await item.getName();
      const index = await item.getTrackIndex();
      const key = name + "|" + index;
      if (key !== selCacheKey) {
        selCacheKey = key;
        selCacheTrack = await resolveTrack(seq, item);
      }
      reportClip(name, selCacheTrack);
    } else {
      selCacheKey = null;
      reportClip(null);
    }
  } catch (e) {
    // Polling errors are not worth spamming the editor about; the
    // panel log keeps the last one visible.
    logLine("poll: " + String(e?.message ?? e).slice(0, 120));
  }
}

function pollTick() {
  pollOnce().finally(() => {
    setTimeout(pollTick, pollMoving ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  });
}

// --- Boot ------------------------------------------------------------

setStatus("Waiting for Grid Editor…", false);
connect();
setTimeout(pollTick, POLL_IDLE_MS);

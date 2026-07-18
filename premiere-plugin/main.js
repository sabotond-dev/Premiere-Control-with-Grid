// Premiere-side half of the Grid Premiere Pro package, as a UXP
// plugin. Connects to the Grid Editor package (WebSocket server on
// 127.0.0.1:3543), executes timeline/marker/in-out commands through
// the Premiere UXP DOM, and reports the playhead position and the
// selected clip back for the module-screen readout.
//
// Everything runs in modern JS against `require("premierepro")` - no
// ExtendScript, no eval bridge, no serialized single engine.

const ppro = require("premierepro");

const PLUGIN_VERSION = "1.4.0-spike";
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

// Errors carry the step that failed; the panel log additionally keeps
// the first stack line so a single screenshot diagnoses the site.
function sendError(e, step) {
  const base = String(e?.message ?? e).slice(0, 160);
  const message = step ? `${step}: ${base}` : base;
  logLine("error: " + message);
  const stackLine = String(e?.stack ?? "").split("\n")[1];
  if (stackLine) logLine("  at " + stackLine.trim().slice(0, 120));
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
    setStatus(`Connected to Grid Editor · v${PLUGIN_VERSION}`, true);
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

  if (command.cmd === "pmap") {
    // Parameter-mapping SPIKE (feature/param-mapping branch).
    if (command.action === "probe") {
      runParamProbe();
      return;
    }
    queueParamValue(Number(command.slot), Number(command.value));
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

// Every mutation must run inside project.lockedAccess, and the actions
// must be created inside the transaction callback (Adobe's sample
// pattern - without the lock, actions fail with "script action failed
// to execute"). `build` receives the compound action and adds to it.
// Errors from inside the callbacks are re-thrown with the step tagged,
// so the panel log names the exact failing site.
function runTransaction(project, label, build) {
  let success = false;
  let inner;
  const wrapped = () => {
    success = project.executeTransaction((compound) => {
      try {
        build(compound);
      } catch (e) {
        inner = e;
        throw e;
      }
    }, label);
  };
  try {
    if (typeof project.lockedAccess === "function") {
      project.lockedAccess(wrapped);
    } else {
      logLine("lockedAccess missing - running transaction bare");
      wrapped();
    }
  } catch (e) {
    sendError(inner ?? e, `${label} (transaction)`);
    return false;
  }
  if (!success) {
    sendError(`executeTransaction returned false`, label);
  }
  return success;
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
    sendError(e, "jog");
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
      const markerType = ppro.Marker?.MARKER_TYPE_COMMENT ?? "Comment";
      // Diagnostic crumb: which API surfaces this Premiere build has.
      logLine(
        `marker probe: lockedAccess=${typeof project.lockedAccess} ` +
          `typeConst=${String(ppro.Marker?.MARKER_TYPE_COMMENT)} ` +
          `markers=${typeof markers?.createAddMarkerAction}`,
      );
      // Freeze the playhead into a plain TickTime - a live object from
      // getPlayerPosition may not survive into the locked transaction.
      const at = ppro.TickTime.createWithTicks(String(pos.ticks));
      runTransaction(project, "Add marker", (compound) => {
        compound.addAction(
          markers.createAddMarkerAction(
            "Marker",
            markerType,
            at,
            ppro.TickTime.TIME_ZERO,
            "",
          ),
        );
      });
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
    sendError(e, "marker " + action);
  }
}

// --- In / Out points -------------------------------------------------

async function runInOut(action) {
  try {
    const { project, seq } = await activeSequence();
    if (!seq) return sendError("No active sequence");
    const pos = await seq.getPlayerPosition();

    if (action === "in") {
      runTransaction(project, "Set in point", (compound) => {
        compound.addAction(seq.createSetInPointAction(pos));
      });
    } else if (action === "out") {
      runTransaction(project, "Set out point", (compound) => {
        compound.addAction(seq.createSetOutPointAction(pos));
      });
    } else if (action === "clear") {
      // True clear: set both points to the invalid time, which unsets
      // the marks (TIME_INVALID is undocumented but real, same as the
      // TIME_ZERO the marker sample uses). Setting 0..end instead
      // would not clear - it selects the whole sequence.
      const invalid = ppro.TickTime?.TIME_INVALID;
      logLine(`clear probe: TIME_INVALID=${String(invalid)}`);
      if (!invalid) {
        return sendError(
          "This Premiere build exposes no TIME_INVALID - cannot clear in/out natively",
          "inout clear",
        );
      }
      runTransaction(project, "Clear in/out", (compound) => {
        compound.addAction(seq.createSetInPointAction(invalid));
        compound.addAction(seq.createSetOutPointAction(invalid));
      });
    }
  } catch (e) {
    sendError(e, "inout " + action);
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

// Native trim: shorten the clips under the playhead up to it.
// "before" keeps the tail (clip now starts at the playhead, its source
// in-point advanced by the same delta so the picture does not shift);
// "after" keeps the head (clip ends at the playhead). Neither ripples -
// the UXP API has no ripple edit - so a gap is left behind, unlike
// Premiere's Q/W. Undoable as one transaction.
async function runTrim(seq, project, action) {
  const under = await clipsUnderPlayhead(seq);
  if (under.length === 0) return;
  const pos = await seq.getPlayerPosition();

  // Both directions are plain edge trims: createSetStartAction /
  // createSetEndAction anchor the content in sequence time and manage
  // the source in/out themselves (hardware-verified - an extra manual
  // in-point compensation double-shifted the content past the
  // playhead).
  runTransaction(
    project,
    action === "trimafter" ? "Trim after playhead" : "Trim before playhead",
    (compound) => {
      for (const item of under) {
        compound.addAction(
          action === "trimafter"
            ? item.createSetEndAction(pos)
            : item.createSetStartAction(pos),
        );
      }
    },
  );
}

async function runPlayheadOp(action) {
  try {
    const { project, seq } = await activeSequence();
    if (!seq) return sendError("No active sequence");

    if (action === "trimbefore" || action === "trimafter") {
      return await runTrim(seq, project, action);
    }
    if (action !== "select") return;

    const under = await clipsUnderPlayhead(seq);
    if (under.length === 0) return;

    // Proven pattern (Adobe premiere-api sample): clear, take the live
    // selection handle, add items to it, then hand it back to the
    // sequence. createEmptySelection did not apply from a plugin.
    await seq.clearSelection();
    const selection = await seq.getSelection();
    for (const item of under) selection.addItem(item, false);
    await seq.setSelection(selection);
  } catch (e) {
    sendError(e, "phead " + action);
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
      const plans = [];
      for (const item of items) {
        const disabled = await item.isDisabled();
        plans.push({ item, next: !disabled });
      }
      runTransaction(project, "Toggle clip enable", (compound) => {
        for (const plan of plans) {
          compound.addAction(plan.item.createSetDisabledAction(plan.next));
        }
      });
      return;
    }

    if (action === "delete") {
      const editor = await ppro.SequenceEditor.getEditor(seq);
      const mediaType =
        (ppro.Constants &&
          ppro.Constants.MediaType &&
          (ppro.Constants.MediaType.ANY ?? ppro.Constants.MediaType.ALL)) ??
        undefined;
      runTransaction(project, "Delete clips", (compound) => {
        compound.addAction(
          editor.createRemoveItemsAction(selection, false, mediaType, false),
        );
      });
    }
  } catch (e) {
    sendError(e, "clip " + action);
  }
}

async function runProjectOp(action) {
  try {
    const { project, seq } = await activeSequence();
    if (!project) return sendError("No open project");

    if (action === "save") {
      await project.save();
      return;
    }

    if (action === "export") {
      if (!seq) return sendError("No active sequence");
      const manager = await ppro.EncoderManager.getManager();
      const queue =
        (ppro.Constants &&
          ppro.Constants.ExportType &&
          ppro.Constants.ExportType.QUEUE_TO_AME) ??
        undefined;
      // Empty output/preset means "use the sequence's applied export
      // settings"; queueing to Media Encoder keeps Premiere responsive.
      await manager.exportSequence(seq, queue, "", "", true);
      return;
    }
  } catch (e) {
    sendError(e, "project " + action);
  }
}

// --- Parameter mapping SPIKE (feature/param-mapping branch) ----------
// Two research questions this answers on real hardware:
//  1. Can we enumerate a clip's effects + parameters (incl. Lumetri)?
//     -> "probe" dumps the full component/param tree to the editor,
//        which writes it to a JSON file.
//  2. What does a fader-driven createSetValueAction feel like at
//     ~10 transactions/second (undo history, playback smoothness)?
//     -> slot 1 is hardcoded to Lumetri "Exposure" on the selected
//        clip (or the first clip of V1), mapped 0..127 -> -5..+5.

let pmapCache = { clipKey: null, param: null, paramName: "", project: null };
let pmapPendingValue = undefined;
let pmapTimer = undefined;
let pmapLastErrorAt = 0;

async function selectedOrFirstClip(seq) {
  const selection = await seq.getSelection();
  const items = selection ? await selection.getTrackItems() : [];
  if (items && items.length > 0) return items[0];
  const clipType =
    (ppro.Constants &&
      ppro.Constants.TrackItemType &&
      ppro.Constants.TrackItemType.CLIP) ??
    1;
  const vt = await seq.getVideoTrack(0);
  const clips = vt ? await vt.getTrackItems(clipType, false) : [];
  return clips && clips.length > 0 ? clips[0] : null;
}

// Collect component + param REFS synchronously under the lock; read
// the async display names afterwards.
function collectComponentRefs(project, chain) {
  const refs = [];
  project.lockedAccess(() => {
    const count = chain.getComponentCount();
    for (let c = 0; c < count; c++) {
      const comp = chain.getComponentAtIndex(c);
      const params = [];
      const pCount = comp.getParamCount();
      for (let p = 0; p < pCount; p++) params.push(comp.getParam(p));
      refs.push({ comp, params });
    }
  });
  return refs;
}

async function runParamProbe() {
  try {
    const { project, seq } = await activeSequence();
    if (!seq) return sendError("No active sequence", "pmap probe");
    const item = await selectedOrFirstClip(seq);
    if (!item) return sendError("No clip found", "pmap probe");
    const chain = await item.getComponentChain();
    const refs = collectComponentRefs(project, chain);

    const report = { clip: String(await item.getName()), components: [] };
    for (const ref of refs) {
      const entry = {
        matchName: String(await ref.comp.getMatchName()),
        displayName: String(await ref.comp.getDisplayName()),
        params: [],
      };
      for (let i = 0; i < ref.params.length; i++) {
        const param = ref.params[i];
        let value = null;
        let timeVarying = null;
        try {
          timeVarying = await param.isTimeVarying();
        } catch (e) {}
        try {
          const kf = await param.getStartValue();
          value = kf?.value?.value ?? kf?.value ?? null;
        } catch (e) {
          value = "unreadable";
        }
        entry.params.push({
          index: i,
          name: String(param.displayName ?? ""),
          value,
          timeVarying,
        });
      }
      report.components.push(entry);
    }
    logLine(
      `probe: ${report.components.length} components on "${report.clip}"`,
    );
    send({ type: "probe", data: report });
  } catch (e) {
    sendError(e, "pmap probe");
  }
}

async function resolvePmapTarget() {
  const { project, seq } = await activeSequence();
  if (!seq) return null;
  const item = await selectedOrFirstClip(seq);
  if (!item) return null;
  const clipKey =
    String(await item.getName()) + "|" + (await item.getTrackIndex());
  if (pmapCache.clipKey === clipKey && pmapCache.param) return pmapCache;

  const chain = await item.getComponentChain();
  const refs = collectComponentRefs(project, chain);
  for (const ref of refs) {
    const matchName = String(await ref.comp.getMatchName());
    if (!/lumetri/i.test(matchName)) continue;
    for (const param of ref.params) {
      if (/exposure/i.test(String(param.displayName ?? ""))) {
        pmapCache = {
          clipKey,
          param,
          paramName: String(param.displayName),
          project,
        };
        logLine(`pmap bound: ${pmapCache.paramName} on ${clipKey}`);
        return pmapCache;
      }
    }
  }
  pmapCache = { clipKey, param: null, paramName: "", project };
  return pmapCache;
}

function queueParamValue(slot, value) {
  if (slot !== 1 || !isFinite(value)) return; // spike: one hardcoded slot
  pmapPendingValue = value;
  if (pmapTimer) return;
  pmapTimer = setTimeout(applyParamValue, 100);
}

async function applyParamValue() {
  pmapTimer = undefined;
  const v = pmapPendingValue;
  pmapPendingValue = undefined;
  if (typeof v === "undefined") return;
  try {
    const target = await resolvePmapTarget();
    if (!target || !target.param) {
      const now = Date.now();
      if (now - pmapLastErrorAt > 3000) {
        pmapLastErrorAt = now;
        sendError(
          "No Lumetri Exposure found - add Lumetri Color to the clip first",
          "pmap",
        );
      }
      return;
    }
    // 0..127 -> Lumetri exposure -7..+7 (UI slider bounds), two decimals.
    const mapped = Math.round(((v / 127) * 14 - 7) * 100) / 100;
    const { param, project } = target;
    let success = false;
    project.lockedAccess(() => {
      success = project.executeTransaction((compound) => {
        const kf = param.createKeyframe(mapped);
        compound.addAction(param.createSetValueAction(kf, true));
      }, "Grid: Exposure");
    });
    if (success) logLine(`exposure -> ${mapped}`);
  } catch (e) {
    const now = Date.now();
    if (now - pmapLastErrorAt > 3000) {
      pmapLastErrorAt = now;
      sendError(e, "pmap");
    }
  }
  // A newer value may have arrived while this one applied.
  if (typeof pmapPendingValue !== "undefined" && !pmapTimer) {
    pmapTimer = setTimeout(applyParamValue, 100);
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

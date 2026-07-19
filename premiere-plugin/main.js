// Premiere-side half of the Grid Premiere Pro package, as a UXP
// plugin. Connects to the Grid Editor package (WebSocket server on
// 127.0.0.1:3543), executes timeline/marker/in-out commands through
// the Premiere UXP DOM, and reports the playhead position and the
// selected clip back for the module-screen readout.
//
// Everything runs in modern JS against `require("premierepro")` - no
// ExtendScript, no eval bridge, no serialized single engine.

const ppro = require("premierepro");

const PLUGIN_VERSION = "1.4.1";
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
    if (command.action === "probe") {
      runParamProbe();
      return;
    }
    if (command.action === "bindings") {
      pmapBindings = command.bindings || {};
      pmapResolveCache = {};
      logLine(`pmap bindings: ${Object.keys(pmapBindings).length} slot(s)`);
      return;
    }
    if (command.action === "learn") {
      startLearn();
      return;
    }
    if (command.action === "learn-cancel") {
      stopLearn();
      return;
    }
    if (command.action === "reset") {
      resetParamValue(Number(command.slot));
      return;
    }
    if ("delta" in command) {
      queueParamDelta(
        Number(command.slot),
        Number(command.delta),
        !!command.clean,
      );
      return;
    }
    queueParamValue(
      Number(command.slot),
      Number(command.value),
      !!command.clean,
    );
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

// --- Parameter mapping -----------------------------------------------
// Grid knobs/faders drive effect parameters on the selected clip.
// Bindings are learned by wiggle: the editor arms learn mode, this
// side snapshots the supported ("blessed") parameters of the selected
// clip and polls for the one the user drags in Premiere's UI; the
// editor then pairs it with the next Grid control that moves, and
// sends the full binding table back down (it also persists it).
//
// The UXP API exposes no parameter min/max, so ranges are hardcoded
// per parameter. Only parameters in this table are learnable - the
// rest have no way to map 0..127 onto a sensible span.
//
// Writes go through createSetValueAction inside a locked transaction.
// There is no transient (undo-free) write path in the API, so each
// commit lands one undo entry - hence the two write modes:
//   live  - coalesced ~10 commits/s: the picture follows the knob,
//           the undo stack fills up (same as Loupedeck/MX Console).
//   clean - the value only streams to the module screen while the
//           knob turns; ONE commit fires after 500ms of quiet.

const PMAP_LIVE_MS = 100; // live-mode coalescing (hardware-proven feel)
const PMAP_CLEAN_QUIET_MS = 500; // clean-mode commit-after-quiet delay
const PMAP_STALE_MS = 2000; // relative mode re-reads the param after this quiet
const LEARN_POLL_MS = 300;
const LEARN_TIMEOUT_MS = 30000;

// Blessed parameter set. comp matches the component matchName OR
// displayName; name matches the param displayName. First index match
// wins, so Lumetri's Basic section (idx 14..24) shadows the identical
// names in Creative/HSL further down the list. Ranges are the UI
// slider bounds (Exposure -7..+7 hardware-verified; Saturation 0..300).
const BLESSED = [
  {
    comp: /^AE\.ADBE Opacity$|^Opacity$/,
    name: /^Opacity$/,
    min: 0,
    max: 100,
    def: 100,
  },
  {
    comp: /^AE\.ADBE Motion$|^Motion$/,
    name: /^Scale$/,
    min: 0,
    max: 200,
    def: 100,
  },
  {
    comp: /^AE\.ADBE Motion$|^Motion$/,
    name: /^Rotation$/,
    min: -180,
    max: 180,
    def: 0,
  },
  // Position is a PointF; each axis is its own learnable entry. During
  // learn the axis with the larger change wins, so scrubbing the X
  // value in Effect Controls binds X only. Frame-normalized 0..1
  // (0.5 = centered); writes replace one axis and keep the other.
  {
    comp: /^AE\.ADBE Motion$|^Motion$/,
    name: /^Position$/,
    axis: 0,
    label: "Position X",
    min: 0,
    max: 1,
    def: 0.5,
  },
  {
    comp: /^AE\.ADBE Motion$|^Motion$/,
    name: /^Position$/,
    axis: 1,
    label: "Position Y",
    min: 0,
    max: 1,
    def: 0.5,
  },
  { comp: /Lumetri/i, name: /^Temperature$/, min: -100, max: 100, def: 0 },
  { comp: /Lumetri/i, name: /^Tint$/, min: -100, max: 100, def: 0 },
  { comp: /Lumetri/i, name: /^Saturation$/, min: 0, max: 300, def: 100 },
  { comp: /Lumetri/i, name: /^Exposure$/, min: -7, max: 7, def: 0 },
  // The five tone sliders run -150..+150 (Contrast hardware-verified).
  { comp: /Lumetri/i, name: /^Contrast$/, min: -150, max: 150, def: 0 },
  { comp: /Lumetri/i, name: /^Highlights$/, min: -150, max: 150, def: 0 },
  { comp: /Lumetri/i, name: /^Shadows$/, min: -150, max: 150, def: 0 },
  { comp: /Lumetri/i, name: /^Whites$/, min: -150, max: 150, def: 0 },
  { comp: /Lumetri/i, name: /^Blacks$/, min: -150, max: 150, def: 0 },
  // Audio volume: not yet hardware-verified - the probe ran on a video
  // clip, so the Level units (dB assumed) are a best guess.
  { comp: /Volume|Audio Levels/i, name: /^Level$/, min: -60, max: 6, def: 0 },
];

// slot(string) -> {compMatch, compName, paramIndex, paramName, min, max, def}
let pmapBindings = {};
// slot -> {clipKey, param, project} resolved param handles
let pmapResolveCache = {};
// slot -> {pending, timer, clean} in-flight write state
let pmapSlotState = {};
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

// Throttled error reporter: fader streams would otherwise flood the
// editor with identical messages.
function pmapError(e, step) {
  const now = Date.now();
  if (now - pmapLastErrorAt > 3000) {
    pmapLastErrorAt = now;
    sendError(e, step);
  }
}

// Trim trailing zeros: 2.35, -100, 0.5, 0.
function formatParamValue(v) {
  return String(Math.round(v * 100) / 100);
}

async function clipKeyOf(item) {
  return String(await item.getName()) + "|" + (await item.getTrackIndex());
}

// Scan a clip's component chain for the blessed params. Returns
// [{comp, param, compMatch, compName, paramIndex, paramName, spec}] -
// one entry per blessed spec at most, first index match wins. A
// multi-axis param (Position) matches several specs and yields one
// entry per axis, all sharing the param handle.
async function scanBlessedParams(project, item) {
  const chain = await item.getComponentChain();
  const refs = collectComponentRefs(project, chain);
  const found = [];
  const claimed = new Set();
  for (const ref of refs) {
    const compMatch = String(await ref.comp.getMatchName());
    const compName = String(await ref.comp.getDisplayName());
    for (let i = 0; i < ref.params.length; i++) {
      const param = ref.params[i];
      const paramName = String(param.displayName ?? "");
      for (let s = 0; s < BLESSED.length; s++) {
        if (claimed.has(s)) continue;
        const spec = BLESSED[s];
        if (!spec.comp.test(compMatch) && !spec.comp.test(compName)) continue;
        if (!spec.name.test(paramName)) continue;
        claimed.add(s);
        found.push({
          comp: ref.comp,
          param,
          compMatch,
          compName,
          paramIndex: i,
          paramName,
          spec,
        });
      }
    }
  }
  return found;
}

// Raw keyframe value: a number for scalars, an [x, y] array for point
// params, null for anything unreadable.
async function readParamRaw(param) {
  try {
    const kf = await param.getStartValue();
    const v = kf?.value?.value ?? kf?.value ?? null;
    if (typeof v === "number") return v;
    if (Array.isArray(v) && v.length >= 2) return [Number(v[0]), Number(v[1])];
    // Some builds may hand back a PointF-like object instead of an
    // array - normalize it so axis math works either way.
    if (v && typeof v.x === "number" && typeof v.y === "number") {
      return [v.x, v.y];
    }
    return null;
  } catch (e) {
    return null;
  }
}

// The value a binding sees: the picked axis of a point, or the scalar.
function bindingValueOf(raw, axis) {
  if (typeof axis === "number") {
    return Array.isArray(raw) ? raw[axis] : null;
  }
  return typeof raw === "number" ? raw : null;
}

// --- Learn by wiggle -------------------------------------------------

let learn = null; // {watch, clipKey, deadline, timer}

function stopLearn() {
  if (learn?.timer) clearTimeout(learn.timer);
  learn = null;
}

async function buildLearnWatch() {
  const { project, seq } = await activeSequence();
  if (!seq) return { error: "No active sequence" };
  const item = await selectedOrFirstClip(seq);
  if (!item) return { error: "No clip selected" };
  const clipKey = await clipKeyOf(item);
  const entries = await scanBlessedParams(project, item);
  if (entries.length === 0) {
    return {
      error:
        "No supported parameters on this clip - supported: Opacity, " +
        "Motion Scale/Rotation/Position, Lumetri Basic, Volume",
    };
  }
  for (const entry of entries) {
    entry.last = bindingValueOf(
      await readParamRaw(entry.param),
      entry.spec.axis,
    );
  }
  return { clipKey, watch: entries };
}

async function startLearn() {
  stopLearn();
  const built = await buildLearnWatch();
  if (built.error) {
    send({ type: "pmap-learn-fail", message: built.error });
    return;
  }
  learn = {
    watch: built.watch,
    clipKey: built.clipKey,
    deadline: Date.now() + LEARN_TIMEOUT_MS,
  };
  logLine(`learn armed: watching ${learn.watch.length} params`);
  learnTick();
}

function learnTick() {
  if (!learn) return;
  learn.timer = setTimeout(async () => {
    if (!learn) return;
    if (Date.now() > learn.deadline) {
      stopLearn();
      send({
        type: "pmap-learn-fail",
        message: "Learn timed out - no parameter moved",
      });
      return;
    }
    try {
      // Follow the selection: re-snapshot when the user clicks another
      // clip mid-learn instead of diffing against the wrong one.
      const { seq } = await activeSequence();
      const item = seq ? await selectedOrFirstClip(seq) : null;
      if (item && (await clipKeyOf(item)) !== learn.clipKey) {
        const built = await buildLearnWatch();
        if (!built.error && learn) {
          learn.watch = built.watch;
          learn.clipKey = built.clipKey;
        }
      } else {
        // Diff every watched entry first, then pick the strongest
        // change relative to its span - a program-monitor drag moves
        // Position X and Y together, and the dominant axis should win.
        let best = null;
        for (const entry of learn.watch) {
          const v = bindingValueOf(
            await readParamRaw(entry.param),
            entry.spec.axis,
          );
          if (v === null || entry.last === null) {
            entry.last = v;
            continue;
          }
          if (v !== entry.last) {
            const span = entry.spec.max - entry.spec.min || 1;
            const strength = Math.abs(v - entry.last) / span;
            if (!best || strength > best.strength) best = { entry, strength };
          }
        }
        if (best) {
          const entry = best.entry;
          const d = {
            compMatch: entry.compMatch,
            compName: entry.compName,
            paramIndex: entry.paramIndex,
            paramName: entry.paramName,
            axis: entry.spec.axis,
            label: entry.spec.label,
            min: entry.spec.min,
            max: entry.spec.max,
            def: entry.spec.def,
          };
          stopLearn();
          logLine(`learn found: ${d.compName} / ${d.label ?? d.paramName}`);
          send({ type: "pmap-learn", param: d });
          return;
        }
      }
    } catch (e) {
      // A transient read failure should not kill the learn session.
      logLine("learn poll: " + String(e?.message ?? e).slice(0, 120));
    }
    learnTick();
  }, LEARN_POLL_MS);
}

// --- Value writes ----------------------------------------------------

// Resolve the bound param on the CURRENT clip. The binding pins the
// component by matchName + param by index (learned), with a name-scan
// fallback in case indices shift across Premiere versions.
async function resolveSlot(slot) {
  const binding = pmapBindings[String(slot)];
  if (!binding) return null;
  const { project, seq } = await activeSequence();
  if (!seq) return null;
  const item = await selectedOrFirstClip(seq);
  if (!item) return null;
  const clipKey = await clipKeyOf(item);
  const cached = pmapResolveCache[slot];
  if (cached && cached.clipKey === clipKey && cached.param) return cached;

  const chain = await item.getComponentChain();
  const refs = collectComponentRefs(project, chain);
  let hit = null;
  for (const ref of refs) {
    const compMatch = String(await ref.comp.getMatchName());
    if (compMatch !== binding.compMatch) continue;
    const byIndex = ref.params[binding.paramIndex];
    if (byIndex && String(byIndex.displayName ?? "") === binding.paramName) {
      hit = byIndex;
    } else {
      hit = ref.params.find(
        (p) => String(p.displayName ?? "") === binding.paramName,
      );
    }
    if (hit) break;
  }
  const resolved = { clipKey, param: hit ?? null, project };
  pmapResolveCache[slot] = resolved;
  if (hit) logLine(`pmap ${slot}: ${binding.paramName} on ${clipKey}`);
  return resolved;
}

function slotState(slot) {
  if (!pmapSlotState[slot]) {
    pmapSlotState[slot] = { pending: undefined, timer: undefined };
  }
  return pmapSlotState[slot];
}

function unmappedError(slot) {
  pmapError(
    `Slot ${slot} is not mapped - use Learn in the package preferences`,
    "pmap",
  );
}

// Common tail of every write path: remember the running value, echo it
// to the module screen, and schedule the commit. The screen follows
// every move in both modes - this is what makes clean mode usable
// (you see the value without commits).
function pushValue(slot, binding, state, value, clean) {
  state.value = value;
  state.touchedAt = Date.now();
  send({
    type: "pmval",
    slot,
    name: binding.label ?? binding.paramName,
    text: formatParamValue(value),
  });
  state.pending = value;
  if (clean) {
    // Debounce: every move pushes the single commit further out.
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => applySlot(slot), PMAP_CLEAN_QUIET_MS);
  } else {
    // Coalesce: at most one commit per window, trailing value wins.
    if (state.timer) return;
    state.timer = setTimeout(() => applySlot(slot), PMAP_LIVE_MS);
  }
}

// Absolute mode (faders): knob position 0..127 maps onto the range.
// 7-bit resolution - fine for a fader whose physical position should
// BE the value, too coarse for detented endless knobs (use deltas).
function queueParamValue(slot, value, clean) {
  if (!isFinite(slot) || !isFinite(value)) return;
  const binding = pmapBindings[String(slot)];
  if (!binding) return unmappedError(slot);
  const span = binding.max - binding.min;
  const mapped = Math.round((binding.min + (value / 127) * span) * 100) / 100;
  pushValue(slot, binding, slotState(slot), mapped, clean);
}

// Relative mode (endless knobs): each detent nudges the current value
// by the block's step size (already multiplied in module-side, so the
// wire carries value units). The running value seeds from the param
// itself and re-syncs after PMAP_STALE_MS of quiet, so Premiere-side
// edits (mouse drags, undo) between twists are picked up instead of
// snapped back.
async function queueParamDelta(slot, delta, clean) {
  if (!isFinite(slot) || !isFinite(delta) || delta === 0) return;
  const binding = pmapBindings[String(slot)];
  if (!binding) return unmappedError(slot);
  const state = slotState(slot);
  state.accum = (state.accum ?? 0) + delta;
  state.clean = clean;
  if (state.syncing) return; // deltas keep accumulating meanwhile

  const stale =
    typeof state.value !== "number" ||
    Date.now() - (state.touchedAt ?? 0) > PMAP_STALE_MS;
  if (stale) {
    state.syncing = true;
    let current = null;
    try {
      const target = await resolveSlot(slot);
      if (target?.param) {
        current = bindingValueOf(
          await readParamRaw(target.param),
          binding.axis,
        );
      }
    } catch (e) {
      /* fall back to the default below */
    }
    state.syncing = false;
    state.value = typeof current === "number" ? current : binding.def;
  }

  if (!state.accum) return;
  const next = Math.min(
    binding.max,
    Math.max(binding.min, state.value + state.accum),
  );
  state.accum = 0;
  pushValue(slot, binding, state, Math.round(next * 1000) / 1000, state.clean);
}

async function resetParamValue(slot) {
  const binding = pmapBindings[String(slot)];
  if (!binding) return;
  const state = slotState(slot);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  state.accum = 0;
  state.value = binding.def;
  state.touchedAt = Date.now();
  state.pending = binding.def;
  send({
    type: "pmval",
    slot,
    name: binding.label ?? binding.paramName,
    text: formatParamValue(binding.def),
  });
  await applySlot(slot);
}

// Best-effort PointF construction: the UXP surface for point values
// is undocumented, so try the likely shapes and let the keyframe call
// surface a step-tagged error if none fit this Premiere build.
function makePoint(x, y) {
  if (ppro.PointF) {
    try {
      if (typeof ppro.PointF.create === "function") {
        return ppro.PointF.create(x, y);
      }
    } catch (e) {}
    try {
      return new ppro.PointF(x, y);
    } catch (e) {}
  }
  return [x, y];
}

async function applySlot(slot) {
  const state = slotState(slot);
  state.timer = undefined;
  const v = state.pending;
  state.pending = undefined;
  if (typeof v === "undefined") return;
  const binding = pmapBindings[String(slot)];
  if (!binding) return;
  const shownName = binding.label ?? binding.paramName;
  try {
    const target = await resolveSlot(slot);
    if (!target || !target.param) {
      pmapError(
        `${shownName}: no matching effect on the selected clip`,
        "pmap",
      );
      return;
    }
    const { param, project } = target;

    // Axis bindings write a full point with only their axis replaced,
    // so Position X leaves Y exactly where it was (and vice versa).
    let keyframeValue = v;
    if (typeof binding.axis === "number") {
      const raw = await readParamRaw(param);
      const point = Array.isArray(raw) ? [...raw] : [0.5, 0.5];
      point[binding.axis] = v;
      keyframeValue = makePoint(point[0], point[1]);
    }

    let success = false;
    project.lockedAccess(() => {
      success = project.executeTransaction((compound) => {
        const kf = param.createKeyframe(keyframeValue);
        compound.addAction(param.createSetValueAction(kf, true));
      }, `Grid: ${shownName}`);
    });
    if (success) logLine(`${shownName} -> ${formatParamValue(v)}`);
  } catch (e) {
    // A stale cached param handle (deleted effect) throws here; drop
    // the cache so the next move re-resolves.
    delete pmapResolveCache[slot];
    pmapError(e, "pmap");
  }
  // A newer value may have arrived while this one applied.
  if (typeof state.pending !== "undefined" && !state.timer) {
    state.timer = setTimeout(() => applySlot(slot), PMAP_LIVE_MS);
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

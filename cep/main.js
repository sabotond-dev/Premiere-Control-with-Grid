// Panel-side bridge. CEP panels have Node integration, so this connects
// as a TCP client to the Grid Editor package (the server on
// 127.0.0.1:23120), reads newline-delimited JSON commands, and runs the
// matching ExtendScript host function inside Premiere.

var BRIDGE_HOST = "127.0.0.1";
var BRIDGE_PORT = 23120;
var RECONNECT_MS = 2000;

var cs = new CSInterface();
var net = null;
try {
  net = require("net");
} catch (e) {
  net = null;
}

var socket = null;
var connected = false;
var buffer = "";
var hostLoaded = false;

// CEP 12 does not reliably auto-load the manifest ScriptPath into the
// ExtendScript engine, which surfaces as "EvalScript error." on every
// call. Load host.jsx explicitly and probe until it answers.
// Load host.jsx by evaluating its SOURCE, read via Node - not
// $.evalFile. A parse error in the file then surfaces here directly,
// instead of silently leaving stale definitions from an earlier load
// in Premiere's persistent ExtendScript engine.
// cs.getSystemPath can return a file:///C:/... URL (CEP 12); Node's
// fs needs a plain filesystem path.
function extensionDir() {
  var p = cs.getSystemPath(SystemPath.EXTENSION);
  p = decodeURIComponent(String(p).replace(/^file:\/{2,3}/, ""));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

function loadHost() {
  var source = null;
  try {
    source = require("fs").readFileSync(extensionDir() + "/host.jsx", "utf8");
  } catch (e) {
    logLine("cannot read host.jsx: " + e);
    setTimeout(loadHost, 3000);
    return;
  }
  cs.evalScript(source, function (evalResult) {
    if (evalResult === "EvalScript error.") {
      logLine("host.jsx failed to evaluate (parse error?)");
      send({ type: "diag-panel", stage: "eval-source", result: "error" });
    }
    // Probe for the NEWEST function, not just any function, so a stale
    // engine can never pass as loaded.
    cs.evalScript(
      "typeof gridTimeline + '/' + typeof gridPlayhead",
      function (result) {
        send({ type: "diag-panel", stage: "probe", result: String(result) });
        if (result === "function/function") {
          hostLoaded = true;
          logLine("host loaded");
          // One raw self-test so failures are visible end to end.
          cs.evalScript("gridPlayhead()", function (r) {
            send({
              type: "diag-panel",
              stage: "selftest",
              result: String(r).slice(0, 300)
            });
          });
          pump();
        } else {
          logLine("host not loaded yet (" + result + "), retrying");
          setTimeout(loadHost, 1500);
        }
      }
    );
  });
}

function setStatus(text, on) {
  var dot = document.getElementById("dot");
  var label = document.getElementById("status");
  if (dot) dot.className = "dot " + (on ? "on" : "off");
  if (label) label.textContent = text;
}

function logLine(text) {
  var el = document.getElementById("log");
  if (!el) return;
  var now = new Date();
  var stamp =
    ("0" + now.getHours()).slice(-2) +
    ":" +
    ("0" + now.getMinutes()).slice(-2) +
    ":" +
    ("0" + now.getSeconds()).slice(-2);
  el.textContent = stamp + "  " + text + "\n" + el.textContent;
  // Keep the log from growing without bound.
  if (el.textContent.length > 4000) {
    el.textContent = el.textContent.slice(0, 4000);
  }
}

// --- Serialized eval queue -------------------------------------------
// A fast knob twist produces dozens of events; firing an evalScript per
// event floods Premiere's single ExtendScript engine and it starts
// answering "EvalScript error.". Instead: only one eval is ever in
// flight, timeline deltas accumulate while busy and flush as one jump,
// and discrete commands (markers, in/out) queue in order.

var evalBusy = false;
var pendingDelta = 0;
var pendingCommands = [];
var lastHostReload = 0;

// --- Timing stats ----------------------------------------------------
// Where do jog milliseconds go? Measured per eval: how long the delta
// waited in the queue (engine busy) and how long the eval itself took.
// Aggregates are sent to the editor every few seconds when there was
// activity; the editor appends them to a local log file.
var stats = null;

function statsReset() {
  stats = {
    jogN: 0, jogEvalMs: 0, jogEvalMax: 0, jogWaitMs: 0, jogWaitMax: 0,
    pollN: 0, pollEvalMs: 0, pollEvalMax: 0
  };
}
statsReset();

var firstPendingAt = 0; // when the oldest un-evaled jog delta arrived

function statsJog(waitMs, evalMs) {
  stats.jogN++;
  stats.jogEvalMs += evalMs;
  stats.jogWaitMs += waitMs;
  if (evalMs > stats.jogEvalMax) stats.jogEvalMax = evalMs;
  if (waitMs > stats.jogWaitMax) stats.jogWaitMax = waitMs;
}

setInterval(function () {
  if (stats.jogN === 0 && stats.pollN === 0) return;
  send({
    type: "stats",
    jogN: stats.jogN,
    jogEvalAvg: stats.jogN ? Math.round(stats.jogEvalMs / stats.jogN) : 0,
    jogEvalMax: stats.jogEvalMax,
    jogWaitAvg: stats.jogN ? Math.round(stats.jogWaitMs / stats.jogN) : 0,
    jogWaitMax: stats.jogWaitMax,
    pollN: stats.pollN,
    pollEvalAvg: stats.pollN ? Math.round(stats.pollEvalMs / stats.pollN) : 0,
    pollEvalMax: stats.pollEvalMax
  });
  statsReset();
}, 3000);

function pump() {
  if (evalBusy || !hostLoaded) return;

  var script = null;
  var isJog = false;
  if (pendingDelta !== 0) {
    var d = pendingDelta;
    pendingDelta = 0;
    // Clamp a runaway accumulation to something sane per jump.
    if (d > 2000) d = 2000;
    if (d < -2000) d = -2000;
    script = "gridTimeline(" + d + ")";
    isJog = true;
  } else if (pendingCommands.length > 0) {
    script = pendingCommands.shift();
  } else {
    return;
  }

  var waitMs = isJog && firstPendingAt ? Date.now() - firstPendingAt : 0;
  if (isJog) firstPendingAt = 0;
  var evalStart = Date.now();

  evalBusy = true;
  cs.evalScript(script, function (result) {
    evalBusy = false;
    if (isJog) statsJog(waitMs, Date.now() - evalStart);
    handleResult(script, result);
    // More may have accumulated while we were busy.
    pump();
  });
}

// The host either lost our functions or the engine hiccuped.
// Reload host.jsx (throttled) so one bad stretch logs once.
function hostLost(script) {
  var now = Date.now();
  if (now - lastHostReload > 3000) {
    lastHostReload = now;
    hostLoaded = false;
    logLine("host lost, reloading (" + script + ")");
    loadHost();
  }
}

function handleResult(script, result) {
  if (result === "EvalScript error.") {
    hostLost(script);
    return;
  }
  try {
    var parsed = JSON.parse(result);
    if (parsed.ok === false) {
      logLine("error: " + (parsed.message || "unknown"));
      send({ type: "error", message: parsed.message || "unknown" });
    } else if (parsed.ticks && parsed.tpf) {
      // A timeline jog just moved the playhead; report it right away
      // so the module screen tracks the knob without poll latency.
      reportPlayhead(parsed.ticks, parsed.tpf);
    }
  } catch (e) {
    logLine("odd result: " + String(result).slice(0, 80));
  }
}

// --- Playhead readout ------------------------------------------------
// Premiere has no push event for playhead movement in CEP, so poll it
// whenever the eval queue is idle. Deduped here, so the editor only
// hears about actual changes; scrubbing and playback both surface as a
// stream of position reports.

// Polling is adaptive: while the playhead is static, polls are rare so
// the ExtendScript engine is almost always free when a jog starts (an
// in-flight poll would make the first detent wait a full eval
// round-trip). Once movement is seen (playback, mouse scrub), polling
// tightens to follow it.
var POLL_IDLE_MS = 1000;
var POLL_ACTIVE_MS = 250;
var JOG_QUIET_MS = 800;
var lastPlayheadKey = null;
var lastJogAt = 0;
var pollMoving = false;
var readoutEnabled = true;

function reportPlayhead(ticks, tpf) {
  if (!readoutEnabled) return;
  var key = String(ticks) + "/" + String(tpf);
  if (key === lastPlayheadKey) return;
  lastPlayheadKey = key;
  send({ type: "playhead", ticks: String(ticks), tpf: Number(tpf) });
}

function reportNoSequence() {
  if (lastPlayheadKey === "none") return;
  lastPlayheadKey = "none";
  send({ type: "playhead", none: true });
}

function pollPlayhead() {
  if (!readoutEnabled) return;
  if (!connected || !hostLoaded || evalBusy) return;
  // Commands and jog deltas always win; the poll takes the leftovers.
  if (pendingDelta !== 0 || pendingCommands.length > 0) return;
  // Stay off the (single) ExtendScript engine while the user is
  // jogging: a poll in flight would make the next jog delta wait a
  // full eval round-trip, which reads as knob lag. Jog evals report
  // the playhead themselves, so nothing is lost.
  if (Date.now() - lastJogAt < JOG_QUIET_MS) return;
  var evalStart = Date.now();
  evalBusy = true;
  cs.evalScript("gridPlayhead()", function (result) {
    evalBusy = false;
    var dur = Date.now() - evalStart;
    stats.pollN++;
    stats.pollEvalMs += dur;
    if (dur > stats.pollEvalMax) stats.pollEvalMax = dur;
    if (result === "EvalScript error.") {
      hostLost("gridPlayhead()");
    } else {
      try {
        var parsed = JSON.parse(result);
        if (parsed.ok && parsed.none) {
          pollMoving = false;
          reportNoSequence();
        } else if (parsed.ok && parsed.ticks) {
          var prevKey = lastPlayheadKey;
          reportPlayhead(parsed.ticks, parsed.tpf);
          pollMoving = lastPlayheadKey !== prevKey;
        }
      } catch (e) {
        /* odd poll answers are not worth logging */
      }
    }
    pump();
  });
}

function pollTick() {
  pollPlayhead();
  setTimeout(pollTick, pollMoving ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}

setTimeout(pollTick, POLL_IDLE_MS);

// Run one command from the editor against the host.
function dispatch(command) {
  if (!command || !command.cmd) return;

  if (command.cmd === "readout") {
    // Editor-controlled master switch: disabled = zero polls, zero
    // reports - the exact pre-readout panel behavior.
    readoutEnabled = !!command.enabled;
    lastPlayheadKey = null;
    logLine("readout " + (readoutEnabled ? "on" : "off"));
    return;
  }

  if (command.cmd === "timeline") {
    var d = Number(command.delta);
    if (!isFinite(d) || d === 0) return;
    lastJogAt = Date.now();
    if (pendingDelta === 0) firstPendingAt = Date.now();
    pendingDelta += d;
  } else if (command.cmd === "marker") {
    pendingCommands.push('gridMarker("' + String(command.action || "add") + '")');
  } else if (command.cmd === "inout") {
    pendingCommands.push('gridInOut("' + String(command.action || "in") + '")');
  } else {
    return;
  }
  pump();
}

function send(obj) {
  if (socket && connected) {
    try {
      socket.write(JSON.stringify(obj) + "\n");
    } catch (e) {}
  }
}

function connect() {
  if (!net) {
    setStatus("Node unavailable in this CEP host", false);
    return;
  }
  cleanup();

  socket = new net.Socket();
  socket.setEncoding("utf-8");

  socket.connect(BRIDGE_PORT, BRIDGE_HOST, function () {
    connected = true;
    // Re-send the playhead on a fresh connection: a restarted editor
    // has no idea where the timeline is until something changes.
    lastPlayheadKey = null;
    setStatus("Connected to Grid Editor", true);
    logLine("connected");
  });

  socket.on("data", function (chunk) {
    buffer += chunk;
    var idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      var line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line === "") continue;
      try {
        dispatch(JSON.parse(line));
      } catch (e) {
        logLine("bad command: " + line);
      }
    }
  });

  socket.on("error", function () {
    /* handled by close */
  });

  socket.on("close", function () {
    connected = false;
    setStatus("Waiting for Grid Editor…", false);
    setTimeout(connect, RECONNECT_MS);
  });
}

function cleanup() {
  if (socket) {
    try {
      socket.destroy();
    } catch (e) {}
    socket = null;
  }
  connected = false;
  buffer = "";
}

setStatus("Waiting for Grid Editor…", false);
loadHost();
connect();

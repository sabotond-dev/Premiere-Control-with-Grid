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
function loadHost() {
  var extPath = cs.getSystemPath(SystemPath.EXTENSION);
  var jsxPath = (extPath + "/host.jsx").replace(/\\/g, "/");
  cs.evalScript('$.evalFile("' + jsxPath + '")', function () {
    cs.evalScript("typeof gridTimeline", function (result) {
      if (result === "function") {
        hostLoaded = true;
        logLine("host loaded");
        pump();
      } else {
        logLine("host not loaded yet (" + result + "), retrying");
        setTimeout(loadHost, 1500);
      }
    });
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

function pump() {
  if (evalBusy || !hostLoaded) return;

  var script = null;
  if (pendingDelta !== 0) {
    var d = pendingDelta;
    pendingDelta = 0;
    // Clamp a runaway accumulation to something sane per jump.
    if (d > 2000) d = 2000;
    if (d < -2000) d = -2000;
    script = "gridTimeline(" + d + ")";
  } else if (pendingCommands.length > 0) {
    script = pendingCommands.shift();
  } else {
    return;
  }

  evalBusy = true;
  cs.evalScript(script, function (result) {
    evalBusy = false;
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

var POLL_MS = 200;
var lastPlayheadKey = null;

function reportPlayhead(ticks, tpf) {
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
  if (!connected || !hostLoaded || evalBusy) return;
  // Commands and jog deltas always win; the poll takes the leftovers.
  if (pendingDelta !== 0 || pendingCommands.length > 0) return;
  evalBusy = true;
  cs.evalScript("gridPlayhead()", function (result) {
    evalBusy = false;
    if (result === "EvalScript error.") {
      hostLost("gridPlayhead()");
    } else {
      try {
        var parsed = JSON.parse(result);
        if (parsed.ok && parsed.none) {
          reportNoSequence();
        } else if (parsed.ok && parsed.ticks) {
          reportPlayhead(parsed.ticks, parsed.tpf);
        }
      } catch (e) {
        /* odd poll answers are not worth logging every 200ms */
      }
    }
    pump();
  });
}

setInterval(pollPlayhead, POLL_MS);

// Run one command from the editor against the host.
function dispatch(command) {
  if (!command || !command.cmd) return;

  if (command.cmd === "timeline") {
    var d = Number(command.delta);
    if (!isFinite(d) || d === 0) return;
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

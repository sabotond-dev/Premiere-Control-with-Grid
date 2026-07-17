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

// Run one command from the editor against the host.
function dispatch(command) {
  if (!command || !command.cmd) return;

  var script = null;
  if (command.cmd === "timeline") {
    script = "gridTimeline(" + Number(command.delta || 0) + ")";
  } else if (command.cmd === "marker") {
    script = 'gridMarker("' + String(command.action || "add") + '")';
  } else if (command.cmd === "inout") {
    script = 'gridInOut("' + String(command.action || "in") + '")';
  }
  if (script === null) return;

  cs.evalScript(script, function (result) {
    var ok = true;
    var message = "";
    try {
      var parsed = JSON.parse(result);
      ok = parsed.ok !== false;
      message = parsed.message || "";
    } catch (e) {
      ok = false;
      message = result;
    }
    if (!ok) {
      logLine("error: " + message);
      send({ type: "error", message: message });
    }
  });
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
connect();

// ExtendScript host for the Grid Control Premiere panel. Everything
// here runs inside Premiere and drives the timeline through the native
// scripting DOM — no keyboard emulation. Each function returns a JSON
// string so the panel can surface errors to the Grid Editor.

// 254,016,000,000 ticks per second is Premiere's fixed tick rate.
var TICKS_PER_SECOND = 254016000000;

// Premiere's ExtendScript engine ships WITHOUT a JSON object, so
// results are serialized by hand. Payloads are flat objects of
// numbers, booleans and strings - nothing nested.
function _esc(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function _val(v) {
  if (typeof v === "number" && isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return '"' + _esc(v) + '"';
}

function _json(obj) {
  var parts = [];
  for (var k in obj) parts.push('"' + k + '":' + _val(obj[k]));
  return "{" + parts.join(",") + "}";
}

function _ok(extra) {
  var o = { ok: true };
  if (extra) {
    for (var k in extra) o[k] = extra[k];
  }
  return _json(o);
}

function _err(message) {
  return _json({ ok: false, message: String(message) });
}

function _seq() {
  if (!app.project || !app.project.activeSequence) {
    return null;
  }
  return app.project.activeSequence;
}

// Move the playhead by a signed number of frames. The frame duration
// comes from the sequence timebase (ticks per frame), so the result is
// frame-accurate regardless of the sequence frame rate.
function gridTimeline(frames) {
  try {
    var seq = _seq();
    if (!seq) return _err("No active sequence");

    var ticksPerFrame = parseFloat(seq.timebase);
    if (!ticksPerFrame || ticksPerFrame <= 0) {
      return _err("Bad sequence timebase");
    }

    var pos = seq.getPlayerPosition();
    var current = parseFloat(pos.ticks);
    var next = current + frames * ticksPerFrame;
    if (next < 0) next = 0;

    // Convert the double back to an integer tick string. Returning the
    // timebase too lets the panel report the new playhead immediately,
    // without waiting for the next poll.
    var ticksString = next.toFixed(0);
    seq.setPlayerPosition(ticksString);
    return _ok({ ticks: ticksString, tpf: ticksPerFrame });
  } catch (e) {
    return _err(e.toString());
  }
}

// Read the playhead for the module-screen readout. Answers ok with
// none:true when no sequence is open, so the panel's poll loop stays
// quiet instead of raising errors at the editor.
// NB: this file must stay strictly ES3 - a single trailing comma in an
// object literal makes $.evalFile reject the WHOLE file while older
// definitions silently remain in the engine.
function gridPlayhead() {
  try {
    var seq = _seq();
    if (!seq) return _ok({ none: true });
    var tpf = parseFloat(seq.timebase);
    if (!tpf || tpf <= 0) return _ok({ none: true });
    return _ok({ ticks: String(seq.getPlayerPosition().ticks), tpf: tpf });
  } catch (e) {
    return _err(e.toString());
  }
}

function _playheadSeconds(seq) {
  return parseFloat(seq.getPlayerPosition().ticks) / TICKS_PER_SECOND;
}

function gridMarker(action) {
  try {
    var seq = _seq();
    if (!seq) return _err("No active sequence");
    var markers = seq.markers;

    if (action === "add") {
      markers.createMarker(_playheadSeconds(seq));
      return _ok();
    }

    // Collect marker start times (seconds) in order.
    var times = [];
    var m = markers.getFirstMarker();
    while (m) {
      times.push(m.start.seconds);
      m = markers.getNextMarker(m);
    }
    if (times.length === 0) return _ok({ note: "no markers" });

    var here = _playheadSeconds(seq);
    var target = null;
    var EPS = 0.0005;

    if (action === "next") {
      for (var i = 0; i < times.length; i++) {
        if (times[i] > here + EPS) {
          target = times[i];
          break;
        }
      }
    } else if (action === "prev") {
      for (var j = times.length - 1; j >= 0; j--) {
        if (times[j] < here - EPS) {
          target = times[j];
          break;
        }
      }
    }

    if (target === null) return _ok({ note: "no marker in that direction" });
    seq.setPlayerPosition(Math.round(target * TICKS_PER_SECOND).toFixed(0));
    return _ok();
  } catch (e) {
    return _err(e.toString());
  }
}

function gridInOut(action) {
  try {
    var seq = _seq();
    if (!seq) return _err("No active sequence");
    var here = _playheadSeconds(seq);

    if (action === "in") {
      seq.setInPoint(here);
      return _ok();
    }
    if (action === "out") {
      seq.setOutPoint(here);
      return _ok();
    }
    if (action === "clear") {
      // Not every version exposes clearIn/OutPoint; fall back to
      // collapsing the range to the sequence start.
      try {
        seq.clearInPoint();
        seq.clearOutPoint();
      } catch (inner) {
        seq.setInPoint(0);
        seq.setOutPoint(0);
      }
      return _ok();
    }
    return _err("Unknown in/out action: " + action);
  } catch (e) {
    return _err(e.toString());
  }
}

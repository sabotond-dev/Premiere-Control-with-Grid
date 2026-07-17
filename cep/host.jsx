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

// Locate which track a selected trackItem lives on ("V1", "A2"...).
// Scans the sequence's clips, so callers cache by selection identity.
function _trackLabel(seq, item) {
  var mt = "";
  try {
    mt = String(item.mediaType);
  } catch (e) {}
  var i, j, tr;
  if (mt !== "Audio") {
    for (i = 0; i < seq.videoTracks.numTracks; i++) {
      tr = seq.videoTracks[i];
      for (j = 0; j < tr.clips.numItems; j++) {
        if (
          tr.clips[j].name === item.name &&
          String(tr.clips[j].start.ticks) === String(item.start.ticks)
        ) {
          return "V" + (i + 1);
        }
      }
    }
  }
  if (mt !== "Video") {
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
      tr = seq.audioTracks[i];
      for (j = 0; j < tr.clips.numItems; j++) {
        if (
          tr.clips[j].name === item.name &&
          String(tr.clips[j].start.ticks) === String(item.start.ticks)
        ) {
          return "A" + (i + 1);
        }
      }
    }
  }
  return "?";
}

var _selCacheKey = null;
var _selCacheName = "";
var _selCacheTrack = "";

// Read the playhead (and the selected clip, if any) for the
// module-screen readout. Answers ok with none:true when no sequence is
// open, so the panel's poll loop stays quiet instead of raising errors
// at the editor. The clip-track scan runs only when the selection
// changes; unchanged selections reuse the cached label.
// NB: this file must stay strictly ES3 - a single trailing comma in an
// object literal makes the WHOLE file fail to evaluate - and must not
// touch JSON, which does not exist in Premiere's engine.
function gridPlayhead() {
  try {
    var seq = _seq();
    if (!seq) return _ok({ none: true });
    var tpf = parseFloat(seq.timebase);
    if (!tpf || tpf <= 0) return _ok({ none: true });

    var payload = { ticks: String(seq.getPlayerPosition().ticks), tpf: tpf };

    try {
      var sel = seq.getSelection();
      if (sel && sel.length > 0 && sel[0] && sel[0].name) {
        var key = sel[0].name + "|" + String(sel[0].start.ticks);
        if (key !== _selCacheKey) {
          _selCacheKey = key;
          _selCacheName = String(sel[0].name);
          _selCacheTrack = _trackLabel(seq, sel[0]);
        }
        payload.clip = _selCacheName;
        payload.trk = _selCacheTrack;
      } else {
        _selCacheKey = null;
      }
    } catch (eSel) {
      /* selection API unavailable: playhead still reports */
    }

    return _ok(payload);
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

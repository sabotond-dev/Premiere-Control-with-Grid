# package-premiere-pro

Control Adobe Premiere Pro from Grid modules. Jog the timeline with an
endless knob, drop and jump between markers, and set in/out points —
all through Premiere's native scripting API, with no keyboard shortcuts
or key emulation.

Built in the shape of the official Grid packages (Lightroom Classic,
Photoshop): an editor-side Node package that registers the action
blocks and a companion extension inside the host app. Here the host
half is a Premiere **CEP extension** instead of a Lightroom plugin.

## Architecture

```
Grid module ──gps()──▶ Grid Editor ──TCP 127.0.0.1:23120──▶ Premiere CEP panel ──ExtendScript──▶ active sequence
             (serial)   (this package,                        (cep/, the panel)
                         index.js: TCP server)

VSN1 screen ◀──Lua──── Grid Editor ◀──TCP (same socket)──── Premiere CEP panel ◀──poll──── playhead
             (immediate  (execute-lua-script)                 (gridPlayhead, 200 ms
              script)                                          when the queue is idle)
```

- **index.js** — runs in the editor's package-manager process. Registers
  the actions, receives their `gps("package-premiere-pro", …)` calls,
  and forwards them as JSON commands to the panel over a local socket.
  The editor is the **server**; the panel connects to it.
- **components/dist/components.js** — the action + preference UIs, plain
  custom elements (no build step).
- **cep/** — the Premiere panel. Connects to the editor, runs the
  matching `host.jsx` function in Premiere. See `cep/README.md` to
  install.

## Action blocks

| Block             | Best on           | What it does                              |
| ----------------- | ----------------- | ----------------------------------------- |
| Timeline Navigate | endless knob      | Jog the playhead N frames per detent      |
| Marker            | button            | Add marker, or jump to next / previous    |
| In / Out Point    | button            | Set in / out at playhead, or clear        |

## Playhead readout (VSN1 screen)

The channel also runs backwards: the panel polls the playhead
(`getPlayerPosition`, every 200 ms while the command queue is idle and
the knob is untouched, plus instantly after every jog) and reports
changes over the same socket. The package converts ticks to
`hh:mm:ss:ff` and keeps the module Lua global `pptc` fresh with a tiny
immediate script (`pptc='00:01:23:12'`, throttled to ~10/s).

Drawing happens on the module, via the **Timecode Display** action
block: add it to the screen element's **Draw** event on a VSN1. This is
deliberate - the profile's own draw loop repaints the screen every draw
trigger (~25 ms), so anything painted from outside the draw event is
overwritten before it is ever visible. Inside the draw event the block
coexists with the profile: it repaints only when the timecode changes
and swaps its own frame.

Details worth knowing:

- The block shows `--:--:--:--` while Premiere or the panel is closed
  (`pptc` is nil'd on disconnect).
- Want a custom layout? Skip the block and use `pptc` directly in your
  own draw-event Lua, e.g. a Screen Text block with the expression
  `=pptc or '--'`.
- The preference panel toggle ("Send playhead timecode to modules")
  stops the `pptc` stream entirely; it persists across restarts.
- Timecode is non-drop-frame. On 29.97/59.94 drop-frame sequences the
  frames field can differ slightly from Premiere's display.
- The readout stays out of scrubbing's way twice over: panel-side,
  playhead polls pause for 400 ms after each jog delta (jog evals
  report the position themselves); editor-side, pptc updates are held
  while jog events stream, because every update makes the display
  block repaint a full frame on the module being turned. The screen
  freezes during a twist and catches up ~300 ms after it stops.

## Install (editor side)

During development, add this folder as a local package from the Grid
Editor's package manager (the packages icon in the left rail). For
release it installs from a GitHub release like the other packages.

## Why it is safe

- **No firmware or protocol change.** The module only calls `gps`, the
  existing package-message primitive.
- **Local only.** The editor and the panel talk over `127.0.0.1`; the
  socket refuses anything off-machine.
- **Native, not emulated.** Timeline moves use `setPlayerPosition`, not
  simulated arrow keys, so they are frame-accurate and never leak
  keystrokes to the wrong window.
- **Degrades quietly.** With Premiere closed or the panel shut, commands
  are dropped — pressing a button simply does nothing.

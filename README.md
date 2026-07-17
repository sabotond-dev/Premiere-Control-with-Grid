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

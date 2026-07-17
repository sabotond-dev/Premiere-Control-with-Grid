# package-premiere-pro

Control Adobe Premiere Pro from Grid modules. Jog the timeline with an
endless knob, drop and jump between markers, set in/out points — and
see the playhead position plus the selected clip on a VSN1 module
screen. Everything runs through Premiere's native UXP API, with no
keyboard shortcuts or key emulation.

Built in the shape of the official Grid packages (Photoshop,
Lightroom Classic): an editor-side Node package that registers the
action blocks, and a companion **UXP plugin** inside Premiere
(requires Premiere Pro 25.6 or newer).

## Architecture

```
Grid module ──gps()──▶ Grid Editor ──ws://127.0.0.1:3543──▶ Premiere UXP plugin ──ppro API──▶ active sequence
             (serial)   (this package,                       (premiere-plugin/)
                         index.js: WebSocket server)

VSN1 screen ◀──Lua──── Grid Editor ◀──same WebSocket──────── playhead + selected clip
             (pptc/ppcn/ppct globals   (adaptive polling, instant
              + Premiere Display block) after each jog)
```

- **index.js** — runs in the editor's package-manager process.
  Registers the actions, receives their
  `gps("package-premiere-pro", …)` calls, and forwards them as JSON
  commands to the plugin over a local WebSocket (`ws` package, same
  pattern as package-photoshop). The editor is the **server**; the
  plugin connects to it.
- **components/dist/components.js** — the action + preference UIs,
  plain custom elements (no build step).
- **premiere-plugin/** — the UXP plugin. Vanilla JS, no build step;
  `manifest.json` + `index.html` + `main.js`. Ships as a `.ccx`
  installer built by `build-ccx.js`.

## Action blocks

| Block             | Best on      | What it does                           |
| ----------------- | ------------ | -------------------------------------- |
| Timeline Navigate | endless knob | Jog the playhead N frames per detent   |
| Marker            | button       | Add marker, or jump to next / previous |
| In / Out Point    | button       | Set in / out at playhead, or clear     |
| Premiere Display  | VSN1 screen  | Playhead + selected clip status screen |

## Install (user)

1. Install this package in the Grid Editor's package manager.
2. In the package's preference panel, click **Open plugin folder** and
   double-click `c8e52a9b_PPRO.ccx` — Creative Cloud installs the Grid
   Control plugin into Premiere.
3. In Premiere, open the **Grid Control** panel and keep it open.
4. Optional: on a VSN1, add the **Premiere Display** block to the
   screen element's **Draw** event to see the playhead timecode, the
   selected clip's name and its channel.

## Playhead + clip readout (VSN1 screen)

The plugin polls the playhead and the timeline selection (adaptively:
once a second while static, 250 ms while moving, instantly after each
jog) and reports changes over the socket. The package converts ticks
to `hh:mm:ss:ff` and keeps three module Lua globals fresh with tiny
immediate scripts:

- `pptc` — playhead timecode (non-drop-frame)
- `ppcn` — selected clip's filename (fitted for the module font,
  21-char ellipsis truncation, accents mapped to base letters)
- `ppct` — selected clip's channel ("Video 1", "Audio 2"...)

The **Premiere Display** block draws them from INSIDE the screen's
draw event — anything painted from outside is overwritten by the
profile's own draw loop within one draw trigger (~25 ms). The block
repaints only when a value changes.

Knob feel is protected on both sides: the plugin's polls pause for
800 ms around jog activity, and the editor holds screen updates while
jog events stream (each update repaints a full frame on the very
module whose encoder is being turned). The screen catches up the
moment the twist stops.

Note: clip info follows the **selected** clip (click it in the
timeline) — Adobe exposes no mouse-hover API to plugins.

## Development

- `npm i` then `npm run build` (builds the `.ccx`).
- Add the repo root as a local package in the Grid Editor's package
  manager (`+ Add external package`).
- For plugin iteration, load `premiere-plugin/` unpacked with the
  Adobe UXP Developer Tool instead of reinstalling the ccx.
- Editor-side changes: **Force Restart** in the package manager.
  Component changes: restart the editor frontend.
- `GRID_PP_BRIDGE_PORT` overrides the WebSocket port (used by tests so
  they can run beside a live editor).

## Release

Pushing to `main` triggers `.github/workflows/main.yml` (same pipeline
as the official packages): it creates a GitHub release named after
`package.json`'s `version` and attaches `package-archive.zip` per OS,
built by `build.js` (runtime files + `node_modules` + components +
the `.ccx`). The Grid Editor detects newer releases and offers the
update. Bump `version` before pushing a release-worthy main.

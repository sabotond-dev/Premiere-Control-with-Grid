# package-premiere-pro

Control Adobe Premiere Pro from Grid modules. Jog the timeline with an
endless knob, drop and jump between markers, set in/out points, ride
effect parameters (Lumetri, Motion, Opacity, Volume) with learned knob
bindings — and see the playhead position plus the selected clip on a
VSN1 module screen. Everything runs through Premiere's native UXP API,
with no keyboard shortcuts or key emulation.

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

| Block             | Best on      | What it does                                                                                     |
| ----------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| Timeline Navigate | endless knob | Jog the playhead N frames per detent                                                             |
| Timeline Zoom     | endless knob | Zoom the timeline in/out per detent                                                              |
| Marker            | button       | Add marker, or jump to next / previous                                                           |
| In / Out Point    | button       | Set in / out at playhead, or clear                                                               |
| Playhead Edit     | button       | Select all under playhead (API), cut all under playhead, trim before/after                       |
| Clip              | button       | Enable/disable + delete selection (API), speed/duration, audio gain, group, ungroup, copy, paste |
| Project           | button       | Save (API), undo, redo, export, render in-out                                                    |
| Tool              | button       | Selection / Razor tool                                                                           |
| View              | button       | Snap toggle, Effect Controls panel                                                               |
| Modifier Hold     | button       | Hold Alt / Shift / Ctrl while the button is held                                                 |
| Param Map         | knob / fader | Drive a learned effect parameter (see Parameter mapping below)                                   |
| Premiere Display  | VSN1 screen  | Playhead + selected clip + last-touched parameter status screen                                  |

### Native vs keyboard

Premiere's UXP API is **read-heavy and edit-light**: it has no
command/menu dispatch of any kind, so anything that is a menu item, a
tool, or a UI toggle simply cannot be driven natively. Everything the
API does expose is implemented natively here — those entries run
through the plugin, are undoable, and work regardless of which app has
focus:

| Native (UXP API)                                       |
| ------------------------------------------------------ |
| Timeline Navigate, Marker add/next/prev, In/Out points |
| Select all under playhead, Trim before / Trim after    |
| Clip enable/disable, Delete selection                  |
| Project save, Export (queue to Media Encoder)          |
| Param Map (effect parameter rides + learn-by-wiggle)   |
| Premiere Display readout (playhead + selected clip)    |

**Timeline Zoom** takes a third route: Premiere has no zoom API and
zoom keyboard shortcuts are keyboard-layout-dependent, so the package
synthesizes the native **zoom-scroll gesture at the OS level** — one
wheel event per knob burst with a multiplied delta. On Windows a
persistent SendInput helper emits Ctrl+wheel; on macOS a persistent
JXA helper posts a CGEvent scroll carrying the Option modifier flag
(grant the Grid Editor **Accessibility** permission in System
Settings, or events are silently dropped). Hover the mouse over the
timeline while turning — it lands wherever the cursor is, no panel
focus needed.

The rest have **no API at all** and remain USB keystrokes sent by the
module (Premiere must be the focused app, and remapped shortcuts won't
match): Undo, Redo, Render, Cut under playhead, Speed/Duration, Audio
Gain, Group, Ungroup, Copy, Paste, Selection/Razor tool, Snap toggle,
Effect Controls panel, and Modifier Hold.

One further caveat: **Trim** does not ripple (the API has no ripple
edit), so it leaves a gap where Premiere's Q/W would close it.

## Parameter mapping

Grid knobs and faders can drive effect parameters on the selected clip
through eight mapping **slots**. A slot is paired with a parameter by
**learn-by-wiggle**:

1. Click **Learn binding** in the package preferences.
2. Drag any supported parameter in Premiere's UI.
3. Move the Grid control carrying a **Param Map** block — that slot
   now drives the parameter, and the binding is remembered.

**Supported parameters** (the UXP API exposes no min/max, so ranges
are hardcoded per parameter): Opacity, Motion Scale and Rotation, the
Lumetri Basic sliders (Temperature, Tint, Saturation, Exposure,
Contrast, Highlights, Shadows, Whites, Blacks) and audio Volume.

**Control forms.** An **endless knob** works relatively: each detent
nudges the current value by the block's _Step / click_ (down to 0.01
for fine rides); the running value seeds from the parameter itself and
re-syncs after 2 s of quiet, so mouse edits and undo are respected. A
**fader** works absolutely: its physical position maps onto the
parameter's full range.

**Write modes.** The API has no transient write path — every commit
lands one undo entry (same for every control surface out there). So
each block chooses: **Live picture** commits ~10×/s while you turn for
instant feedback at the cost of undo noise, or **Clean undo** streams
the moving value only to the module screen and commits a **single**
undo entry half a second after you stop. Either way the parameter name
and value appear on the Premiere Display panel as you turn.

A third block form, **Reset to default**, goes on the knob's press
(Button event) and snaps the parameter back to its default value.

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
- `ppmn` / `ppmv` — last-touched mapped parameter's name and value

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
- **Bump `premiere-plugin/manifest.json`'s `version` on every `.ccx`
  rebuild that users must install** — Creative Cloud can silently keep
  the installed copy when the manifest version is unchanged. The panel
  status line shows the running build (`PLUGIN_VERSION`) to verify.
- `GRID_PP_BRIDGE_PORT` overrides the WebSocket port (used by tests so
  they can run beside a live editor).

## Release

Pushing to `main` triggers `.github/workflows/main.yml` (same pipeline
as the official packages): it creates a GitHub release named after
`package.json`'s `version` and attaches `package-archive.zip` per OS,
built by `build.js` (runtime files + `node_modules` + components +
the `.ccx`). The Grid Editor detects newer releases and offers the
update. Bump `version` before pushing a release-worthy main.

# Grid Premiere Pro package

Control Adobe Premiere Pro with Grid. Jog the timeline from an endless
knob, drop markers, set in and out points, ride Lumetri and Motion
parameters from your controls, and read the playhead off a VSN1 screen.
Everything that can run through Premiere's own API does. No keyboard
emulation, no window juggling.

The package has two halves, in the shape of the official Photoshop and
Lightroom packages: a package inside the Grid Editor, and a companion
UXP plugin inside Premiere. Requires Premiere Pro 25.6 or newer.

## How it connects

```
Grid module ──gps()──▶ Grid Editor ──ws://127.0.0.1:3543──▶ Premiere plugin ──▶ active sequence
VSN1 screen ◀──Lua──── Grid Editor ◀──────────────────────── playhead, clip, parameter values
```

The editor package is the WebSocket server; the plugin connects to it,
runs commands through the Premiere API, and reports the playhead, the
selected clip, and mapped parameter values back for the module screens.
The connection is local only.

## Action blocks

| Block             | Best on      | What it does                                                            |
| ----------------- | ------------ | ----------------------------------------------------------------------- |
| Timeline Navigate | endless knob | Jog the playhead, N frames per step                                     |
| Timeline Zoom     | endless knob | Zoom the timeline in and out                                            |
| Marker            | button       | Add a marker, or jump to the next or previous one                       |
| In / Out Point    | button       | Set in or out at the playhead, or clear both                            |
| Playhead Edit     | button       | Select, cut, or trim everything under the playhead                      |
| Clip              | button       | Enable, disable, delete, group, copy and paste the selection            |
| Project           | button       | Save, undo, redo, export, render                                        |
| Tool              | button       | Switch between Selection and Razor                                      |
| View              | button       | Snap toggle, Effect Controls panel                                      |
| Modifier Hold     | button       | Hold Alt, Shift or Ctrl for as long as the button is down               |
| Param Map         | knob / fader | Drive a mapped effect parameter                                         |
| Premiere Display  | VSN1 screen  | Clip, channel, last touched parameter and playhead on the module screen |

## Native or keyboard

Premiere's UXP API has no menu or command dispatch, so every entry is
one of two kinds. Native entries run through the plugin: they are
undoable, frame-accurate, and work no matter which app has focus. That
covers timeline navigation, markers, in and out points, selection and
trims at the playhead, clip enable and delete, save, export, parameter
mapping, and the screen readout.

The rest are the module typing Premiere's default shortcut: undo, redo,
render, cut at the playhead, speed, gain, grouping, copy, paste, tools,
snap, panels, and Modifier Hold. Premiere must be the focused app, and
remapped shortcuts will not match.

Timeline Zoom takes a third route. Premiere has no zoom API and its
zoom shortcuts depend on keyboard layout, so the package synthesizes
the native gesture at the OS level: Ctrl+scroll on Windows,
Option+scroll on macOS. Hover the timeline while you turn and the zoom
lands under the cursor, exactly like scrolling yourself. On macOS,
grant the Grid Editor Accessibility permission first.

Two caveats worth knowing: trims do not ripple (the API has no ripple
edit), and the clip readout follows the selected clip, since Adobe
exposes no hover information to plugins.

## Parameter mapping

Eight slots pair Grid controls with effect parameters on the selected
clip.

To map one:

1. Press a Param Map block set to **Learn**, or click **Learn binding**
   in the package preferences.
2. Drag the parameter in Premiere. A small nudge is enough.
3. Move the Grid control that should own it.

The binding lands in that control's slot and is remembered. Supported
parameters: Opacity, Motion Scale, Rotation and Position (X and Y bind
separately), the Lumetri Basic sliders, and audio Volume. Ranges are
fixed per parameter, since the API does not expose them.

An **endless knob** works in steps: each move nudges the value by the
block's step size, seeded from wherever the parameter currently sits.
A **fader** maps its physical position onto the parameter's full range.

Two write modes, because the API files an undo entry for every commit:

- **Live picture** commits about ten times a second while you turn.
  Instant feedback, noisy undo history.
- **Clean undo** shows the moving value on the module screen and
  commits once, half a second after you stop.

Either way the parameter's name and value appear on the Premiere
Display as you turn. A block set to **Reset** on the knob's press snaps
the parameter back to its default.

## Install

1. Install this package in the Grid Editor's package manager.
2. In the package preferences, click **Open plugin folder** and
   double-click `c8e52a9b_PPRO.ccx`. Creative Cloud installs the Grid
   Control plugin into Premiere.
3. In Premiere, open the **Grid Control** panel and keep it open.
4. On a VSN1, add the **Premiere Display** block to the screen
   element's **Draw** event.

## Screen readout

The plugin watches the playhead and the timeline selection and reports
changes over the socket. The package keeps five module Lua globals
fresh:

- `pptc` playhead timecode, `hh:mm:ss:ff`, non-drop-frame
- `ppcn` selected clip's name
- `ppct` selected clip's channel, "Video 1", "Audio 2"
- `ppmn` / `ppmv` last touched mapped parameter and its value

The Premiere Display block draws them from inside the screen's Draw
event and repaints only when a value changes. Use the globals directly
for your own layouts. Updates hold while a jog is streaming so the
knob stays tight, and catch up the moment you stop.

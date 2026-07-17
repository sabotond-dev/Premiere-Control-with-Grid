# Grid Control — Premiere Pro CEP extension

This is the Premiere-side half of the Grid Premiere Pro package. It runs
as a CEP panel inside Premiere and drives the active sequence through
Premiere's scripting API. It talks to the Grid Editor package over a
local TCP socket (`127.0.0.1:23120`) — no keyboard emulation, nothing
leaves your machine.

## Install (development)

Copy (or symlink) this `cep/` folder into Premiere's user extensions
folder, renamed to `studio.intech.gridcontrol`:

- **Windows:** `%APPDATA%\Adobe\CEP\extensions\studio.intech.gridcontrol`
- **macOS:** `~/Library/Application Support/Adobe/CEP/extensions/studio.intech.gridcontrol`

Unsigned extensions need CEP debug mode enabled once:

- **Windows:** in `regedit`, under
  `HKEY_CURRENT_USER\Software\Adobe\CSXS.11` (and `.10`, `.9`), add a
  string value `PlayerDebugMode = 1`.
- **macOS:** `defaults write com.adobe.CSXS.11 PlayerDebugMode 1`
  (repeat for `.10`, `.9`).

Restart Premiere, then open **Window > Extensions > Grid Control**. The
dot turns green when the Grid Editor package is running.

## What it does

| Command   | Premiere API                                    |
| --------- | ----------------------------------------------- |
| Timeline  | `getPlayerPosition` / `setPlayerPosition`       |
| Marker    | `sequence.markers.createMarker` / iterate       |
| In / Out  | `sequence.setInPoint` / `setOutPoint`           |
| Playhead  | `getPlayerPosition`, polled for the readout     |

All frame math uses the sequence timebase, so a detent is exactly N
frames at any frame rate.

The playhead poll runs every 200 ms, only while the eval queue is idle
(commands and jog deltas always go first), and only reports actual
changes back to the editor. The editor side uses it to draw a timecode
readout on the VSN1 module screen.

## Signing for release

For distribution, sign the extension with Adobe's `ZXPSignCmd` and ship a
`.zxp` (installable via the Anastasiy Extension Manager or ExManCmd).
Debug mode is only needed for the unsigned development install above.

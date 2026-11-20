# Automation clips · Try this

Automation clips (W2, decision 127): clips on their own automation tracks whose curve sets the values they're linked to while they play (W2.1), and the editor that draws the curve, FL Studio's way (W2.2, decision 131). Tempo (W2.3) comes next. About 15 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Quit the app if it's open. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario automation
cat renders/ui/automation.json
open renders/ui/automation.png
npm run snapshot -- --scenario automationeditor
cat renders/ui/automationeditor.json
open renders/ui/automationeditor.png
npm run snapshot -- --scenario tempoauto
cat renders/ui/tempoauto.json
open renders/ui/tempoauto.png
npm run snapshot -- --scenario automationtogether
cat renders/ui/automationtogether.json
open renders/ui/automationtogether.png
npm start
```

- [ ] `npm run check` ends with **Tests 440 passed (440)**. New tests: the curve shapes (single and double curves, hold, stairs, smooth stairs, pulse, wave), Create Automation Clip (its own track, modulator and link), the clip setting a value while it plays, holding its last point after and leaving the value alone before, splitting (both halves control the same values, the curve carries on), deleting the last clip (its links go), and saving and opening. Since W2.2: the editor's edits (adding a point with its stretch's shape, moving between neighbours, deleting but keeping one, shapes, tension handles, snapping by zoom).
- [ ] `automation`: `"verdict":"pass"`. A white square's Opacity and Scale follow one automation clip; the exported square matches the curve (`worstEdgePx` under 1.5, `worstLevel` under 0.006), `curveFromExport` reads 50 at the start, 100 at 3 s, four stairs down, 60 held, 100 at the end, and playback matches the export (`worst` under 0.006).
- [ ] `automation.png`: an **Auto 1** track under V1 with an amber clip, its curve drawn across it.
- [ ] `automationeditor`: `"verdict":"pass"`, `"worst"` under 0.008, and all eight stretches in `"shapes"` (single, double, hold, stairs, smooth-stairs, pulse, wave, single) with their `"worst"` under 0.008: the curve the editor draws is what plays. `"controls"` ends as `["opacity","scale"]`.
- [ ] `tempoauto`: `"verdict":"pass"`: `"posterize"` `"held":250` with `"holdLengths"` shrinking from 13 and 12 to 11 (the ramp), `"cubes"` 20 of 20, `"playback"` `"same"` equal to `"of"`, and `"metronome"` `"worstMs":0`.
- [ ] `tempoauto.png`: the Automation Editor on the tempo clip, its axis in BPM (60–180), the ramp from 120 to 140 then flat; the tempo knob reading 130.000 at 7 s, in pink.
- [ ] `automationtogether`: `"verdict":"pass"`, `"controls":["tempo","scale"]`, `"worstWidthPx"` under 1.5, `"flashes"` equal to `"beats"` (22), `"scaleAt0369":[100,116.67,133.33,133.33]`, `"playbackVsExport"` `"worst"` under 0.006, and `"metronome"` `"worstMs":0`.
- [ ] `automationtogether.png`: the Automation Editor on one clip whose Controls list both **Tempo** (60–180 BPM) and **Scale**.
- [ ] `automationeditor.png`: the Automation Editor over the timeline: the curve in its eight shapes on the bar grid (1–5), the points and the small tension handles, the playhead's pink line, and the clip's name, Controls and + Pick a value… on the right.

## In ginosa

- [ ] Select a clip with an effect. In Effect Controls, right-click a value (Opacity, say) › **Create Automation Clip**. An **Auto 1** track appears under the video tracks with an amber clip at the playhead (4 bars long with a beat grid, 8 seconds without), named after the value. It starts flat at the value as it is.
- [ ] Select the automation clip: Effect Controls shows what it controls, with × to let a value go.
- [ ] The Control Panel's **New automation clip** button (next to New adjustment layer) makes an unlinked one at the playhead; a second one over the same time goes on a new automation track.
- [ ] Move, trim, split (C or Cmd+K), copy, paste and delete automation clips like any clip. Split halves and copies control the same values. Deleting the last clip of an automation lets its values go back to their own.
- [ ] The track's speaker button mutes it: its clips stop setting their values.
- [ ] **Double-click the automation clip**: the Automation Editor opens on its curve (⌥⇧6 opens it too). Selecting another automation clip shows that one.
- [ ] **Click empty space** in the graph: a point appears there (snapped to the grid) and follows the mouse until you let go. **Drag a point**: it can't pass its neighbours. Hold **⌥** to place it between grid lines; the **Snap** button turns snapping off.
- [ ] Each stretch has a small round **handle** halfway along. Drag it up or down: a curve bends that way; Stairs, Pulse and Wave get more or fewer steps or cycles. The readout at the top says how many ("4 steps") or how far it bends.
- [ ] **Right-click a point** (or the stretch after it): pick its shape, Straighten, or Delete. The **Shape** menu at the top changes the selected points' stretches. **⌫** deletes the selected points (one always stays); **⌘A** selects them all. ⌘Z undoes a whole drag at once.
- [ ] On the right: what the clip **controls** (× lets a value go), **+ Pick a value…** (search, open an effect, click a value), and the clip's name: **drag it onto a value** in Effect Controls to link that value too.
- [ ] Play: the values follow the curve as drawn. Tell me how the editor feels next to FL's.

### Tempo (W2.3)

- [ ] With a song and its tempo set, put the playhead where the tempo should start changing and press the **wave button** by the tempo knob (Automate BPM), or right-click the knob. A clip named **Tempo** appears on an automation track and opens in the editor, its axis in BPM, flat at the song's tempo.
- [ ] Draw a ramp (drag the end point up), a jump (a Hold, then a higher point), or stairs. Turn on the metronome and play: the clicks speed up and slow down with the curve. The ruler's bars squeeze and stretch to match.
- [ ] The **tempo knob** shows the tempo under the playhead: pink where the tempo clip sets it (click it to open the clip), its usual colour before the first tempo clip.
- [ ] The **Channel Rack**'s cubes, **Posterize Time** (on the beat grid) and beat-synced LFOs stay on the beat through the ramp, in playback and in an export.
- [ ] Beside the graph: type the range's ends (the curve keeps its tempos), × stops the clip setting the tempo, and **+ Control the tempo** on another automation clip makes it set the tempo too. Muting the automation track turns the tempo changes off.

### One clip, the tempo and an effect (W2.4)

- [ ] Press **Automate BPM**, then in the editor **+ Pick a value…** and choose an effect value (Basic Correction's Exposure, say). Draw a ramp: the tempo and the value rise together, the metronome speeding up as the picture changes.
- [ ] Or the other way: right-click a value › **Create Automation Clip**, then **+ Control the tempo** in its editor.
- [ ] Export a few seconds over the ramp and play the file: it matches what the preview played.

## Sign-off (W2)

When it all works as you want, tell me "W2 signed off" (or what to change). Signing off approves:

- [ ] **Decision 131**, the automation editor's interactions (click to add, drag, handles for tension, right-click for shapes, snapping by zoom, ⌥ to move freely, the picker and dragging the clip's name).
- [ ] **Decision 132**, tempo automation (Automate BPM, tempo clips and their BPM range, the knob showing the tempo under the playhead and opening the clip, beats counted through ramps).
- [ ] **Decision 127**'s engineering (clips drive values through the modulation engine; before a clip a value is its own; after it the clip's last point holds until the next).


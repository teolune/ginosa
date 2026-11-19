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
npm start
```

- [ ] `npm run check` ends with **Tests 434 passed (434)**. New tests: the curve shapes (single and double curves, hold, stairs, smooth stairs, pulse, wave), Create Automation Clip (its own track, modulator and link), the clip setting a value while it plays, holding its last point after and leaving the value alone before, splitting (both halves control the same values, the curve carries on), deleting the last clip (its links go), and saving and opening. Since W2.2: the editor's edits (adding a point with its stretch's shape, moving between neighbours, deleting but keeping one, shapes, tension handles, snapping by zoom).
- [ ] `automation`: `"verdict":"pass"`. A white square's Opacity and Scale follow one automation clip; the exported square matches the curve (`worstEdgePx` under 1.5, `worstLevel` under 0.006), `curveFromExport` reads 50 at the start, 100 at 3 s, four stairs down, 60 held, 100 at the end, and playback matches the export (`worst` under 0.006).
- [ ] `automation.png`: an **Auto 1** track under V1 with an amber clip, its curve drawn across it.
- [ ] `automationeditor`: `"verdict":"pass"`, `"worst"` under 0.008, and all eight stretches in `"shapes"` (single, double, hold, stairs, smooth-stairs, pulse, wave, single) with their `"worst"` under 0.008: the curve the editor draws is what plays. `"controls"` ends as `["opacity","scale"]`.
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

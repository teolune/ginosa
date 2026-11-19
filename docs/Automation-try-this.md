# Automation clips · Try this

Automation clips (W2, decision 127), first step (W2.1): clips on their own automation tracks whose curve sets the values they're linked to while they play. The editor (W2.2) and tempo (W2.3) come next. About 10 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Quit the app if it's open. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario automation
cat renders/ui/automation.json
open renders/ui/automation.png
npm start
```

- [ ] `npm run check` ends with **Tests 421 passed (421)**. New tests: the curve shapes (single and double curves, hold, stairs, smooth stairs, pulse, wave), Create Automation Clip (its own track, modulator and link), the clip setting a value while it plays, holding its last point after and leaving the value alone before, splitting (both halves control the same values, the curve carries on), deleting the last clip (its links go), and saving and opening.
- [ ] `automation`: `"verdict":"pass"`. A white square's Opacity and Scale follow one automation clip; the exported square matches the curve (`worstEdgePx` under 1.5, `worstLevel` under 0.006), `curveFromExport` reads 50 at the start, 100 at 3 s, four stairs down, 60 held, 100 at the end, and playback matches the export (`worst` under 0.006).
- [ ] `automation.png`: an **Auto 1** track under V1 with an amber clip, its curve drawn across it.

## In ginosa

- [ ] Select a clip with an effect. In Effect Controls, right-click a value (Opacity, say) › **Create Automation Clip**. An **Auto 1** track appears under the video tracks with an amber clip at the playhead (4 bars long with a beat grid, 8 seconds without), named after the value. It starts flat at the value as it is.
- [ ] Select the automation clip: Effect Controls shows what it controls, with × to let a value go.
- [ ] The Control Panel's **New automation clip** button (next to New adjustment layer) makes an unlinked one at the playhead; a second one over the same time goes on a new automation track.
- [ ] Move, trim, split (C or Cmd+K), copy, paste and delete automation clips like any clip. Split halves and copies control the same values. Deleting the last clip of an automation lets its values go back to their own.
- [ ] The track's speaker button mutes it: its clips stop setting their values.
- [ ] Drawing the curve comes with the editor (W2.2): until then a new clip is flat. Tell me how the track and clip look and feel.

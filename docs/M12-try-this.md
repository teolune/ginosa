# M12 · Try this (Posterize Time and the Channel Rack)

M12 adds two things:
- **Posterize Time** (Effects › Time): the picture updates only on the beat (or at a set rate) and holds in between, for a stutter in time with the music.
- **The Channel Rack** (⌥⇧4): your FL Studio idea. Rows of steps that fire effects, which you can auto-fill from the song and fix by hand. Kick Flash and Hi-Hat Grain follow a Kick or Hat row when there is one.

How it's all worked out is in decisions 71–75 (all Proposed). Done when: hold patterns match the beat grid in tests (they do, frame for frame), and you sign off.

About 40 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario posterize
cat renders/ui/posterize.json
npm run snapshot -- --scenario rackui
cat renders/ui/rackui.json
open renders/ui/rackui.png
npm run dev
```

- [ ] `npm run check` ends with **Tests 340 passed (340)**. The 17 new tests cover:
  - Posterize Time's timing: 1/16 at 128 BPM and 24 fps runs in holds of 3 and 2 frames that never drift (16 holds = exactly 45 frames); holds before and after the downbeat; Phase, Swing, Sample middle, Free mode and Off; the knob going slowest to fastest
  - Posterize Time in the render plan: on a clip, the effects above it held and Motion and the effects below it moving; a clip starting on its own first frame; everything beneath an adjustment layer held, kept or switched at a cut; the Rate knob holding between keyframes and moving by whole steps when modulated; held frames sharing a render cache key
  - the Channel Rack: rows with their own modulators; steps, a paint stroke as one undo step, swing and the light; Fill, Repeat and Auto-fill's snapping; deleting a row and what it drove; the one-frame pulses, swung and on the beat grid; saving and opening older projects; Kick Flash following a Kick row
- [ ] `posterize` is M12's done-when. The frame-numbered test clip plays under an adjustment layer with Posterize Time. Every exported frame's number is read back and compared with the beat maths, worked out separately in the test. Expect `"verdict":"pass"`. I measured **250 of 250** frames right (and 6 of 6 in the preview) in each case:
  - 1/16 at 128 BPM of its own
  - the beat grid (126 BPM, downbeat at 0.3 s), 1/8, swing 33%, phase 0.25 beat, sampling the middle
  - a cut under the layer, kept until the next update
  - the same cut, switched at the cut

  Then a Kick row (steps 0, 3, 8 and 11, swung 50%) drives Kick Flash. The exposure flashes fully on frames **10, 21, 34 and 44**, the steps' frames, and the exported file brightens on exactly those frames.
- [ ] `rackui`: the 128 BPM test drums as the song. Auto-fill put **17** kick steps, all on beats, and **33** hat steps, all on 8ths. Kick Flash follows the Kick row. `rackui.png` shows the Channel Rack (Bars 1–2, the playing step outlined) and Posterize Time's knob reading "1/8 · 4.27 fps".

## Posterize Time

- [ ] Put it on an adjustment layer over your footage, with your song's beat grid set in Audio Analysis.
  - **Rate** is a knob: drag up or down, or click it and use the arrow keys; double-click resets it.
  - The readout shows the note and the resulting frame rate. Try 1/8 and 1/16.
- [ ] Play it: the picture should step in time with the music. Scrub and pause anywhere; export a stretch and compare.
- [ ] **Timing → Free** gives a plain frame rate instead. **Tempo → This BPM** gives it a tempo of its own.
- [ ] **Phase** moves every update; **Swing** delays every second one (33% is a shuffle).
- [ ] **Sample → Middle of each hold** shows the frame halfway into each hold: the stutter sits centred on the movement.
- [ ] Put a cut under the layer. **Reset on Cuts** decides what happens mid-hold:
  - **Keep the old shot**: the cut lands on the next beat (true posterize).
  - **Switch at the cut**: the new shot starts right away, then holds.
- [ ] On a **clip** instead: Motion still moves smoothly. Effects above Posterize Time in the stack are held with the picture; effects below it aren't. Drag the effects' order to compare.
- [ ] Animate Rate with keyframes: it jumps at each one. Right-click Rate › Link to Audio › Bass level: louder bass, faster stutter (whole steps).

## Channel Rack (⌥⇧4)

- [ ] Click **Add Kick, Clap and Hat**.
- [ ] Each row has:
  - its **light**: click it to switch the row off (the steps are kept)
  - **Swing**: drag the % value
  - its **name**: click it for the row's menu
  - its **steps**: two bars at a time, in groups of four, shaded alternately like FL Studio
- [ ] **Steps**: click to turn one on or off, or drag across steps to paint. A whole drag is one undo.
- [ ] **Paging**: the white outline is the step under the playhead. The page turns with the playhead (untick **Follow playhead** to page by hand with ◀ ▶). Choose 1, 2 or 4 bars.
- [ ] **Auto-fill**: in Kick's menu, **Auto-fill whole song from Song (Bass hits)**. Check its steps against the music and fix any it got wrong. **Auto-fill listens to…** picks another band. **Auto-fill these bars** redoes only the page on screen.
- [ ] **Writing a pattern by hand**: write a bar or two, then click **Repeat to End** to loop them through the song. A row's menu has **Repeat These Bars to the End** and **Clear These Bars** too.
- [ ] **Linking**: right-click any value (Opacity, an effect's Amount…) › **Link to Pattern: Kick**. It now fires on Kick's steps; shape the flash in the Modulation window (the modulator is called "Kick").
- [ ] **Presets**: with a Kick row, apply **Kick Flash** (Built-in Presets). Its message says it follows the Kick row, so fixing a step fixes the flash. **Hi-Hat Grain** follows a Hat row the same way.
- [ ] Change the tempo in Audio Analysis: the steps move with the beat grid.
- [ ] Save, close and reopen the project: the rack is still there.

## Also

- [ ] The title bar says **M12**.
- [ ] Project format v12: older projects open with an empty Channel Rack.
- [ ] No new dependencies, so no new licences.
- [ ] M5–M11's tests ran again after the render plan changes and still pass.

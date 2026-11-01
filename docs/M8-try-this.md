# M8 · Try this (audio and modulation)

M8 makes ginosa listen to your music and move with it:
- **analysis sources**: a clip, a track (muted ones too, as a sidechain) or the mix, analysed in the background and cached
- what it hears, 200 times a second: six bands, loudness, peak, transients and hits
- **tempo**: detected BPM and downbeat, ×2/÷2, tap tempo, typed BPM, beats per bar, downbeat nudge
- bars and beats on the ruler, and **snapping to beats** for clips and keyframes
- **modulators** (audio signals, tempo, LFOs, random), each driving any number of values
- **right-click any value**: Link to Audio, Modulate Parameter, Remove Modulation, Copy/Paste Value, Reset
- the **Audio Analysis** (⌥⇧1) and **Modulation** (⌥⇧2) windows

What reacts in playback is exactly what exports. About 30 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run test-media
npm run snapshot -- --scenario analysis
cat renders/ui/analysis.json
open renders/ui/analysis.png
npm run snapshot -- --scenario modulation
cat renders/ui/modulation.json
npm run snapshot -- --scenario modulationui
open renders/ui/modulationui.png
npm run dev
```

- [ ] `npm run check` ends with **Tests 263 passed (263)**. The 28 new tests cover:
  - the bands (checked against the filters' exact response), zero filter delay, hits on the drums, storage
  - tempo detection on synthetic drums at 87, 97.3, 120, 128 and 174 BPM, with their downbeats
  - beat-grid maths, tap tempo, snapping targets, sources and when their analysis is redone
  - the modulator chain (threshold and knee, attack and release, curves, LFOs, tempo signals, random), links (add, multiply, replace, invert, amount)
  - every modulation command, links through splits and saving, opening older projects
- [ ] `test-media` makes a new file, `beat_128bpm.wav`: drums at 128 BPM whose first bar starts 0.4 s in.
- [ ] `analysis` puts it on a **muted** track, analyses that track as a source and uses its detected tempo. Expect `"verdict":"pass"`. I measured **128.000 BPM**, bars within **1 ms** of where they are, 30 s analysed in under a second, and the result saved in the cache.
- [ ] `modulation` is the M8 "done when". One source ("Song") drives three values of a white square: its Bass the Scale, its Loudness the Opacity, its High hits the Rotation. It exports and also plays in real time. Expect `"verdict":"pass"`. I measured:
  - playback vs the file, all 200 frames: worst **0.0015** (about one 10-bit step)
  - the square in every exported frame vs the modulated values: edges within **0.11 px**, brightness within **0.0006**
- [ ] `modulationui.png` shows the Modulation window and Effect Controls with the gold **∿** badges (each modulated value as it is at the playhead).

## Audio Analysis (⌥⇧1)

- [ ] **+ Source** adds what to listen to: the selected audio clip, a track, or the full mix. Mute a track (a drum stem, say) and it's still analysed: that's a sidechain. Double-click a source to rename it ("Song", "Drums").
- [ ] It analyses in the background ("Mixing…", "Analysing… 40%"), then shows each band's level (filled), its transients (white line) and hits (white marks), scrolling past the playhead. Click to move the playhead; scroll to zoom.
- [ ] Moving or changing the song's clip redoes its analysis; renaming the source, or editing other tracks, doesn't. Reopening the project uses the cache.
- [ ] **Tempo**:
  - **Detected … BPM · Use** makes it the beat grid; the other numbers are other likely tempos
  - **×2 / ÷2** when the detector heard half or double time
  - **Tap** along with the beat (four taps or more); type the BPM by clicking it
  - **Bar**: beats per bar; **Downbeat** ◀ ▶ nudges by a frame (Option: 1 ms, Shift: a beat); **Set to Playhead** puts a bar start at the playhead
- [ ] Bars (numbered) and beats appear on the timeline ruler, with faint bar lines through the tracks, and on the Keyframe Editor's ruler.
- [ ] With snapping on, dragging clips, trims, the playhead and keyframes snap to beats (rounded to the nearest frame).

## Modulation

- [ ] Right-click a value in Effect Controls › **Link to Audio…**: pick the source and what to follow (a band's level, loudness, peak, a band's transients, or its hits). It reacts within 5 ms and falls back over 150 ms, from the value as it is now. Do it on a second value with the same signal: it reuses that modulator.
- [ ] A modulated value shows a gold **∿** badge with what it is right now; click it to open the Modulation window.
- [ ] **Modulation window (⌥⇧2)**: modulators on the left, each with a live meter. For the one selected:
  - **Source**: Audio (source, signal, band, or a custom range in Hz), Tempo (every beat, every bar, beat phase, bar phase), LFO synced to the beat (sine, triangle, saw, square, random steps; 4 bars to 1/32, triplets, dotted; phase) or Random
  - **Input Gain, Threshold, Knee, Attack, Release** (each with a stopwatch: keyframe them, e.g. more sensitive in the chorus)
  - **Curve**: linear, exponential, logarithmic, S-curve, or Drawn (drag its five points)
  - the input (grey) and output (gold) 3 s either side of the playhead
  - **Drives**: every value it moves, each with Add / Multiply / Replace, its range, Invert and Amount
- [ ] **Modulate Parameter…** (right-click) opens the window to pick any modulator (or make one with **+ New**) and **Link** it.
- [ ] **Remove Modulation**, **Copy Value / Paste Value** and **Reset** (one value back to its default) are on the same menu.
- [ ] Modulate Volume on a clip: the sound follows it, in playback and export.
- [ ] In the Keyframe Editor's Graph, a modulated value also shows its real curve, faint, beside its keyframes.
- [ ] In Audio Analysis, each modulator listening to the source is drawn (dashed gold) over the band it follows: why something reacted.
- [ ] Export: the file matches what you saw.

## Your music

- [ ] Add one of your songs as a source: tell me the BPM it detects, whether that's right (or ×2/÷2 off), and whether the bars land on the "one".
- [ ] Link something to its bass and play it on your Apple Log footage; tell me the fps and dropped numbers.

## Not yet

- The drum pattern sequencer (your idea) comes with M12.
- Modulator settings are keyframed in the Modulation window; they don't have rows in the Keyframe Editor yet.
- A link's range and amount can't be keyframed yet (keyframe the modulator's gain or threshold instead).
- A tempo map for songs that drift comes later; the grid is one constant tempo.
- Effect presets don't keep modulation (modulators belong to a project).

# M11 · Try this (Grain)

M11 adds **Grain** (Effects › Noise & Grain): film grain or digital sensor noise, generated fresh on the GPU.
- It changes every frame, every few frames, or on a note value in time with the beat grid.
- **Boil** controls how much of the grain carries over between changes.
- A frame always looks the same in playback, stills, the render cache and export.

There are six new built-in presets: Fine 35 mm, 16 mm and Super 8 Grain, Digital Sensor Noise, Heavy Noise, and **Hi-Hat Grain**, which follows your music.

How it's worked out is in decisions 67–70 (all Proposed). Done when: you sign off after trying it.

I also wrote your Channel Rack screenshot into the plan for M12's drum sequencer: one row per trigger, a light to switch each row off, steps you click yourself, auto-filled from the hits. Kick Flash becomes one of its rows.

About 30 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario graingpu
cat renders/ui/graingpu.json
npm run snapshot -- --scenario exportgrain
cat renders/ui/exportgrain.json
npm run snapshot -- --scenario grainui
open renders/ui/grainui.png
npm run dev
```

- [ ] `npm run check` ends with **Tests 323 passed (323)**. The 14 new tests cover:
  - the random numbers: the same every time, evenly spread, true Gaussians
  - grain strength the same everywhere (no grid pattern) at any size and softness; bigger Size giving bigger grain
  - Refresh: every frame, every N frames, and on notes (a beat at 120 BPM changes on frames 12, 25, 37 and 50; a bar at 128 BPM on 47 and 94)
  - Boil: 0% frozen, 100% all new, in between partly the same
  - Seed, Monochrome and Colour Amount
  - Film, Digital and Grain layer, and Shadows / Midtones / Highlights
  - the lattice pass's size, and a still with grain getting a new render cache key on every frame
  - every built-in preset's settings being real and in range; Heavy Noise in Overlay; Hi-Hat Grain linked to the high band
- [ ] `graingpu` compares Grain on the GPU with its CPU maths on 10,553 pixels of a grey ramp and colour bands. It runs 12 cases: colour and mono; sizes 0.5 to 3; softness 0 to 100%; the three composites; refresh every N frames and on notes, including before the downbeat; boil; seed; Shadows only; Mix. Expect `"verdict":"pass"`.
  - I measured a worst of **0.0015**. The one exception is a Digital pixel right at black, where the display curve is steepest (0.0066, allowed up to 0.008).
  - `msPer4kFrame`: on a 4K frame I measured 1 ms with no effect, 2.5 ms with Monochrome grain, 4.9 ms with Colour grain and 6.9 ms at size 0.5. At 1080p it's about a quarter of that.
- [ ] `exportgrain`: Grain (45%, size 2, refreshing every 2 frames, boil 70%) on an adjustment layer over the colour patches, exported as ProRes 4444 and read back. Expect `"verdict":"pass"`. I measured:
  - **preview**: within **0.0014** of the CPU maths pixel by pixel. Frames 10 and 11 (one pattern) are identical; frames 11 and 12 differ.
  - **file**: its grain correlates **0.994** with the CPU's, **0.005** RMS. ProRes is lossy, and grain is the hardest thing to compress, so the file can't be exact (see DECISIONS, implementation notes).
- [ ] `grainui.png`: the test pattern with the Super 8 preset, refreshing on 1/8 notes. The Grain controls are in groups; Colour, Response and Time start folded, each with a blue dot (changed).

## Grain

Put **Grain** on a clip of your footage, or on an adjustment layer to grain everything under it.

- [ ] **Amount**, **Size** and **Softness**: Size 1 is very fine grain; 3 is coarse. Softness 0% is sandy; 100% is soft.
- [ ] Switch the Program monitor between Full and ½: the grain should look the same size.
- [ ] **Composite**:
  - **Film**: almost no grain in deep black, most in the midtones.
  - **Digital**: noise stays in the shadows, like a phone at night.
  - **Grain layer**: grey grain. Set **Blend Mode** (in the effect's header rows) to **Overlay** or **Soft Light** to lay it over the picture.
- [ ] **Colour** group: **Monochrome** or **Colour**. Colour Amount 0% looks the same as Monochrome; 100% makes red, green and blue grain completely separate. Make **Blue Size** bigger for film's coarser blue layer.
- [ ] **Response** group: try Shadows 0% to keep the darks clean, or Highlights 0% for clean skies.
- [ ] **Time** group:
  - **Refresh**: Every frame (the default). **Every N frames** shows the Every N Frames row; try 2 or 3 for a slower, filmic flicker. **On a note value** shows the Note row; with your song's beat grid, the grain jumps in time (try 1/8 or 1/4).
  - **Boil**: at 100% each change is a completely new pattern; lower it and the grain drifts rather than jumps; at 0% it freezes, like dust on the lens.
  - **Seed**: a different seed gives a different pattern with the same settings.
- [ ] Pause anywhere, step a frame forward and back: the grain comes back exactly the same.
- [ ] Press Enter to render previews: the green frames play with their grain changing as it should (a still image with grain now caches every frame separately).
- [ ] Export a stretch and compare it with what you saw.

## Built-in presets

- [ ] Effects Library › **Built-in Presets** has **Fine 35 mm Grain**, **16 mm Grain**, **Super 8 Grain**, **Digital Sensor Noise** and **Heavy Noise** (badge **P**, settings only). Drag one onto a clip. Heavy Noise sets the effect's Blend Mode to Overlay.
- [ ] **Hi-Hat Grain** (badge ∿) needs a source in Audio Analysis, like Kick Flash. The grain thickens on every hi-hat and settles in 80 ms. Its modulator is named "Hi-Hat Grain: …" in the Modulation window.
- [ ] Are the looks right for their names? Tell me which ones to change (decision 70).

## Also

- [ ] The title bar says **M11**.
- [ ] No new dependencies, so no new licences.
- [ ] M6–M10's GPU and export tests ran again after the pipeline changes and still pass.

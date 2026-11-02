# M10 · Try this (Colour & Light, Mosaic, audio-reactive presets)

M10 adds four effects and two built-in presets.

**Colour & Light** (a new category in the Effects Library):
- **Basic Correction**: Temperature, Tint, Exposure (in stops), Brightness, Contrast, Highlights, Shadows, Whites, Blacks, Saturation, Vibrance and Hue, in three groups.
- **Curves**: an RGB curve plus one for each channel, edited on a graph in Effect Controls.
- **Levels**: input and output black and white points and gamma, for RGB and each channel.

**Mosaic** (under Stylize): flat blocks, each the exact average of the light under it, with soft edges if you want them.

**Built-in presets**: Kick Flash and Bass Mosaic come already linked to your music.

How each one is worked out is in decisions 62–66 (all Proposed). The done-when for M10 is your sign-off after trying them, so the hands-on part matters most.

About 40 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario colourlightgpu
cat renders/ui/colourlightgpu.json
npm run snapshot -- --scenario exportcolourlight
cat renders/ui/exportcolourlight.json
npm run snapshot -- --scenario colourlightui
open renders/ui/colourlightui.png
npm run dev
```

- [ ] `npm run check` ends with **Tests 309 passed (309)**. The 17 new tests cover:
  - parsing curves and how they're drawn (through every point, flat beyond the ends, clipped)
  - Levels against Photoshop's formula, and the channel-then-RGB order
  - Basic Correction: no change at its defaults; Exposure in true stops; white balance keeping grey's brightness; black and white held by the tone controls; 0% saturation giving greys; Vibrance sparing skin and vivid colours
  - Mosaic: the grid (odd, centred, whole pixels, covering the picture), exact averages including cells that cut through pixels, centre pixels, soft edges, and off under a pixel
  - Kick Flash and Bass Mosaic: their links, one undo for everything, a modulator reused, and what happens with no audio
- [ ] `colourlightgpu` runs the four effects on the GPU and compares them with the CPU maths: 26 Basic Correction settings, 5 sets of curves and 7 of levels on 16 colours, a three-effect stack, and 10 Mosaic cases over 2,600 pixels of a busy test image. Expect `"verdict":"pass"`. I measured a worst of **0.0032** (half-float precision). `msPer4kFrame` is each effect's time on a 4K frame. I measured 1.2 ms with no effect, and with each: Basic Correction 2.3, Curves 2.0, Levels 1.9, Mosaic 2.5 (3.4 for one cell over the whole picture).
- [ ] `exportcolourlight` checks playback and export (10-bit HEVC, read back with FFmpeg) against the CPU maths. Expect `"verdict":"pass"`. I measured:
  - **Kick Flash** on the colour patches, with the 128 BPM test drums as its source: every exported frame's exposure matches the modulated value within **0.0022**. It flashed on frames **10, 22, 34 and 46**, the kicks' frames, reaching **+2 stops**. Preview: **0.0016**.
  - **Basic Correction → Curves → Levels** on an adjustment layer: export **0.0014**, preview **0.0014**.
  - **Mosaic** added after them: patch centres stay flat, and the cell across a patch edge is the average of the light either side. Export **0.0045**, preview **0.0035**.
- [ ] `colourlightui.png`: the test pattern with Curves (an S-curve and a warmer red), Basic Correction and a soft Mosaic. Effect Controls shows the Curves tabs (dots on RGB and Red, which are changed) and the curve editor.

## Basic Correction

Put it on a clip of your footage (Effects › Colour & Light), or on an adjustment layer.

- [ ] Its controls are in three foldable groups: **White Balance**, **Tone**, **Colour**. A blue dot on a group's heading means something in it is changed, animated or modulated.
- [ ] **Temperature** + makes it warmer (orange), − cooler (blue). **Tint** + goes magenta, − green. Neither should brighten or darken greys.
- [ ] **Exposure** works like the lens: +1 stop doubles the light, so highlights clip quickly. Try −1 and +1 on your Apple Log clips.
- [ ] **Brightness** lifts or lowers the middle without moving black or white. **Contrast** pushes tones away from the middle (or towards it, below 0).
- [ ] **Highlights** and **Shadows** work on the bright and dark tones; black and white stay put.
- [ ] **Whites** and **Blacks** move the very ends: Blacks above 0 makes a faded, lifted black; Whites above 0 blows the brightest parts out.
- [ ] **Saturation** 0% is black and white, 200% doubles colour. **Vibrance** boosts dull colours much more than vivid ones, and goes easy on skin. Compare the two on a face.
- [ ] **Hue** turns every colour around the wheel.
- [ ] Is anything off compared with Lumetri's Basic Correction (too strong, too weak, the wrong shape)? Tell me which control. These formulas are decision 62, Proposed.

## Curves

- [ ] The tabs **RGB / Red / Green / Blue** switch between the curves. A dot on a tab means that curve is changed.
- [ ] Click on the graph to add a point (up to 16) and drag it. The ends move too.
- [ ] To remove a point, drag it off the graph (it fades; let go), or double-click it.
- [ ] Click a point, then use the arrow keys to nudge it by one level (Shift: ten) and Delete to remove it. The line under the graph shows its input → output.
- [ ] A whole drag is one undo step.
- [ ] **Straighten** (in the row above the graph) resets that channel; right-click the row for Reset and the keyframe menu.
- [ ] With the stopwatch on, each keyframe holds a whole curve. The curve jumps at the next keyframe rather than morphing (decision 63).
- [ ] An S-curve on RGB plus a lifted start on Blue makes a quick "film" look.

## Levels

- [ ] **RGB** is open; **Red**, **Green** and **Blue** start folded. Click a heading to open it.
- [ ] Input Black 20 and Input White 235 stretch a flat image; Gamma above 1 brightens the middle; Output Black 20 fades the blacks.
- [ ] Every value can be keyframed and linked to audio, like any number.

## Mosaic

- [ ] Effects › Stylize › **Mosaic**. **Cell Size** is a share of the picture's height, so the blocks look the same at any playback resolution. **Cell Aspect** 2 makes them twice as wide as tall.
- [ ] **Colour**: *Average of the cell* (smooth on moving footage) or *Centre pixel* (crisper colours, but it flickers when things move). Try both on footage.
- [ ] **Edge Softness**: 0% hard blocks, 100% a soft blur from block to block.
- [ ] Animate Cell Size from 0% (off) up: it should grow smoothly, with no jumps.
- [ ] With a mask (M9), it can pixelate just a face or a region.

## Built-in presets

- [ ] Open Audio Analysis (⌥⇧1) and add a source for your song if there isn't one. The presets use the **first** source listed.
- [ ] Effects Library › **Built-in Presets** › **Kick Flash**: drag it onto a clip (or select the clip and double-click it). The clip gets Basic Correction with Exposure linked to the bass hits: a 2-stop flash on every kick, fading over 200 ms. The message says which source it follows.
- [ ] **Bass Mosaic**: Mosaic with Cell Size linked to the bass level, off when the bass is quiet and up to 6% at its loudest.
- [ ] In the Modulation window (⌥⇧2) the modulators are named "Kick Flash: …" and "Bass Mosaic: …". Change the release, threshold or range there to taste. Applying a preset again reuses its modulator.
- [ ] One undo removes everything the preset added (effect, link and modulator).
- [ ] With no source in Audio Analysis, the effect is added on its own and a message explains why.
- [ ] Kick Flash listens to *hits* (instant attack), not the plan's *transients* with a 5 ms attack: with that, the flash only reached 1.26 stops. This is decision 66 (Proposed). Tell me if you'd rather have the transient version.
- [ ] Export a stretch with Kick Flash and compare it with what you saw.

## Also

- [ ] The title bar says **M10**.
- [ ] No new dependencies, so no new licences.
- [ ] M9's tests still pass (`effectsgpu`, `masksgpu`, `feedbackgpu`, `exportmasks`, `exporteffects`, `feedback`, `modulation` all ran again after the effect-pipeline changes).

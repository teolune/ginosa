# M13 · Try this (Gradient Map)

M13 adds Photoshop's Gradient Map, and everything around it:
- **Gradient Map** (Effects › Colour & Light): the picture's tones mapped to a gradient's colours, as in Photoshop, with a few extras (palette cycling, contour bands, morphing between two gradients).
- **Photoshop gradient libraries (.grd)** in and out: your gradients come in with every stop, colour, midpoint and smoothness, and gradients made here go back to Photoshop.
- **The Gradient Editor** (⌥⇧5), with a gradient library shared by every project.

It also includes the stronger Basic Correction from 4 Nov (Temperature ±100 is now a full orange or blue gel).

How it works is in decisions 78–85. 79 (opacity stops ignored, as in Photoshop) is Approved; the rest are Proposed. Done when: Photoshop renders of the grey ramp through your gradients match within 1 level, and you sign off. That needs a few renders from your Photoshop (last section).

About 45 minutes, plus 15 in Photoshop.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario gradientmapgpu
cat renders/ui/gradientmapgpu.json
npm run snapshot -- --scenario gradientui
open renders/ui/gradientui.png
npm run snapshot -- --scenario gradientfidelity
cat renders/ui/gradientfidelity.json
npm run dev
```

- [ ] `npm run check` ends with **Tests 364 passed (364)**. The 24 new tests cover:
  - .grd files: a one-gradient file and a 3,397-gradient library read in full (RGB, HSB, CMYK, Lab, grayscale and Pantone stops, foreground/background stops, 435 noise gradients); Photoshop's descriptors read and written byte for byte; every gradient exported and read back the same; preset folders, empty ones too; version 3 files; damaged files refused with a reason
  - colours: HSB, Lab and grayscale to sRGB
  - drawing: Classic straight at 0% smoothness and the gentle S at 100%; midpoints; Catmull-Rom tangents across stops, clamped; Photoshop's half-way values (Classic 128, Linear 188, Perceptual 99); hard edges; opacity; the 4096-entry tables; noise gradients the same every time
  - the library: Basics, importing into a folder per file, notes on what isn't exact, exporting a folder, renaming, moving and deleting
  - the fidelity check's file names and level counting
- [ ] `gradientmapgpu`: Gradient Map on the GPU against its CPU maths, on a 256-level ramp and 16 colours, through each method, midpoints, smoothness 0%, Reverse, Input Range, Offset, Repeat, Mirror, Clamp, Morph, opacity stops, Soft Light / Overlay / Color, Mix and Dither. Expect `"verdict":"pass"`. Each check is given as a share of its allowance (1 = at the limit); the worst was **0.72**. It costs about **0.8 ms** a 4K frame.
- [ ] `gradientui.png`: the test card through a sunset Gradient Map, Effect Controls with its Gradient row, and the Gradient Editor after importing a .grd made by the test (folders Looks › Warm / Cool, and Noise). The import note flags a CMYK stop, a noise gradient and foreground/background stops.
- [ ] `gradientfidelity` says `"verdict":"waiting"` until your Photoshop renders are in (last section). Its `selfCheck` (ginosa's own render judged the same way) must show `"meanLevels":0`.

## Gradient Map

Put a clip (or an adjustment layer) on the timeline and drag **Gradient Map** onto it from Effects › Colour & Light.

- [ ] The picture turns black and white: the default gradient is Black, White.
- [ ] In Effect Controls, click **▾** next to the Gradient swatch and pick **Blue, Red, Yellow** from Basics. Shadows go blue, midtones red, highlights yellow.
- [ ] **Method**: try Classic, Perceptual, Linear and Smooth. Perceptual and Smooth keep the midtones darker and richer; Linear brighter.
- [ ] **Reverse** flips it. **Dither** adds a faint noise you'll only see on smooth gradients over flat areas.
- [ ] **Input Range**: Input Black 30% and Input White 70% push more of the picture to the gradient's ends.
- [ ] **Cycle**: Repeat 4 gives contour bands; Edges Mirror makes them run back and forth. Offset slides the colours. Right-click Offset › Link to Audio…, link it to the bass with Edges on Wrap, and play: the palette cycles with the music.
- [ ] **Morph**: pick a Gradient B (▾ next to it), then keyframe Morph from 0% to 100%. The colours blend from one gradient to the other.
- [ ] **Blend Mode** Soft Light or Overlay, Mix 50%: the Photoshop colour-grade trick.
- [ ] **Use Opacity Stops**: off by default, as Photoshop ignores them. Make a gradient with a transparent stop (next section) and turn it on: the picture shows through at those tones.

## Gradient Editor (⌥⇧5)

Click the Gradient swatch in Effect Controls. The editor opens on that effect's gradient. Every change is one undo step, and keyframes work as for any value.

- [ ] **Import .grd…** and choose one or more of your Photoshop gradient files. Each lands in a folder named after the file, with any folders it had inside. A note lists what can't be shown exactly (CMYK stops, Pantone colours, noise gradients); those swatches have a **!**. Your files aren't changed.
- [ ] Click a swatch to use it. **Search** finds gradients by name across every folder.
- [ ] Colour stops sit under the bar and opacity stops over it. Click under the bar to add a colour stop (it takes the colour already there). Drag a stop to move it, or drag it off the bar to delete it.
- [ ] Select a stop: the diamonds either side are its midpoints. Drag one and watch the half-way point move.
- [ ] Change a stop's colour: R G B, H S B, Hex, or the swatch for the macOS colour picker. Location and (for opacity stops) Opacity are under it.
- [ ] **Duplicate**, **Delete** (a gradient keeps at least two of each kind), **Distribute** and **Reverse**.
- [ ] **Smoothness** 0% gives straight blends; 100% (Photoshop's default) eases through each stop.
- [ ] Type **Noise**: Roughness, Colour Model, the channel ranges, Restrict Colours, Add Transparency and Randomize. These use the same settings as Photoshop's noise gradients, but our own generator, so the colours won't match Photoshop's.
- [ ] **Save to Library…** saves the gradient (and its method) into the folder you're in. **New Folder…**; right-click a folder or gradient to rename, move or delete it.
- [ ] **Export Folder…** (or Export All… from All folders) writes a .grd. In Photoshop: Window › Gradients, the panel menu › **Import Gradients…**, and choose it. The gradients (and folders) should appear and look the same. **Tell me if Photoshop refuses the file or the folders come out wrong.**

## Check against your Photoshop (the done-when)

Make a folder `Reference Materials/Gradients` next to the Ginosa folder. I only ever read what's in it.

1. Copy in the .grd file(s) your test gradients come from. Choose 3 or 4 gradients with several colours.
2. In Photoshop, open `docs/m13/grey-ramp.png` (in the Ginosa folder). If Photoshop asks about a profile, choose sRGB. Keep it RGB, 8 bits.
3. Layer › New Adjustment Layer › **Gradient Map**, pick one of your gradients and set **Method**.
4. File › Export › **Export As…**: PNG, 100%, "Convert to sRGB" ticked. Save it into `Reference Materials/Gradients` named `<gradient name> - <Method>.png`, e.g. `Kiwi - Classic.png`. Use the gradient's name exactly as Photoshop shows it.
5. For each gradient, export **Classic**, **Perceptual**, **Linear** and **Smooth**. For Classic, also do 0% smoothness: in the Gradient Map's editor set Smoothness to 0% and name it `Kiwi - Classic - 0%.png`.
6. Once, open `docs/m13/colour-chart.png`, Gradient Map with **Black, White** and Method **Classic**, and export `Black, White - Classic - chart.png`. (Copy Photoshop's Basics into the folder as a .grd for this one: Gradients panel, select Black, White, panel menu › Export Selected Gradients….) This checks the brightness weights on colours.
7. If you can, save one gradient from Photoshop with Method set to **Perceptual** into a .grd of its own and add it too. It tells us whether Photoshop stores the method in the file.

Then run `npm run snapshot -- --scenario gradientfidelity` and `cat renders/ui/gradientfidelity.json`, or tell me and I'll run it. Each render gets `meanLevels` (the average difference in levels, 0–255) and its worst level. The target is under 1 for Classic, Linear and Perceptual with RGB, HSB, Lab or grayscale stops. Smooth is my best guess until it's fitted to your renders. Expect it to be further off; your renders are what I fit it to.

## Also

- [ ] The title bar says **M13**.
- [ ] The project format hasn't changed (gradients are effect values).
- [ ] No new npm packages. The two test libraries are MIT-licensed (Philip Vieira's `gradient` gem), with their notice in `src/engine/gradients/fixtures/README.md`; DEPENDENCIES.md lists them and the references used.
- [ ] M10–M12's GPU tests ran again after the effect-framework changes and still pass.
- [ ] Next: **Look LUTs** (decision 77), then M14 (Datamosh A).

# M6 · Try this (effects pipeline)

M6 is the effects pipeline:
- effect stacks on clips
- adjustment layers
- Effect Controls generated from each effect's settings
- the Effects Library (⌥9) and presets
- copy/paste of effects
- the first two effects, **Invert** and **Transform**
- all 24 Photoshop blend modes for clips, adjustment layers and every effect

Exports include effects automatically. About 20 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run test-media
npm run snapshot -- --scenario effectsgpu
cat renders/ui/effectsgpu.json | head -5
npm run snapshot -- --scenario exporteffects
cat renders/ui/exporteffects.json
npm run snapshot -- --scenario effectsui
open renders/ui/effectsui.png
npm run dev
```

- [ ] `npm run check` ends with **Tests 209 passed (209)**. New tests cover:
  - the effect registry (every effect folder found and valid)
  - parameters: defaults, clamping, upgrading old versions
  - every stack edit, each one undoable: apply, reorder, on/off, change, reset, remove
  - split, copy/paste and Paste Effects
  - adjustment layers
  - saving and upgrading projects
  - presets (scaled to the clip)
  - the Invert, colour-space and blend-mode maths
- [ ] `effectsgpu` runs the effect pipeline on the GPU with a test image of 10 exact colours and compares every result with the CPU maths. That's 68 checks: every Invert channel and space, all 24 blend modes, Mix, stacking, Transform (move, tile, mirror, rotate, scale) and adjustment layers with opacity, blend mode and effect order. Expect `"verdict":"pass"` with `worst` about 0.003.
- [ ] `exporteffects` is the M6 "done when". It puts Invert on an adjustment layer over five different clips, then reorders, toggles and fades it. Each state is checked in the preview and in an exported file against the CPU maths. Expect `"verdict":"pass"`; I measured 0.002 or better for the preview and 0.0025 or better for the export.
- [ ] `effectsui.png` shows:
  - an adjustment layer (purple, with an **fx** badge) above the clips
  - Effect Controls with its Opacity and two effects
  - the Program monitor with them applied

## Effects

- [ ] **Effects** sits as a tab next to Effect Controls (⌥9). It lists **Presets** and **Video Effects → Colour → Invert, Distort → Transform**, and has a search box.
- [ ] Drag an effect onto a clip in the timeline: the clip outlines purple while you hover, and gets an **fx** badge. Drag onto a *selected* clip and every selected clip gets it. Or select clips and double-click the effect.
- [ ] In **Effect Controls**, each effect has:
  - a grip **⋮⋮** to drag it up or down (order matters: the top one runs first)
  - **fx** to switch it on and off
  - a twisty, **Reset** and **✕**
  - **Mix** (0–100%) and **Blend Mode** (Photoshop's 24, in Photoshop's order), then its own controls
- [ ] Drag an effect from the Effects Library into Effect Controls, between two others.
- [ ] **Invert**:
  - **Amount**
  - **Channel**: RGB, Red, Green, Blue; **Luminance only** (lightness flipped, colour kept); **Hue only** (colours turned 180°); **Chroma only** (colour flipped, lightness kept)
  - **Space**: Display (the Photoshop look) or Linear light (harsher)
- [ ] **Transform**: Position, Scale, Scale Width, Rotation, Anchor Point and Opacity, like Motion. Plus:
  - **Edges**: transparent, repeat, mirror or tile; try Scale 60% with Mirror
  - **Sampling**: smooth, sharp or nearest pixel; try Scale 400% with Nearest for chunky pixels
- [ ] On a clip, Transform works in the clip's own pixels (a 4K clip's middle is 1920, 1080). On an adjustment layer it works in the frame's.
- [ ] Click an effect's header to select it (Shift for more). Then:
  - **⌘C** copies it, **⌘V** pastes it onto the selected clips (also right-click a clip → **Paste Effects**)
  - **Delete** removes it
- [ ] **Save Preset…** saves the selected effects (or the whole stack). It appears under Presets in the Effects Library. Drag it onto clips, or right-click it to rename or delete. Positions scale to the clip: a Transform preset made on 4K fits a 1080p clip.

## Adjustment layers

- [ ] **+ Adjustment** in the timeline toolbar (or File → New Adjustment Layer) puts a 5-second adjustment layer at the playhead, on the first free video track above the clips there. Or right-click an empty part of a video track → **New Adjustment Layer Here**.
- [ ] Its effects apply to everything on the tracks beneath it, for as long as it lasts. Trim, move, split, ripple and dissolve it like any clip. It has **Opacity** and **Blend Mode** but no Motion; use Transform.
- [ ] Double-clicking it shows its effects (it has no source to open).
- [ ] Export something with effects and an adjustment layer: the file matches the Program monitor.

## Your footage

- [ ] Put Invert (Luminance only) on an adjustment layer over a few of your Apple Log clips and play. Watch the timing overlay: tell me the fps and dropped numbers at Full resolution.

## Not yet

- Masks (the Mask control on every effect) come with M9.
- Keyframes for effect values come in M7; audio-driven values in M8.
- More effects arrive from M10, one at a time.

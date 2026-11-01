# M9 · Try this (masks and the temporal engine)

M9 adds three things.

**Shared masks:**
- Shapes: rectangle, ellipse, bezier pen path, edge (in from the frame's edges) and luminance range.
- Shapes combine with add, subtract and intersect.
- Every setting can be keyframed or linked to the music.
- One mask can drive several effects and adjustment layers.
- You drag shapes on the Program monitor. The **Masks** window opens with ⌥⇧3.

**Stateful effects:**
- These are effects that read their own previous frame. **Feedback** is the first one, under Effects › Time.
- A checkpoint is kept every second, so a jump replays at most a second.
- Scrubbing, playback and export all show the same thing.

**Render cache:**
- **Enter** renders the frames that have effects into preview files.
- The ruler shows yellow for frames rendered live and green for cached frames.
- An edit only invalidates the frames it actually changes.
- The **Cache Manager** has a size limit for previews and **Clean Up Finished Project**.

About 40 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario masksgpu
cat renders/ui/masksgpu.json
npm run snapshot -- --scenario exportmasks
cat renders/ui/exportmasks.json
npm run snapshot -- --scenario masksui
open renders/ui/masksui.png
npm run snapshot -- --scenario feedbackgpu
cat renders/ui/feedbackgpu.json
npm run snapshot -- --scenario feedback
cat renders/ui/feedback.json
npm run snapshot -- --scenario cacheui
cat renders/ui/cacheui.json
open renders/ui/cacheui.png
npm run dev
```

- [ ] `npm run check` ends with **Tests 288 passed (288)**. The 25 new tests cover:
  - every mask shape, feather, expansion, the three combine modes, invert and opacity, keyframes and modulation
  - the mask GPU buffer
  - every mask command, references through splits, copy/paste and saving, and opening older projects
  - when a stateful effect's state resets and what throws it away
  - render cache keys: an edit changes exactly the frames it changes, including through feedback
  - preview files and their size limit
- [ ] `masksgpu` checks masks on the GPU against the reference maths, over every pixel. Cases: a rotated rounded rectangle minus an ellipse plus the frame edge; a bezier path intersected with a luminance range; a moved, rotated clip (the mask stays put on the frame); adjustment layers at full and half resolution. Expect `"verdict":"pass"`. I measured a worst of **0.0017** (half-float precision), and a heavy mask at 4K at **23 ms** a frame.
- [ ] `exportmasks`: an adjustment layer inverts inside an edge mask whose Width is keyframed from 40 to 440 px, minus a rectangle sliding down. Expect `"verdict":"pass"`. I measured:
  - every exported frame's band within **0.12 px** of the keyframed width
  - the rectangle hiding the band in 16 frames
  - playback vs export: **0.0013**
- [ ] `masksui.png` shows the Masks window, a pentagon pen path on the Program monitor (gold, one point selected) and the ellipse it subtracts. The same mask is used twice: the adjustment layer inverts inside it, and the clip's own Invert (at 40%) works outside it.
- [ ] `feedbackgpu`: Feedback on the GPU against its reference maths, 24 frames in each mode (worst **0.0032**). It also checks the state store: checkpoints at frames 25 and 50; a jump back to frame 40 replays from frame 26 and matches frame 40 rendered in order **exactly**; a dropped playback frame is marked approximate and never used for an exact frame.
- [ ] `feedback` is the M9 "done when". Feedback (85%) runs on an adjustment layer over a sliding white square. Expect `"verdict":"pass"`. I measured:
  - **exports**: each frame is "this frame over the last at 85%" within **0.0016**
  - **plays**: playback vs export **0.0012**, all 200 frames, none approximate
  - **scrubs**: seven jumps vs the export within **0.0011**. The first jump (to 6 s) replays 150 frames in 0.2 s; later ones replay 0–37 frames.
  - **edits**: after an edit (85% → 60%), the frame matches feedback worked out from the input (**0.0012**)
  - **caches**: Enter renders all 200 frames (**51 fps**). Cached stills and cached playback are within **0.0047** of the export (8-bit JPEG). An edit at 4 s turns exactly frames 101–199 yellow. Rendering again redoes only those 99. Undo turns all 200 green again with nothing rendered.
- [ ] `cacheui` puts Feedback (88%, zoom 101.5%, rotation 0.8°) over the test pattern and renders 1–4 s. On that footage I measured **38 fps** and **0.14 MB** a frame. `cacheui.png` shows the tunnel, and the ruler green to 4 s, then yellow.

## Masks (⌥⇧3)

- [ ] **+ New** › Rectangle (or any shape) makes "Mask 1". Double-click it to rename; right-click to Duplicate or Delete. Deleting a mask makes whatever used it apply everywhere again (undo brings it back).
- [ ] **+ Shape** adds more shapes. Each row has **Add / Subtract / Intersect**, **Invert**, ↑ ↓ to reorder and ✕ to remove.
- [ ] The selected shape's settings each have a stopwatch, ◀ ◆ ▶ and a right-click menu (keyframes, interpolation, Link to Audio, Modulate Parameter):
  - Rectangle: Position, Size, Rotation, Roundness, Feather, Expansion, Opacity
  - Ellipse: the same without Roundness
  - Pen Path: Position, Scale, Rotation, Feather, Expansion, Opacity
  - Edge: Width, Feather, Expansion, Opacity
  - Luminance Range: Low, High, Softness, Opacity
- [ ] **Used by** lists every effect and adjustment layer using the mask. Click one to select it.
- [ ] **Show on monitor**: while the Masks window is open, the selected shape is drawn in gold on the Program monitor (other shapes faintly; a modulated shape's live outline dashed).
  - Rectangle or ellipse: drag the body to move it, the square handles to resize it (Shift keeps the proportions) and the round knob to turn it (Shift: 15° steps).
  - Pen path: drag points; click an edge to add a point there (the curve keeps its shape); ⌥-click a point, or select it and press Delete, to remove it; double-click a point to make it smooth or a corner; drag a bezier handle to bend it (⌥ bends one side only).
  - Edge: drag the dashed line to set Width.
  - With a setting's stopwatch on, a drag adds a keyframe at the playhead.

## Using masks

- [ ] In Effect Controls, every effect has a **Mask** menu: None, any mask, or **New Mask…** (makes one and opens it). **Invert** uses the outside instead; **Edit** opens it.
- [ ] Adjustment layers also have a **Mask** under Opacity: where the whole layer applies.
- [ ] Try the plan's idea: an edge mask on an effect, with **Width → Link to Audio → Bass level**. The edges widen on every bass hit. It plays and exports the same.
- [ ] Mask settings appear in the Modulation window's **Drives** list, like any other value.

## Feedback and stateful effects

- [ ] Put **Feedback** (Effects › Time) on an adjustment layer over moving footage. Try zoom 101–103%, rotation ±1°, and the four modes (Over, Add, Screen, Lighten). Trails and tunnels should play in real time.
- [ ] Jump around the timeline: each frame looks the same as it does in playback. Far into a long layer the first time, you'll see "Stateful effects: catching up N of M frames…" while it renders from the start. After that, a jump replays at most a second.
- [ ] Change a setting: the state starts again from the clip's first frame.
- [ ] Double-click the Program monitor for the stats overlay: **states N MB** is the memory held by kept frames and checkpoints; **approx** counts frames that carried on from an older state after a drop.
- [ ] Export it and compare it with what you saw.

## Render cache

- [ ] The top edge of the ruler is **yellow** where frames have effects and **green** where they're cached.
- [ ] Press **Enter** in the timeline (or click **Render**) to render the yellow frames: in the selected clips, or the whole sequence if nothing is selected. Progress shows in the toolbar; **Stop** (or Escape) keeps what's done.
- [ ] Green stretches play from the previews and show when paused. They're 8-bit JPEGs; export always renders the real thing.
- [ ] Change something: only the frames that change turn yellow. Through Feedback, that's every frame after the change to the end of the layer. Undo: they're green again.
- [ ] **Cache Manager** (Window menu):
  - **Preview renders**: how much previews use, and the limit for all projects (2–200 GB). Past it, the least recently used previews go first.
  - **Clean Up Finished Project** on each project deletes all its cache (thumbnails, waveforms, optimised copies, previews, analysis). Your project file and media aren't touched. Decision 57 asks whether it should also remove autosave snapshots.

## Your footage

- [ ] Put Feedback on an adjustment layer over your Apple Log clips. Tell me the fps and dropped frames, live and from the cache. Also check the preview size per frame (Cache Manager › Preview renders, divided by the frames rendered).
- [ ] Try a luminance-range mask on your footage (an effect only in the highlights, say) and tell me whether Softness feels right.

## Not yet

- Pen path points can't be keyframed (path animation, for rotoscoping). Position, Scale and Rotation can.
- Mask keyframes are set in the Masks window; they don't have rows in the Keyframe Editor yet.
- A mask that follows its clip (instead of staying on the frame), and a whole-clip opacity mask, can come later (decision 51).
- Effects that read other times (Posterize Time, echoes) arrive with Posterize Time in M12. They'll use the same catch-up and checkpoints.
- There are no In/Out points on the timeline yet, so Enter renders the selection or the whole sequence.
- Beat-based resets for stateful effects come with datamosh (M14).

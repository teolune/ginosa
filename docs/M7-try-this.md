# M7 · Try this (keyframes)

M7 is keyframes:
- every value can be animated: Motion, Opacity, Volume, Speed, and every effect setting including Mix
- hold, linear and bezier interpolation, with Premiere's Ease In / Ease Out presets
- the **Keyframe Editor** (⌥0): a dope sheet and a graph with bezier handles
- **speed ramps** (Speed keyframes)
- **volume automation**
- copy/paste of keyframes; presets keep them

Preview and export animate identically. About 25 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run test-media
npm run snapshot -- --scenario exportkeyframes
cat renders/ui/exportkeyframes.json
npm run snapshot -- --scenario keyframesui
open renders/ui/keyframesui.png
npm run snapshot -- --scenario keyframesgraph
open renders/ui/keyframesgraph.png
npm run dev
```

- [ ] `npm run check` ends with **Tests 234 passed (234)**. The 25 new tests cover:
  - the maths: hold, linear, bezier (straight handles = linear), Ease In / Ease Out / Ease In and Out, choices always holding
  - speed ramps: the exact integral, trims that keep the same frames, trim limits, refusals (reversed clips, holds, Speed/Duration on a ramp)
  - every keyframe command, each undoable: stopwatch on/off, ◆, move (onto another replaces it), stretch, interpolation, delete, change, copy/paste
  - keyframes staying with the picture through splits, trims and speed changes
  - effect parameters, Mix and choices; presets scaling keyframed positions
  - the render plan, the volume curve, saving, opening older projects and repairing damaged keyframes
- [ ] `test-media` makes two new files: `square_1080.png` (a white square) and `tone_1khz.wav` (a steady tone).
- [ ] `exportkeyframes` is the M7 "done when". It builds a timeline that animates every kind of value with the same commands your clicks send: Position (eased), Scale, Rotation and Opacity (with a hold) on the square; a speed ramp on the frame-numbered clip; Invert's Amount, Channel and Mix and Transform's Position and Scale on the colour patches, under an adjustment layer fading in; and Volume on the tone. It exports ProRes 4444 and checks four things. Expect `"verdict":"pass"`. I measured:
  - preview vs file, 17,031 points on 18 frames: worst **0.0011** (one 10-bit step is 0.001)
  - the square's edges in all 100 frames vs the keyframes: worst **0.12 px**; brightness vs Opacity: **0.0005**
  - the speed ramp, frame number in every frame: **96 of 96** right in the file and **96 of 96** in real-time playback (0 late)
  - the sound level vs the Volume keyframes in 10 ms windows: worst **under 0.001 dB**
- [ ] `keyframesui.png` shows the Keyframe Editor's dope sheet with the patches clip, the adjustment layer, the ramp and the tone, and Effect Controls with stopwatches. `keyframesgraph.png` shows the square's Position curve with its handles.

## Effect Controls

- [ ] Every value has a stopwatch **⏱**. Put the playhead over a clip and click it: the value is now animated, with a keyframe at the playhead.
- [ ] Move the playhead and change the value: that makes a keyframe there. A whole drag on a value is one undo step.
- [ ] **◀ ◆ ▶** next to an animated value: go to the previous keyframe; add (or remove) a keyframe at the playhead; go to the next.
- [ ] Right-click a value: **Create Keyframes**, **Remove All Keyframes**, **Add/Delete Keyframe at Playhead**, previous/next, **Paste Keyframes Here**, **Show in Keyframe Editor**.
- [ ] Clicking the stopwatch off removes the keyframes and keeps the value at the playhead (⌘Z brings them back).
- [ ] **Time Remapping → Speed**: turn on its stopwatch to ramp the speed (0–10,000%; 0 pauses the picture). The clip's badge says **[Speed ramp]**. One fixed speed is still ⌘R.
- [ ] Effects: Mix and every setting have stopwatches. Choices and on/off settings jump at their keyframes.
- [ ] Clips with keyframes show small diamonds along the bottom of the clip in the timeline.

## Keyframe Editor (⌥0)

- [ ] It shows the selected clips: a row per clip, then a row per animated value. Click a value's name to focus it (that's where ⌘V pastes, and what the graph shows).
- [ ] **Dope Sheet**:
  - drag keyframes in time; they snap to frames always, and to the playhead, markers, clip edges and other keyframes while snapping is on (hold Shift to stop snapping)
  - **Option-drag** stretches the selected keyframes' timing, pinned at the one farthest away
  - drag on empty space to box-select; Shift-click to add
  - diamond = linear, square = hold, circle = bezier
- [ ] **Graph**: the focused value's curve (X blue and Y green for points). Drag a keyframe up/down and sideways (hold Shift to change only the value). Selected bezier keyframes show yellow handles: drag them to shape the curve.
- [ ] The toolbar buttons (and right-click) set the selected keyframes to **Linear, Bezier, Hold, Ease In, Ease Out, Ease In and Out**.
- [ ] **⌘C / ⌘V** copy keyframes and paste them at the playhead onto the focused value, on any clip, as long as it's the same kind (a number onto a number, a point onto a point). **Delete** removes them, **⌘A** selects all, **F** fits.
- [ ] Wheel scrolls rows; Shift-wheel or a sideways swipe scrolls time; ⌥- or ⌘-wheel zooms.
- [ ] Every drag is one undo step, shown in History.

## Keyframes and edits

- [ ] Trim a clip's start: its keyframes stay where they were in the picture.
- [ ] Split a clip: both halves animate exactly as before.
- [ ] Speed/Duration (⌘R) on an animated clip: keyframes keep their place in the picture (at 200% they come twice as soon).
- [ ] Copy an effect with keyframes, or save it as a preset, and apply it to another clip: the keyframes come along (relative to that clip's start).
- [ ] Save, close and reopen: everything is still animated.

## Your footage

- [ ] Ramp the speed of one of your Apple Log clips (for example 100% → 400% → 100%) and play it. Watch the timing overlay and tell me the fps and dropped numbers at Full resolution.
- [ ] Animate Volume on your song (a fade in over 2 s) and listen.

## Not yet

- Snapping keyframes to beats comes with the beat grid in M8.
- Position moves in straight lines between keyframes; curved motion paths drawn in the Program monitor aren't there yet.
- The faint "modulated" curve in the graph comes with audio modulation in M8.

## Decisions to look at

Rows 41–45 in `docs/DECISIONS.md` are new and **Proposed**: how speed ramps treat sound and running out of media, what Reset and the stopwatch do to keyframes, the default interpolation, how keyframe drags and paste behave, and straight-line Position paths. Tell me which you approve or want changed.

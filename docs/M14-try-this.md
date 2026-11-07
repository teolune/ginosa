# M14 · Datamosh A · Try this

**Datamosh** (Effects › Time) is the live GPU datamosh from the plan: one effect whose behaviours can all run at once. It keeps a mosh buffer (its own last frame) and moves its blocks by the footage's motion each frame, as a decoder moves a reference frame's blocks by a P-frame's motion vectors, except the reference is never refreshed. Its modes are built-in presets (Effects › Built-in Presets), not separate effects.

M14's done-when is side-by-side tests on your footage, and your sign-off. Those are below under **Side by side**: your two Apple Log clips cut together, moshed by a real codec (an MPEG-4 file with its keyframe removed) and by Datamosh. They led to two new Codec Character controls, **Residual** and **Intra Blocks**, and the **Codec Mosh** preset. How it all works is in decisions 87–93 (all Proposed). About 40 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario datamoshgpu
cat renders/ui/datamoshgpu.json
npm run snapshot -- --scenario exportmosh
cat renders/ui/exportmosh.json
open renders/ui/exportmosh.png
npm run mosh-reference
open renders/m14/footage
npm run dev
```

- [ ] `npm run check` ends with **Tests 371 passed (371)**. The 3 new tests: motion transfer in the render plan (the source track's clips, as shot, even while hidden; what the state and the render cache depend on), Bass Edge Mosh (its edge mask and bass link, one undo), and Kick Bloom's link.
- [ ] `datamoshgpu`: Datamosh on the GPU, frame after frame, on pictures whose motion is known exactly. Expect `"verdict":"pass"` and `"checked":30`: every block's motion found exactly on frame 1; a moving picture comes out as itself; Speed, Push, Freeze, Leak (even and in blocks), Momentum, Bloom; resets every beat and on the Reset Trigger; a jump to frame 40 equal to frame 40 played in order; Residual following a fade; Intra Blocks on a cut; motion transfer on a clip, on an adjustment layer, from an empty track, and on a clip at half size. `msPerFrame` is the time for a 1080p frame: about **5 ms** with 4 px blocks, **7 ms** with 16 px, **8 ms** with 32 px.
- [ ] `exportmosh`: Datamosh through the whole app, on an adjustment layer over the panning test pattern. Expect `"verdict":"pass"`: two exports identical (`"repeatDifference":0`), the first frame the real picture, playback and jumps within **0.0012** of the export. Then motion transfer: a white square sliding on V3 (hidden) moves the picture instead, playback and jumps within **0.0011** of that export too. `exportmosh.png` shows Datamosh in Effect Controls with **Motion Source: V3 (hidden)**.
- [ ] `npm run mosh-reference` (about a minute) remakes the side-by-side material: the app exports your clips moshed six ways into `renders/export`, then `scripts/codec-mosh.py` makes the real codec moshes, three contact sheets and two side-by-side videos in `renders/m14/footage`. It needs Python 3; if macOS offers to install the command line tools, say yes. Your clips are only read.

## Side by side (the done-when)

Your clips are AppleLog1 (1–4 s) cut to AppleLog2 (2–5 s) at frame 75, 1080p25. The "real codec mosh" is that plain timeline encoded as MPEG-4 Part 2 (no B-frames, one I-frame at the start and one at the cut), with the cut's I-frame removed from the bitstream and decoded back by FFmpeg: the classic datamosh. For bloom, one P-frame is repeated 12 times. This stands in for Engine B (M15) until it exists.

- [ ] Open **`cut-side-by-side.mp4`**: plain, the real codec mosh, Datamosh's **Codec Mosh** preset and **Transition Melt**, from 2 s before the cut.
- [ ] **`cut-sheet.png`**, the same as stills. With Codec Mosh, the old shot breaks into blocks moved by the new shot's motion, the new shot's edges build up over it (black and white where the correction lands on the wrong picture), and it heals in about two seconds, as the real one does. "Reset on Cuts off only" (no Residual, no Intra Blocks) never heals: it smears into a painterly melt instead.
- [ ] **`bloom-sheet.png`** and **`bloom-side-by-side.mp4`**: a real P-frame repeated next to Datamosh's Bloom, both 12 frames from frame 90. The real one heals afterwards (its later frames correct it); Datamosh's Bloom here has no Residual, so it stays moshed. Add Residual and Intra Blocks if you want it to heal.
- [ ] **`modes-sheet.png`**: Freeze & Drift, Fluid, Transition Melt and Codec Mosh on the same clips.
- [ ] **Tell me** what's missing or wrong next to the real thing, or which look you'd want by default. The blocks differ a little: this MPEG-4 encode moves 16 × 16 macroblocks by half pixels; Datamosh moves blocks of the size you pick (16 px by default) by whole pixels, or half pixels in Codec Mosh.

## In the app

- [ ] Put an adjustment layer over a cut (V2 over two clips on V1) and drag **Datamosh** onto it (Effects › Time). Play: the picture holds at the start and is pushed around by the footage's own motion. At the cut it starts again (**Reset on Cuts**).
- [ ] Turn **Reset on Cuts** off: the next shot's motion smears the last shot's picture. The cut's own frame holds, as when a codec's keyframe is removed. Raise **Melt** to make it melt into the new shot over that many frames.
- [ ] **Codec Character** (open the group): **Residual** at 100% adds the footage's own frame-to-frame change, so the new shot's edges ghost in. **Intra Blocks** replaces blocks the motion can't explain with the real frame, so it heals; 50% follows the usual encoder rule, Codec Mosh uses 20%. Also **Vector Rounding**, **Wrong Matches** and **Colour Drift**.
- [ ] **Motion**: Strength, Speed (below 100% drifts slowly), Block Size (4–32 px of a 1080-high picture), Momentum, Smoothing, Push X/Y, Swirl. **Show: Motion** draws each block's motion: red to the right, green down, black for intra blocks.
- [ ] **Hold**: Freeze holds the picture still for that many frames after each reset. Leak lets the real frame back in, evenly or as whole blocks.
- [ ] **Resets**: Reset Every (on the beat grid; with no tempo yet it's 120 BPM from 0, so park this until the beat grid lands), and Reset Trigger, which restarts whenever it rises past 50%: keyframe it, or link it to the audio or a Channel Rack row.
- [ ] **Bloom**: Bloom Trigger repeats the motion of that frame for Bloom Frames. Repeat Motion keeps re-using the last motion all the time.
- [ ] **Motion transfer**: put a clip with strong motion (water, smoke, a dancer) on V3, hide V3 (its eye), and set Datamosh's **Motion Source** to V3. That clip's motion now moves your picture. It's read as shot, without its own effects, even while hidden.
- [ ] **Built-in presets** (Effects › Built-in Presets, drag onto a clip or adjustment layer): **Freeze & Drift**, **Transition Melt**, **Codec Mosh**, **Kick Bloom** (Bloom on each kick: the bass hits, or a Kick row in the Channel Rack), **Fluid**, **Glide**, **Bass Edge Mosh** (a new Edge mask, Strength from the bass).
- [ ] **Scrubbing**: click around the timeline. Each jump catches up from the last checkpoint (one a second), about 0.2 s for a second of 1080p. Playback and export match the frames you see.
- [ ] Datamosh needs the frames in order, so a jump far back can take a moment the first time ("catching up" in the monitor). Render (Enter) caches a section for smooth playback.

## Also

- [ ] **Effect parameters**: a new kind, a video track (Motion Source), shown as a menu of the sequence's video tracks. A preset or pasted effect naming a track that isn't in this sequence uses the picture's own motion.
- [ ] The title bar says **M14**.
- [ ] No new npm packages. `scripts/codec-mosh.py` uses FFmpeg and Python 3 only (recorded in DEPENDENCIES.md).
- [ ] Memory: a 1080p Datamosh keeps about 46 MB per one-second checkpoint (its last frame, the luma pyramid and the motion), so the 2 GB budget holds about 40 seconds of checkpoints for one effect. Beyond that the furthest are dropped, and a jump that far back replays from the nearest one left.
- [ ] M9–M13's GPU, playback and export tests ran again after the effect pipeline changes (kept images between frames, the first pass readable by later passes, the motion source picture) and still pass.

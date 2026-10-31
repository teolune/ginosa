# M4 · Try this (part 1: playback)

M4 part 1 is real playback. It adds:
- sound
- a GPU compositor with Motion (including Scale Width), opacity and 13 blend modes
- Effect Controls
- playback resolution and a timing overlay
- an automated test that measures picture/sound sync

Part 2 adds cross-dissolves, speed/reverse/freeze, and Apple Log / HDR conversion with your LUTs. This checklist takes about 20 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run test-media
npm run sync-test
cat renders/sync/sync.json
npm run snapshot -- --scenario composite
open renders/ui/composite.png
npm run dev
```

- [ ] `npm run check` ends with **Tests 135 passed (135)**. New tests cover:
  - Set to Frame Size for new clips (4K lands at 50%, a portrait clip fits the height)
  - the Motion maths (position, scale, Scale Width, rotation and anchor, there and back)
  - Effect Controls changes, each drag as one undo step
  - what plays at each moment (track eye, solo, mute, volume)
  - upgrading M3 projects
- [ ] `npm run test-media` adds `sync_flash_beep.mp4`: a white frame and a beep at every whole second.
- [ ] `npm run sync-test` opens ginosa for about 10 seconds. It plays that clip and checks:
  - which frame was on screen for every moment
  - where the sound was at that moment
  
  It ends with `[snapshot] sync -> …`.
- [ ] `cat renders/sync/sync.json` shows `"verdict": "pass"`. On this Mac I measured:
  - `frames` ≈ 140 and `dropped` 0
  - `rightFrame.wrong` 0: every presented frame showed the correct picture for its time, and all 6 flashes landed on the right frame
  - `avOffsetMs.p95` under 40: picture and sound within one frame (25 fps) 95% of the time; I saw about 28 ms
  - `clockDriftPpm` within a few dozen: the audio clock and the system clock agree
- [ ] `composite.png` shows the still on V2:
  - shrunk, stretched wider (Scale Width 160%), rotated 12° and blended with **Difference** over V1
  - Effect Controls open on the right with those values, plus the song's Volume at −4.5 dB

## Playback

- [ ] **Space** plays and stops (from the timeline, or anywhere except the Source Monitor). Stopping leaves the playhead where it is.
- [ ] **L** plays; press it again for 2×, 4×, 8×. **J** plays backwards (faster each press). **K** stops.
  - Only 1× has sound.
  - Backwards play decodes each frame on its own, so it's choppy, especially on long-GOP clips.
- [ ] The playhead follows, and the timeline pages along as it moves.
- [ ] Mute, solo or change a clip's Volume while playing. You hear the change straight away.
- [ ] Edit while playing. Playback carries on with the new edit.
- [ ] Under the monitor:
  - frame back / play / frame forward buttons
  - a **resolution** menu (Full, 1/2, 1/4)
  - the **timing overlay** (gauge button, or double-click the picture): fps, dropped frames, render time, and the A/V offset

## Your footage

- [ ] Put a few of your 4K iPhone clips on a 1080p timeline. They arrive **fitted**: Effect Controls shows Scale 50. Push Scale towards 100 to punch in; it stays sharp up to 100 (that's native 4K).
- [ ] Play a stretch of 4K HEVC 10-bit with the overlay on. Tell me the fps and dropped numbers. In M0 the naive player managed about 20 fps on your camera clip; this one decodes in hardware and streams ahead.
- [ ] Log clips still look flat and grey; their conversion is part 2. HDR clips use Chromium's own conversion until then.

## Effect Controls (⌥7, docked next to History)

- [ ] Select a clip:
  - **Motion**: Position, Scale, Scale Width, Rotation, Anchor Point
  - **Opacity** and **Blend Mode**
  - for sound, **Volume** in dB
- [ ] Drag a blue number left or right to change it: **Shift** for faster, **Option** for finer. Click it to type a value.
  - A whole drag is one undo step.
- [ ] **Frame Size** refits Scale. Each section's **Reset** button restores the defaults.
- [ ] Try the blend modes with a clip on V2 over V1: Multiply, Screen, Overlay, Difference and the rest. They follow Photoshop's formulas.
- [ ] Right-click a clip in the timeline for **Set to Frame Size** and **Reset Motion**.

## Not yet (part 2)

- Cross-dissolves; speed, reverse and freeze frame.
- Apple Log / Apple Log 2 / HDR conversion and your `.cube` LUTs.
- Sound in the Source Monitor.

Please drop your Premiere log→Rec.709 LUTs and look LUTs into `Reference Materials`, and send me the `ffprobe` output from the M2 checklist for one Apple Log and one Apple Log 2 clip.

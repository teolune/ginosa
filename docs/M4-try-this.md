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

# M4 · Try this (part 2: speed, dissolves, log footage)

Part 2 adds:
- speed, reverse and frame holds (Speed/Duration, ⌘R)
- cross-dissolves (⌘D)
- Apple Log and Apple Log 2 conversion, and input `.cube` LUTs

About 20 minutes.

## In Terminal (part 2)

New Terminal tab (Cmd+T), not the one running `npm run agent`. One line at a time:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run test-media
npm run speed-test
cat renders/speed/speed.json
npm run snapshot -- --scenario logview
cat renders/ui/logview.json
open renders/ui/logview.png
npm run sync-test
npm run dev
```

- [ ] `npm run check` ends with **Tests 169 passed (169)**. New tests cover:
  - where a clip is in its media at any speed, reversed (the same frames as forwards, backwards) or held
  - Speed/Duration with and without ripple, linked picture and sound together, and trimming fast clips
  - Add Frame Hold, cross-dissolves and fades, transition length limits, splitting and saving
  - Apple Log maths, `.cube` reading and colour detection
- [ ] `npm run test-media` adds:
  - `framecode_h264.mp4`: ten black/white blocks spell out each frame's number
  - `patches_*.mov`: five colour patches tagged like Apple Log, Apple Log 2, HLG and Rec.709
- [ ] `npm run speed-test` opens ginosa for about 15 seconds. It plays forwards, reversed, 200%, a frame hold, reversed 200% and a dissolve, reading each frame's number back off the GPU. Then `cat renders/speed/speed.json` shows `"verdict": "pass"`. On this Mac:
  - `presented` 275 and `dropped` 0
  - every region `wrong` 0 and `late` 0, and all 15 checked dissolve frames a mix of both clips
- [ ] `logview.json`: each clip's worst error against the expected values. I got Apple Log 0.001, Apple Log 2 0, Rec.709 0.008 (out of 1). `logview.png` shows the patches converted.
- [ ] `npm run sync-test` still passes (`cat renders/sync/sync.json`).

## Speed, reverse and frame hold

- [ ] Select a clip and press **⌘R** (or right-click → **Speed/Duration…**):
  - type a **Speed** and the **Duration** follows (and the other way round)
  - **Reverse Speed** plays it backwards
  - **Ripple Edit, Shifting Trailing Clips** moves later clips (and sync-locked tracks) to follow
- [ ] Without ripple, a slower clip stops at the next one, and a faster one leaves a gap.
- [ ] Clips show their speed on the timeline: **[200%]**, **[-100%]** reversed, **[Hold]**. Effect Controls shows it too.
- [ ] Right-click → **Add Frame Hold** holds the frame under the playhead to the end of the clip. Its sound keeps playing. Drag the held part's end out as far as you like.
- [ ] Play a reversed clip of your 4K footage with the timing overlay on. Tell me the fps and dropped numbers.
- Sound at other speeds changes pitch, like tape. Reversed and held sound is silent for now (marked "(silent)").

## Cross-dissolves

- [ ] Select clips and press **⌘D**: each cut between two clips gets a 1 s dissolve centred on the cut, and a free end fades from or to black (or the tracks below).
- [ ] With nothing selected, ⌘D puts one on the cut nearest the playhead.
- [ ] Dissolves draw as a box at the top of the clip:
  - click to select it, then press Delete
  - drag its edge to change its length
  - right-click → **Set Transition Duration…** (timecode, or frames like `15`)
- [ ] A dissolve uses the media past each clip's end. If there isn't any, it holds the last frame.

## Log footage and LUTs

- [ ] Import an **Apple Log** clip (Blackmagic Camera, Apple Log). Right-click it in Media → **Colour**. It should say **Auto (detected): Apple Log**, and the picture should look normal, not flat and grey.
- [ ] Same with an **Apple Log 2** clip. If either is detected wrong, pick the right one from the menu and **send me that clip's `ffprobe` output** so I can fix the detection.
- [ ] Right-click → Colour → **Input LUT…** and choose one of your Premiere log→Rec.709 `.cube` LUTs. It replaces the built-in conversion and is copied into the project's `luts` folder. **Remove Input LUT** goes back.
- [ ] Compare a clip in ginosa and Premiere with the same LUT. They should match closely; tell me if not.
- HDR (HLG/PQ) clips still use Chromium's own tone-mapping. See the note in DECISIONS: fixing that is next.

## Not yet

- Sound and colour conversion in the Source Monitor (next).
- Audio crossfades; Maintain Audio Pitch; reversed sound.

Still waiting: your log→Rec.709 and look LUTs in `Reference Materials`, and the `ffprobe` output for one Apple Log and one Apple Log 2 clip.

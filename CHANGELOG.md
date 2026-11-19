# Changelog

## Doubtful cubes (W4.6, 19 Nov 2026)

- **A pink dot marks a doubtful cube** (decision 126). Only one of its channel's two checks heard most of its hits: the drums' DrumSep without ADTOF, or one of the bass's two ears. Click the dot and a small pop-up opens above the cube, no window. **▶ Listen** plays that moment of the channel's own stem, the drums or the bass on its own. **Keep** takes the dot away, and **Delete** removes the cube; both undo. Clicking elsewhere or Esc closes it.
- **Your answers build answer keys.** Each Keep and Delete is saved in `media/bench/answers/` (one file per song), and the detection bench lists them for that song (`yourAnswers`). That's how your own songs start to get scores without exporting anything.
- **Detect counts its stages**: *Step 1 of 3: Separating the song…*, *Step 2 of 3: Transcribing the drums hit by hit…*, and so on.
- On the test drums, Detect dots 14 Bass cubes (their "bass" is the kick's low thump, which only one ear calls a note) and no drum cubes. Listen plays 0.62 s of the drums stem at a Kick cube, and the sound is there. The interface test marks two cubes, keeps one, deletes the other through the pop-up, and undoes it all.
- **Detection (W4) is complete:** separation (W4.2), drums hit by hit (W4.3), bass notes (W4.4), the grid (W4.5) and these marks (W4.6). What's left is your songs' answers: the dots and the MIDI from your DAW whenever you can.

## Bass notes (W4.4, 19 Nov 2026)

- **The Bass channel hears notes** once detection is set up (decision 125). Two ears listen to the bass stem: where it gets louder, and Basic Pitch, Spotify's note transcriber. A note both hear counts; one only one of them hears counts when it's strong. So a slide or a new note without a fresh attack is caught, and a wobble in level isn't counted as a note. The rack's top bar says *Hearing the bass note by note…*; it takes 2–3 s a song, once.
- **Measured on bass notes known exactly** (BabySlakh: songs made from MIDI with sampled instruments, so every note's start is known):

  | The Bass channel listening to | 8 songs in the lab, ±30 ms | ±50 ms | 3 of them in the app, ±30 ms |
  | --- | --- | --- | --- |
  | Bands of the whole mix | | | 0.20 |
  | The bass stem's band (W4.2) | | | 0.65 |
  | Where the bass stem gets louder | 0.75 | 0.86 | |
  | **Both ears** | **0.81** | **0.91** | **0.80** |

  The target is 0.90. At ±50 ms, the usual tolerance for notes, it's met. At ±30 ms it isn't, partly because two of the songs' sampled basses sound 20–40 ms after their MIDI notes. I've proposed judging bass at ±50 ms (decision 125): a 16th at your 167 BPM is 90 ms, so 50 ms never moves a cube.
- **Found on the way: songs sampled below 32 kHz.** The drum transcriber hears no hi-hats in them (BabySlakh is 16 kHz: 0 found), so their hi-hats now come from the drums stem's band (0.66 there). Your songs are 44.1/48 kHz and aren't affected.
- **The detection bench has three BabySlakh songs** with their bass and drums from the MIDI, so it now scores Bass too. With them in, Clap reaches 0.91 on BabySlakh's songs; STAR's handclaps keep its total at 0.84.
- **Setup** installs Basic Pitch 0.4.0 with ONNX Runtime (about 40 MB), and its test now hears the test song's bass. `npm run bench-media` also downloads BabySlakh (883 MB, CC BY 4.0) into `media/bench`.
- **Detection lab**: `w44-prepare`, `w44-score`, `w44-diagnose`, `w44-combos`, `w44-tune` (thresholds chosen on seven songs, scored on the eighth), `bass-app` (Detect's own bass ear) and `w44-bench-keys`.

## Tempo and bar 1 from the song (W4.5, 18 Nov 2026)

- **The sparkles listen to the song on A1 with Beat This!** once detection is set up (decision 123). Beat This! is a beat and downbeat tracker (ISMIR 2024, MIT). It lists the song's beats and bar lines, and ginosa lays one steady tempo through them. Tempos under 90 BPM are counted twice as fast, as your DAW counts your songs (167, where Beat This! hears 83.5). Bar 1 is the first bar line where the music starts, so silence at the start doesn't push it into the silence. A song cut mid-bar starts at its first whole bar. Without a song on A1, the sparkles listen to the mix as before.
- **Fixed: the sparkles pressed right after placing a song** (within 0.6 s) gave it the tempo of what was there before. The test bench did this, and it's why I told you on 15 Nov that the sparkles got your songs wrong: they don't.
- **Measured** (BPM, then bar 1 in seconds; your songs' answers from you: 167 and 162, bar 1 at the start of your export):

  | Song | The mix (as before) | Beat This! |
  | --- | --- | --- |
  | `dpackdist` | 167.001, 0.015 | 166.988, 0.009 |
  | `entrust` | 161.999, 0.009 | 161.952, −0.012 |
  | STAR ismir_0443 | 162.06, a beat off (snares on 1 and 3) | 162.01, snares on 2 and 4 |
  | STAR ismir_0445 | **70.05** | 210.06 |
  | STAR Music_Delta | 109.94, bar 1 two beats in | 110.06, bar 1 at the start |
  | STAR 1327741 (triplet feel) | 135.99, kick on 1 | 136.01, a beat early |

  On 18 copies of your songs and the test drums, cut by 1, 2, 3 and 6 beats or delayed by 1.3 s of silence, Beat This! put bar 1 right every time. It takes under half a second a song on the M5's GPU (once it's loaded, about 3 s).
- **Not built, measured as not needed yet:** nudge and swing suggestions per channel. On your songs the hits sit 2–9 ms from Beat This!'s grid, with no swing. Also not built: checking bar 1 against the drums when Beat This! is unsure. Only STAR's triplet-feel song needed that.
- **Setup** installs Beat This! 1.1.0 and its 81 MB model into `.stems/` (the Cache window lists it), and its test now finds the test song's beats too.
- **The performance slider is planned** as M18 (decision 124; it replaces decision 114). It goes in the plan doc's milestone list with your six steps; I swapped the frame rates at steps 4 and 5 so each step up is cheaper, and added settings at steps 2, 3 and Performance Mode. It needs your hex colours.
- **Detection lab**: `w45-beats`, `w45-grids` (each song's grid and how many drum hits sit on it), `w45-bar-one` (the cut and delayed copies) and `w45-phases` (the hits' offsets from the grid).

## Drums transcribed hit by hit (W4.3, 15 Nov 2026)

- **Detect transcribes the drums** once the song is separated (decision 122): ADTOF, a drum transcriber trained on real recordings, lists the kick, snare and hi-hat hits in the drums stem, and DrumSep splits the drums stem into kick, snare, toms, hi-hat, ride and crash, whose strong onsets add the hits ADTOF missed. The rack's top bar says *Transcribing the drums hit by hit…*. Bass is unchanged (W4.4).
- **What it changed** (the four STAR Drums songs, F-measure within ±30 ms; targets 0.95, 0.90, 0.85):

  | Detect listening to | Kick | Snare and clap | Hi-hat |
  | --- | --- | --- | --- |
  | Bands of the whole mix | 0.49 | 0.21 | 0.68 |
  | Bands of BS-RoFormer-SW's drums | 0.89 | 0.49 | 0.87 |
  | **The drum transcriber** | **0.99** | **0.84** | **0.92** |

  Kick and hi-hat pass. Snares alone score 0.96; what's left is handclaps, which neither model knows (ADTOF found 3 of STAR's 33). On your songs, the extra claps DrumSep adds land on the beats where ADTOF's claps are, completing the pattern, so they look real; I can't score them until your songs have answers.
- **DrumSep only adds hits when it agrees with ADTOF** about what it hears (at least 40% of its onsets at ADTOF's hits are its own kind). STAR's pieces agree 0.80–1.00 and keep everything; on the generated test drums, whose snare and hi-hats are both white noise, the snare piece agrees 0.35 and adds nothing (claps 0.48 → 0.93 there, and `rackdetect` passes again). On your songs the pieces agree 0.50–1.00.
- **Speed**: 13–16 s for your songs on top of separation, once (the hits are kept beside the stems in the project's cache; DrumSep's pieces are let go of after).
- **Setup** (`npm run stems-setup`, or Set Up in the Cache window) installs ADTOF, librosa and pretty_midi and downloads DrumSep (440 MB, kept as its 437 MB MLX copy with the checkpoint an empty placeholder), then tests the transcriber on the test song.
- ~~Found on the way: the tempo is wrong on both your songs~~ **Corrected 18 Nov:** that was the bench's bug, not the sparkles'. The bench pressed them less than 0.6 s after placing each song, so each song got the previous song's tempo. Measured properly, the sparkles find 167 and 162 on your songs, as your DAW has them (see W4.5).
- **Detection lab**: `w43-prepare`, `w43-score <gate>` (ADTOF, DrumSep's onsets, both, either), `w43-claps`, `w43-dominance` and `listen <song>` (Detect's own transcriber, timed).

## A better separator, measured (W4.2, 14 Nov 2026)

- **Detect separates with BS-RoFormer-SW first** (through mlx-audio-separator on MLX): six stems (vocals, drums, bass, guitar, piano, other), about 2.6–2.9 dB cleaner drums and bass than Demucs on MVSEP's test set. Demucs stays as the fallback. Your 2-minute song takes about 25 s instead of 5 s, once (stems are cached per song).
- **What it changed, honestly** (the four STAR Drums songs, F-measure within ±30 ms):

  | Detect listening to | Kick | Snare and clap | Hi-hat |
  | --- | --- | --- | --- |
  | Bands of the whole mix | 0.49 | 0.21 | 0.68 |
  | Demucs stems | 0.90 | 0.47 | 0.85 |
  | BS-RoFormer-SW stems | 0.89 | 0.49 | 0.87 |

  About +0.01 overall: with today's way of finding hits (level jumps in a band of the drums), the separator isn't what holds it back. W4.3's drum transcriber is. BS-RoFormer-SW stays first because its cleaner stems should count for more once the transcriber listens to them.
- **On your M5**, MLX runs the model in its faster TF32 maths; full float32 changes your song's drums by 42.6 dB below their level (bass 63.6, vocals 44.4) and takes 41 s instead of 27, so the faster maths stays.
- **Setup** (`npm run stems-setup`, or Set Up in the Cache window) installs it all: mlx-audio-separator, PyTorch (to convert the model once; W4.3 needs it too) and the model, about 2 GB in `.stems/` with Demucs. The model's 700 MB original checkpoint is kept as an empty placeholder once converted (only the converted copy is used).
- Found on the way: BS-RoFormer-SW refuses mono files. ginosa always hands it stereo; the setup's test now does too.
- **Detection lab** (`npm run detect-lab`): `pip-install` (a short list of packages), `tool`, `separate` (a bench song with any model, timed) and `compare` (two separations, stem by stem).

## Your GINOSA logo on the title screen (14 Nov 2026)

- **The title screen shows your new logo** (decision 121): the 8-bit clef and the pixel letters "inosa" from `GINOSA(blacklogo).png`, pixel for pixel, in the mark's lavender (the screen is dark). Each clef pixel is 7 screen pixels and each letter pixel 5, which keeps your file's proportion to within 1% with every edge sharp.
- **The title bar (top left) shows it too**, at 40 points: the smallest size where the letters stay sharp, one screen pixel each. The title bar is 6 points taller (44) to hold it, and the window's buttons moved down to stay centred.
- `assets/logo/ginosa-letters.txt` holds the letters as you drew them (each letter on its own grid); `scripts/make-logo.py` builds the logo from it and the clef, also as `assets/logo/ginosa-title.svg`.

## Detection bench, started (W4.1, 14 Nov 2026)

Your answers to the W4 plan are decisions 117–120 (licences approved, no acapella, downloads deletable, targets as the floor).

- **The detection bench** (`detectbench`): runs Detect on songs whose hits are known and scores each channel: how many real hits it found and how many it found that aren't there, within ±30 ms (the F-measure, 1.0 perfect). It runs with bands of the whole song and, once stem separation is set up, with stems. Your two songs in Reference Materials (`dpackdist.wav`, `entrust(nov11).wav`) run too (only read); until they have answers, they're counted only.
- **The Cache window lists the detection models** (`.stems/`, decision 119) with their size, **Delete Detection Models** and **Set Up**, which downloads them again. Each project's separated stems are now their own line in its cache, so they can be cleared on their own.
- **New runner tasks** (restart `npm run agent` once): `stems-setup`, `bench-media` (the STAR Drums preview, real songs with exact drum hits) and `detect-lab` (trying models on this Mac).
- Detect reports its hits' times before snapping, and can be told to listen by bands or by stems (for the bench).
- **Stem separation is set up on your Mac.** Your Python is 3.15, which MLX's audio package doesn't support yet, so `stems-setup` now fetches a private Python 3.12 into `.stems/` (nothing outside it changes; a first try left a `python3.12` link in `~/.local/bin`, which the setup has removed). About 560 MB in all, listed and deletable in the Cache window.
- **The baseline** (the four STAR Drums songs, F-measure within ±30 ms; targets 0.95 / 0.90 / 0.85):

  | Detect listening to | Kick | Snare and clap | Hi-hat |
  | --- | --- | --- | --- |
  | Bands of the whole mix (what your songs got until now) | 0.49 | 0.21 | 0.67 |
  | Demucs stems (now set up) | 0.90 | 0.47 | 0.85 |

  Separating first already doubles the kick score. Snares and claps are the weak spot: 175 found that aren't there against 97 real ones, as the 1.5–5 kHz band of the drums also catches hi-hats, toms and cymbals. That's what W4.3's drum transcriber is for.
- **Tests:** hit scoring (4 new unit tests, 406 in all); `cacheui` passes.

## Detected sections are 8 bars (14 Nov 2026)

- **Automatic Detection splits the song into 8-bar sections** (decision 116), like a section you add yourself, instead of a new section wherever the pattern seemed to change (on a whole mix that was often every 2 bars). Each section's loop keeps the cubes hit in at least half of its four 2-bar stretches, so a stray or missed hit doesn't change it.

## Heavy conditions (12 Nov 2026)

From the code review (performance, and staying up under heavy use; `docs/Heavy-conditions-try-this.md`). Each fix has a test that showed the problem first (`heavy`):

- **Edits while playing carry on playing** (decision 115, proposed). Clicking cubes, changing an effect's value, Motion, a mask or a track's mute used to start playback again, with a full catch-up first: 5 restarts and 2 catch-ups for a few cube clicks in the test. Now playback just carries on. Stateful effects carry on from the state they had, and are exact again once you pause. A Volume the Channel Rack moves follows the new cubes at once, on the clip playing and the next. Edits that move or change a sound, or move or retime a picture, still start playback again from where it was.
- **More than 12 files at once**: ginosa keeps 12 files open and closed the oldest, even while it was being read, so a 13th sound in a mixdown or playback went silent. Now a file being read stays open, and only idle ones close.
- **The graphics card resetting** (its memory running out, say) left a black monitor until you restarted ginosa. Now the picture starts again on its own, playback carries on, and a message says so.
- **Big photos and montages**: decoded photos were kept forever, so a montage of large photos ran the Mac out of memory, and a picture wider than 8192 px failed. Now photos are kept within 384 MB decoded and 1 GB on the GPU (the least recently used go, never one just shown), and pictures larger than the GPU allows are scaled down to fit (16384 px on your Mac). Each export and render to cache also let go of its photos and LUTs on the GPU.
- **Long Datamosh exports** kept a state every second they never used, up to 2 GB. Now an export keeps only the frame before: 87 MB at 1080p instead of 392 MB for 8 s.
- **A stuck catch-up** (a decoder that stops) held up every catch-up after it, and Play, for good. Now a newer catch-up, Play, Pause or a jump goes ahead after 2 s. A catch-up stuck on its own gives up after 15 s, says so, and shows the nearest state as a preview.
- Also fixed on the way: Stop while Play was still starting could leave a file held or the sound playing; a catch-up's decoders, kept for the next one, now go after 10 s idle.
- **Test:** `heavy` (about 45 s; makes its media with `npm run test-media`); one new unit test (402 in all).

## Catching up after edits (12 Nov 2026)

From your recording (Datamosh on a 4K clip, Channel Rack edits, "catching up" for most of a minute while playback crawled):

- **An edit only redoes what it changed.** A Channel Rack edit used to throw away every kept Datamosh (or Feedback) state, so the next play replayed from the clip's start. Now the states before the edited section stay: on your Apple Log clips, a cube edit followed by a still or Play redoes 34 frames (1.4 s) instead of 274 (8.9 s), with an identical picture.
- **Play no longer runs over itself.** Play, Pause, Play quickly, or an edit while playing, used to leave two catch-ups and two playbacks fighting over the GPU (16 fps afterwards in the test, about 6 in your recording). Now one catch-up runs at a time, the older one stops, and playback runs at 25 fps.
- **Pause while it's catching up** leaves the playhead where you pressed Play (it used to run on while nothing was shown).
- **Nothing lost when a catch-up is interrupted**: it carries on from where it got, not from the last checkpoint; curves rebuilt the same no longer interrupt it at all.
- **Faster in general**: the GPU is kept busy between batches. Your 4K clips cost about 27 ms a frame to catch up at Full, 15 ms at 1/2 (decision 114 proposes running effects at the clip's shown size, for about the 1/2 speed at full quality).
- **Test:** `catchup4k` on your Apple Log clips (only read); one new unit test (401 in all).

## The 8-bit clef mark (11 Nov 2026)

- **ginosa's mark is your 8-bit treble clef** (decision 113), in place of the G: in the title bar, on the title screen and in the Dock. It's your high-res file's pixel grid, kept pixel for pixel (`assets/logo/ginosa-clef.txt`), so every pixel lands on whole screen pixels and stays sharp. It's in your Icon Composer lavender, in Display P3 like your file.
- **The Dock icon** follows your Icon Composer file: its purple gradient, the clef at its size and place, a light upper edge and a soft shadow standing in for Apple's glass.
- **`assets/logo/Ginosa.icon`**: an Icon Composer file with your settings and the clef as a vector layer. Open it in Icon Composer to see Apple's own Liquid Glass rendering; it's also what a packaged ginosa would use.
- `scripts/make-logo.py` remakes the vector, the Dock icon and the Icon Composer file from the pixel grid.

## Channel Rack (11 Nov 2026)

From your illustration (decisions 105–112; `docs/Channel-Rack-try-this.md`):

- **Sections**: A, B, C… along the song from bar 1, each 1–16 bars (8 by default) with its own cubes and amounts. Click one to show it, double-click to change its bars; **+** adds an empty 8-bar section after it; **Follow** shows the section under the playhead.
- **Cubes**: each a 16th; a channel's cubes are a 2-bar loop repeated through its section. Evenly spaced keys raised out of the console, each beat's four in alternating shades, as in your reference. Click to make or select one, drag to paint, Backspace deletes; Cmd+C/V copy and paste cubes; Cmd+Opt+C/V copy one cube's amounts to others (in the next section, say).
- **Cube window** (double-click a cube): one slider per value linked to its channel, −100% to +100%: how far this hit moves it, up or down. Nothing else is set there.
- **Channels**: the light (on/off), the left/right knob (nudge, up to half a 16th either way), the volume knob (strength, 0–150%). Rename, swing, its modulator, order and delete on right-click.
- **Linking**: click a channel's name and press R, then click the sockets beside values in Effect Controls (R or Esc ends); or drag a channel's name onto a value; or right-click a value › Link to Channel. The link's settings (adds or multiplies, how far at 100%, the fall) are under the value in Effect Controls.
- **Automatic Detection** (the rack's sparkles): fills Kick, Clap, Hi-hat and Bass from the song on A1 and splits the song into sections where the pattern changes. With stem separation set up (`npm run stems-setup`, once) it first separates the song into drums, bass, vocals and the rest, on this Mac (demucs-mlx); without it, it listens to bands of the whole song and says so. Each channel only counts hits that stand out in its band, so hi-hats no longer fill the Clap row. Undo brings back what was there.
- **A1 is the song's track**: an empty A1 says *Drop the song here*.
- **Hits land where they start**: hi-hats and other high hits could be pulled up to 35 ms early by a kick's or bass's tail; cached analyses are redone once.
- **Tests:** `rackui` (link mode, dragging a channel, clicking and deleting cubes, cube amounts in playback), `rackdetect` (detection end to end, by stems or bands); new unit tests (400 in all).

## The new ginosa mark (11 Nov 2026)

- **Your GinosaG sketch as a vector** (`assets/logo/ginosa-logo.svg`, decision 104): traced, then redrawn with natural curves: 16 curves with nodes only at the extremes (level or plumb handles), curvature flowing on across every node and changing evenly along each curve, so the sketch's bumps and flat spots are gone and the hook ends in a round ball. A straight stem at 8.1° with both cuts parallel to it and two equal channels. It's in the title bar and on the title screen, in light purple.
- **Dock icon**: the mark on a dark rounded square (`assets/logo/ginosa-icon.png`) while ginosa runs, instead of Electron's.
- **The media column's header** no longer squeezes its Media | Folder tabs in a narrow column: the tabs and buttons keep their size and the search box shrinks, then hides below about 340 px.

## Wireframe phase 1: look, title screen, layout, Control Panel (11 Nov 2026)

From your wireframes (decisions 94–103):

- **The look**: near-black violet with purple accents (#0e0c12, #271170, #bb91fa) everywhere, including the timeline, Keyframe Editor and analysis views. Rounded panels with gaps that are also the resize handles. Adjustment layers are now rose, so they stand apart from the purple video clips.
- **Title screen**: the ginosa mark; **New Project** with 1080p / 4K / Custom Resolution, a 16:9 ↔ 9:16 switch, Custom Ratio (4:5, 1:1, 2.39:1…) and a frame-rate menu, then **Create**; **Recent** with each project's Date Created.
- **Layout**: the **Control Panel** across the top; media | preview with the timeline under both; **Effect Controls | Add Effects** at full height on the right. Tool windows still float. Your saved layout moved over once (History closed, floating windows unchanged).
- **Frames**: Auto (follows the sequence's shape), Landscape or Portrait. Portrait is the mobile wireframe: media | effects, the timeline under both, a tall preview on the right with its tools above and the transport below.
- **Control Panel**: a tempo knob (drag, scroll or type, up to 999.999 BPM), Automatic Detection, ×2 / ÷2, back to start, Play/Pause, Stop (back to where Play started; again for the start), skip to end, New Adjustment Layer at the playhead, Channel Rack, Import Folder (the media column), Full-screen Preview, Metronome (clicks on the beat grid while playing) and Frames, plus the timecode with bar.beat. Automate BPM and New Automation Clip are there but greyed out until automation clips.
- **Folder browser**: Media | Folder tabs in the media column. Open a folder, go in and out, double-click or select and Import; Import Folder brings everything in as a bin. Read only: nothing in the folder is copied or changed.
- **The preview keeps its picture's shape** in any column (a 16:9 picture in the tall portrait column used to be squeezed).
- **Tests:** `controlpanel` (detection, the knob's range, ×2/÷2, every metronome click against the grid, Play/Pause/Stop, the adjustment layer, frames, the media column, the folder listing); 16 new unit tests (392 in all).

## Effect stacks: faster to add, edit and move around (11 Nov 2026)

Measured with a stack of 10 effects on an adjustment layer (Feedback and Datamosh at the top of it) over clips with Basic Correction and Grain:

- **Adding an effect shows at once.** Every effect's shaders are compiled in the background when the app opens (19 shaders in about 65 ms, on several cores), and shared by the monitor, export and the render cache. Adding Datamosh used to freeze the monitor for 2.5 s; now it shows in 8 ms.
- **Previews while you edit beneath Feedback or Datamosh.** Those effects need every frame before the one you see. After an edit beneath them, the monitor used to work all those frames out first, freezing for up to 1.3 s on every step of a slider. Now it shows a preview at once from the state there is, and works out the exact frame a quarter of a second after you stop, in the background, a few frames at a time so the app keeps drawing. Dragging a value: 196 ms a frame on average → 35.
- **Catching up skips what doesn't change the state**: effects after the last stateful one, and layers above.
- **Selecting clips no longer redraws the monitor** (60 redraws in 60 clicks → none).
- **Effect Controls** redraws only the effect that changed, not the whole stack.
- **The render cache** re-checks its frames once edits pause, not during a drag.
- **Tests:** `effectsperf` (adding each effect, selecting, dragging a value, stepping, catching up, each effect's GPU time, playback); 1 new unit test (376 in all).

## Timeline speed and zoomable waveforms (7 Nov 2026)

- **Zooming and scrolling the timeline no longer re-render the Program monitor** (and the other windows). Before, every step of a pinch redrew the paused frame: with your 4K Apple Log clips, 36 renders during one pinch and a 150 ms stall. Now none.
- **Stepping and scrubbing are quicker on long-GOP footage** (iPhone HEVC has a keyframe about every second): a paused frame decodes on from the one before instead of seeking back to the keyframe each time. Stepping a frame at a time over your clips now shows 104 of 120 frames (was 21), at most 17.5 ms apart for 95% of them (was 100 ms).
- **Windows that show values at the playhead** (Effect Controls, Modulation, Channel Rack, Masks, Audio Analysis) refresh 10 times a second while it moves, not every frame. The Effects Library and Gradient Editor don't refresh for it at all.
- **Waveforms get more detailed as you zoom in**: peaks for every 10 samples of a 48 kHz mix (4,800 a second, was 100), so at the closest zoom each screen pixel has its own and you see the kick's cycles. Coarser copies keep zoomed-out drawing quick (about 0.4 ms for the whole timeline). Waveforms are made again the first time each one shows (the cache’s old ones aren’t used).
- **`npm start`** opens the app as it really runs; `npm run dev` adds React's development checks and live reload, so use `npm start` for editing.
- **Tests:**
  - `timelineperf` and `timelineperf4k` (with your Apple Log clips): a pinch, a scroll and frame steps, timed by the screen's frames, with the timeline's drawing time, the monitor's renders and 4 s of playback (25 fps with Datamosh, nothing dropped)
  - `waveformzoom` and `waveformzoom2`: the song's waveform at 2400 and 120 px a second
  - 4 new unit tests for the waveform peaks (375 in all)

## M14 · Datamosh A (7 Nov 2026)

- **Datamosh** (Effects › Time): a live GPU datamosh on any clip or adjustment layer. A mosh buffer is pushed around by the footage's own motion, found by codec-style block matching, coarse to fine, about 5–8 ms a 1080p frame.
  - **Motion**: Strength, Speed, Block Size (4–32 px), Momentum, Smoothing, Push X/Y, Swirl, and **Motion Source**: another video track whose clips' motion moves this picture (motion transfer), read as shot, even while the track is hidden.
  - **Hold**: Freeze, Leak (even or in blocks), Melt.
  - **Resets**: at the start, on cuts beneath an adjustment layer (or off, for a melt: the cut's frame holds, as with a removed keyframe), every n beats or bars, and the Reset Trigger (link it to a kick).
  - **Bloom**: Repeat Motion, and a Bloom Trigger that repeats one frame's motion for Bloom Frames.
  - **Codec Character**: Vector Rounding, Wrong Matches, Colour Drift, and, after the side-by-side tests, **Residual** (the footage's frame-to-frame change added, as a P-frame adds it) and **Intra Blocks** (blocks the motion can't explain refreshed, as an encoder does).
  - **Show: Motion** draws each block's motion.
- **Built-in presets** for the modes: Freeze & Drift, Transition Melt, Codec Mosh, Kick Bloom, Fluid, Glide, Bass Edge Mosh (with its own Edge mask). Built-in presets can now bring a mask.
- **Side by side on your footage**: `npm run mosh-reference` moshes your two Apple Log clips with Datamosh and with a real MPEG-4 bitstream edit (`scripts/codec-mosh.py`: an I-frame removed, a P-frame repeated), into contact sheets and videos.
- **Effect framework**: passes can keep images with the effect's state (read on the next frame, kept in checkpoints), later passes can read the first pass, effects can read another track's picture (a track parameter), and stateful effects know the frames since the latest cut.
- The title bar says M14.
- **Tests:**
  - Datamosh on the GPU, 30 checks: motion found exactly, every control, resets, Residual, Intra Blocks, motion transfer (clip, adjustment layer, empty track, half size), a jump equal to playing in order, and its speed
  - through the app: two exports identical, playback and jumps against the export, and motion transfer from a hidden track
  - 3 new unit tests (371 in all)

## Transport (7 Nov 2026)

- **Go to start** and **Go to end** buttons either side of the frame-step buttons under the Program monitor (Home and End, as before).

## Look LUTs (7 Nov 2026)

- **Look LUT** (Effects › Colour & Light): a .cube look (3D or 1D) on any clip or adjustment layer, with **Strength** 0–200%, as Lumetri's Creative Look. Pick from the project's LUTs or Choose .cube… (copied into the project's `luts` folder).
- Export and render-to-cache wait for every LUT before the first frame.
- **Fixed:** LUT colours just under 0.5, 0.125 or 2 came out halved on the GPU (dark specks), since M4. That includes Input LUTs for log footage.
- .cube files: 1D LUTs up to 65,536 entries (was 256), as Adobe's spec allows.
- **Tests:**
  - the GPU against the CPU maths with made-up LUTs (3D, 1D, another domain) and all 40 of your Look LUTs (worst 0.37 of the allowance)
  - export with a look from the very first frame
  - 4 new unit tests (368 in all)

## M13 · Gradient Map

- **Gradient Map** (Effects › Colour & Light), as Photoshop's: the picture's tones mapped to a gradient's colours, using Photoshop's brightness weights.
  - Method: Classic, Perceptual, Linear or Smooth. Reverse, Dither.
  - Beyond Photoshop: Input Range, Offset and Repeat with Wrap / Mirror / Clamp (palette cycling, contour bands), Gradient B with Morph, and Use Opacity Stops (Photoshop ignores them).
  - Any blend mode: Soft Light, Overlay and Color work as in Photoshop.
- **Photoshop gradient libraries (.grd)**: versions 5 and 3, every colour model, noise gradients and preset folders, read and written. Stops in HSB, Lab, CMYK or book colours keep their model through export. What can't be shown exactly (CMYK, book colours, noise) is flagged.
- **Gradient Editor** (⌥⇧5): the library (folders, search, Import .grd…, Export, New Folder, Save to Library…), then the gradient: opacity stops over the bar, colour stops under it, midpoint diamonds, add / drag / drag-off-to-delete, Duplicate, Distribute, Reverse, colour as RGB, HSB, hex or the system picker; noise gradient settings.
- **Effect Controls**: gradient swatches. Click one to edit it in the Gradient Editor, or ▾ to pick from the library.
- **Gradient library**, shared by every project, starting with Basics.
- **Photoshop fidelity check** (`gradientfidelity`), with a grey ramp and colour chart to render in Photoshop.
- **Effect parameters**: gradients (stored as text, keyframes hold, baked to tables for the shader).
- **Tests:**
  - both test libraries read in full (3,397 gradients), descriptors byte for byte, every gradient written and read back the same
  - Classic, Linear and Perceptual against Photoshop's measured half-way values; midpoints, Catmull-Rom tangents and clamping; noise gradients
  - the library: import, folders, export
  - the GPU against the reference on a 256-level ramp and 16 colours, through 23 cases (worst 0.72 of its allowance)
  - 24 new unit tests (364 in all)

## Basic Correction version 2 (4 Nov 2026)

- **Temperature** now follows the colour of real light, and is about three times stronger: +100 is a full orange (CTO) gel, about 3,500 K; −100 a full blue (CTB) gel.
- **Tint** ±100 is a full minus-green or plus-green gel (one stop).
- **Highlights / Shadows** reach about 2½ times further, and the tone curve still never turns back on itself; **Whites / Blacks** reach 2½ times further.
- Projects and presets made before this are converted (values, keyframes and modulation), so they look the same.
- Effects can now change the scale of a control between versions (`migrateValue`).

## M12 · Posterize Time and the Channel Rack

- **Posterize Time** (Effects › Time): the picture holds between updates on the beat grid.
  - Rate is a detented knob from 1/1 to 1/32, with dotted and triplet values; its readout shows the note and frame rate. Free mode gives a plain frame rate instead.
  - Its own BPM, Phase, Swing, Sample (start or middle of each hold) and Reset on Cuts.
  - Every update lands on the frame nearest its musical time, so holds never drift.
  - On a clip, it holds the picture and the effects above it (Motion keeps moving). On an adjustment layer, it holds everything beneath.
  - Rate keyframes hold; modulation moves it by whole steps.
- **Channel Rack** (⌥⇧4), after FL Studio's:
  - Rows with a light, Swing, name and 16th-note steps on the beat grid through the whole song, shown a page at a time following the playhead.
  - Click or paint steps; Repeat to End; Clear.
  - Auto-fill from a source's hits (whole song or these bars) to fix by hand.
  - Each row drives its own modulator: right-click any value › Link to Pattern, or switch a modulator's source to a row.
- **Presets follow the rack:** Kick Flash and Hi-Hat Grain link to a Kick or Hat row when there is one.
- **Effect parameters:** detented steps knobs (hold between keyframes, modulate in whole steps), and value readouts.
- **Project format v12** (the Channel Rack).
- **Tests:**
  - the done-when test: 4 × 250 exported frames of Posterize Time each holding exactly the frame the beat maths says; a Kick row driving Kick Flash, flashing on exactly its steps' frames in the file
  - Auto-fill on the test drums: 17 kicks on beats, 33 hats on 8ths
  - 17 new unit tests (340 in all)

## M11 · Grain

- **Grain** (Effects › Noise & Grain): Gaussian grain on a lattice sized relative to the picture's height, with a coarser layer for clumps, generated on the GPU and seeded by the frame, so every frame is repeatable.
  - Controls: Amount, Size, Softness.
  - Composite: Film (density), Digital (sensor noise), or Grain layer (grey grain for the Blend Mode).
  - Monochrome or Colour, with Colour Amount and red, green and blue sizes.
  - Response: Shadows, Midtones, Highlights.
  - Time: Refresh every frame, every N frames or on a note value (beat grid), Boil (how much carries over) and Seed.
- **Built-in presets:** Fine 35 mm, 16 mm and Super 8 Grain, Digital Sensor Noise, Heavy Noise (Overlay), and the audio-reactive **Hi-Hat Grain** (the high band thickens the grain).
- **Effect pipeline:** effects can read the frame number and the beat (the effect clock); the render cache keys such effects by frame, so stills with grain cache correctly.
- **Effect Controls:** settings that don't apply are hidden (Every N Frames shows only with Refresh on "Every N frames"); parameters marked not modulatable can't be linked.
- **Plan:** M12's drum sequencer will look like FL Studio's Channel Rack (your screenshot).
- **Tests:**
  - Grain on the GPU against its CPU maths: within 0.0015 on 10,553 pixels in 12 cases
  - end to end: the preview within 0.0014 of the maths; the exported ProRes 4444 file's grain correlates 0.994 with it
  - 14 new unit tests (323 in all)

## M10 · Colour & Light, Mosaic

- **Basic Correction** (Effects › Colour & Light): Temperature, Tint and Exposure as gains on linear light, then Brightness, Contrast, Highlights, Shadows, Whites and Blacks on perceptual (OKLab) lightness, then Saturation, Vibrance (sparing vivid colours and skin) and Hue. Grouped as White Balance, Tone and Colour.
- **Curves**: RGB plus Red, Green and Blue curves (smooth through up to 16 points, as Photoshop draws them), edited on a graph in Effect Controls with channel tabs. Click to add a point; drag it, or drag it off to remove it; arrow keys nudge. Curves hold between keyframes.
- **Levels**: Photoshop's input/output black and white points and gamma, for RGB and each channel.
- **Mosaic** (Effects › Stylize): blocks sized as a share of the picture's height, each the exact average of the light under it (or its centre pixel), with Cell Aspect and Edge Softness. Off below a pixel, so it can grow from 0%.
- **Built-in presets** (Effects Library › Built-in Presets), linked to the first audio analysis source as they're applied:
  - **Kick Flash**: +2 stops of Exposure on every kick (bass hits), fading over 200 ms
  - **Bass Mosaic**: cell size following the bass level, off when it's quiet
- **Effect Controls**: foldable parameter groups (with a dot when something inside is changed), and the curve editor.
- **Effect pipeline**: effects can carry lookup tables (curves) and render extra passes into their own smaller images before the main pass (Mosaic's exact cell averages).
- **Tests:**
  - every effect on the GPU against its CPU maths: worst 0.0032 over 26 Basic Correction settings, 12 curve and level sets, a stack and 10 Mosaic cases; times on a 4K frame
  - end to end: Kick Flash on real drums flashes on exactly the kicks' frames, and every exported frame matches the modulated exposure (0.0022); a graded adjustment layer and Mosaic match in playback and export
  - 17 new unit tests (309 in all)

## M9 · Masks and the temporal engine

- **Shared masks:** a mask belongs to the sequence and any effect can use it. Adjustment layers also have a whole-layer mask. Each use has its own Invert.
  - Shapes: rectangle (with rounded corners), ellipse, bezier pen path, edge (distance in from the frame's edges) and luminance range (each effect's own input).
  - Each shape has feather, expansion, opacity and invert, and combines with the shapes above it by add, subtract or intersect.
  - Every setting can be keyframed (in sequence time) and linked to audio or any modulator.
  - Masks are drawn in frame pixels, so a moved clip's effect keeps its mask in place.
- **Masks window** (⌥⇧3): masks, their shapes, each shape's settings, and what uses them. The selected shape is drawn on the Program monitor: drag to move, resize and turn it; for a pen path, drag, add, remove and smooth points and bend its handles. Effect Controls has a **Mask** row on every effect and adjustment layer (with New Mask…). Mask settings appear in the Modulation window and Link to Audio.
- **Stateful effects:** an effect can read its own output from the frame before.
  - The state starts at the clip's first visible frame and is thrown away by any edit that could change it.
  - A checkpoint is kept every second (within 1 GB of video memory). After a jump, the frames since the nearest checkpoint are rendered unseen first, so stills and export are always exact.
  - Playback carries on after a dropped frame, marked approximate in the stats overlay.
  - A frame that's already kept is shown again without running the effect.
- **Feedback** (Effects › Time): each frame over the previous one, zoomed and turned about a centre; Over, Add, Screen and Lighten.
- **Render cache:**
  - **Enter** (or Render) renders the frames with effects into preview files: one JPEG per frame, named by a key covering everything that decides how it looks. An edit invalidates exactly the frames it changes, including through feedback.
  - Playback and the paused frame show previews; export always renders.
  - **Render bar** on the ruler: yellow (effects, live), green (cached).
- **Cache Manager:** a size limit for preview renders across projects (least recently used go first), and **Clean Up Finished Project**.
- **After your answers (decisions 58–60):**
  - **Follow clip**: a mask on a clip's effect can move, scale and turn with the clip's Motion. It's shown and edited where it lands.
  - **Clip masks** (Premiere's opacity mask): every video clip has a Mask under Opacity; outside it, the clip is transparent.
  - Stateful effects' memory budget raised to 2 GB.
  - **In and Out on the timeline**: I, O, Shift+I/O, ⌥I/O/X. Enter renders between them.
  - **Cache menu** in the menu bar: Render Previews, Delete This Project's Previews, Clean Up Finished Project (with or without autosaves; saves and closes it first), Cache Manager.
- **Export and catch-up** now share one exact renderer (`exact-render.ts`).
- **Tests:**
  - the done-when test: Feedback exports as "this frame over the last" within 0.0016; playback matches the export within 0.0012; seven jumps within 0.0011; an edit re-renders its state; rendering to the cache (51 fps), cached frames within 0.0047, an edit invalidating exactly frames 101–199, undo bringing them back
  - masks on the GPU vs the reference maths over every pixel (0.0017); a keyframed edge mask exported within 0.12 px of its keyframes
  - 29 new unit tests (292 in all)
- **Project format v11** (v10: masks; v11: timeline In and Out).

## M8 · Audio and modulation

- **Analysis sources:** a clip, a track (even muted: a sidechain) or the mix. Mixed offline with the playback mixer, analysed in a worker, cached in the project's analysis cache, and redone only when that sound changes.
- **What's measured, 200 times a second:** Sub, Bass, Low-mid, Mid, High-mid, High (zero-phase Linkwitz–Riley crossovers, so no filter delay) plus custom ranges; loudness and peak; transients per band and hit events, timed to within a millisecond on test drums.
- **Tempo:** our own detector (autocorrelation for the tempo, then every onset folded onto one beat to pin tempo to 0.001 BPM and the phase); the downbeat from the loudest low end. ×2/÷2, tap tempo, typed BPM, beats per bar, downbeat nudge and Set to Playhead. Your corrections live in the project, never the cache.
- **Beat grid:** bars and beats on the timeline and Keyframe Editor rulers, faint bar lines, and beats as snapping targets (rounded to frames) for clips, trims, the playhead and keyframes.
- **Modulators:** source (audio signal, tempo, LFO synced to the beat, random) → input gain → threshold with soft knee → attack/release → response curve (four presets or drawn). Computed over the whole sequence in advance, so every frame is repeatable. Their settings can be keyframed.
- **Links:** one modulator drives any number of values (Motion, Opacity, Volume, effect values, Mix), each with Add / Multiply / Replace, a range in the value's units, Invert and Amount. Links live on the clip, so they move, split and copy with it.
- **Right-click any value:** Link to Audio, Modulate Parameter, Remove Modulation, Copy Value, Paste Value, Reset.
- **Windows:** Audio Analysis (⌥⇧1) and Modulation (⌥⇧2). Modulated values show a gold ∿ badge; the Keyframe Editor graph shows the modulated curve faintly; Audio Analysis overlays each modulator's output on its band.
- **Tests:**
  - the done-when test: one source drives three values; playback matches the export within 0.0015 in all 200 frames, and the square in every exported frame matches the modulated values (edges 0.11 px, brightness 0.0006)
  - tempo: 128.000 BPM detected on the test drums, bars within 1 ms
  - 28 new unit tests (263 in all)
- **Project format v9.**

## M7 · Keyframes

- **Every value can be animated:** Position, Scale, Scale Width, Rotation, Anchor Point, Opacity, Volume, Speed, and every effect setting including Mix.
  - Keyframes are kept relative to the clip, so they travel with it, and stay with the picture through trims, splits and speed changes.
  - Interpolation per keyframe: **hold**, **linear** or **bezier** (free handles), with Premiere's **Ease In**, **Ease Out** and **Ease In and Out**. Choices and on/off settings always hold.
- **Effect Controls:** a stopwatch on every value, **◀ ◆ ▶** to go between keyframes and add or remove one at the playhead, and a right-click menu (**Create Keyframes**, …).
- **Warning before keyframes are removed** (stopwatch off, Reset), with **Don't ask me again**; ginosa → **Show All Warnings Again** (decision 42).
- **Keyframe Editor** (⌥0):
  - **dope sheet:** every animated value of the selected clips; drag (snapping to frames, playhead, markers, edges and keyframes), Option-drag to stretch timing, box-select
  - **graph:** the focused value's curve, keyframes dragged in time and value, bezier handles
  - interpolation buttons, ⌘C/⌘V (onto any value of the same kind), Delete, ⌘A, F to fit; each drag is one undo step
- **Speed ramps:** Speed keyframes (0–10,000%) under Time Remapping. The picture follows the ramp exactly (the integral is computed exactly, not stepped). **Linked sound follows the ramp** (pitch changes, like tape) and stays in sync; unlinked sound plays as it is (decision 41).
- **Volume automation:** Volume keyframes in dB, followed by the sound in playback and export (sampled every millisecond).
- **Presets and copy/paste of effects** keep their keyframes; keyframed positions scale with the clip.
- **Timeline:** small diamonds on clips with keyframes; a **[Speed ramp]** badge.
- **Tests:**
  - the done-when export test: preview vs file within 0.0011; the square's edges within 0.12 px of the keyframes in every frame; the speed ramp right in every exported and played frame; sound level within 0.001 dB of the Volume keyframes
  - linked sound on a ramp: every beep within 0.04 ms of where the ramp puts it
  - 26 new unit tests (235 in all)
- **Project format v7.**

## M6 · Effects pipeline

- **Effects are modules:**
  - Each lives in its own folder `src/effects/<name>/`: a manifest, WGSL and tests. ginosa finds it automatically.
  - Each declares its parameters, the colour space it works in (display, linear light or OKLab) and a version, so old projects upgrade.
- **Effect stacks on clips** run on the clip's own pixels before its Motion.
- **Adjustment layers** apply their effects to everything beneath, with Opacity and a blend mode.
  - Create one with **+ Adjustment** in the timeline, File → New Adjustment Layer, or right-click a video track.
  - Edit it like a clip.
- **Every effect gets** on/off, **Mix** and **Blend Mode**: all 24 Photoshop modes, now also for clips and adjustment layers.
- **Effect Controls is generated from each effect's manifest**, with drag-to-reorder, on/off, Reset and remove. ⌘C / ⌘V / Delete work on selected effects.
- **Effects Library** (⌥9): search, drag onto clips or into Effect Controls, double-click to apply.
- **Presets:** save one effect or a stack, shared by every project. Positions scale to the clip.
- **Invert:**
  - Amount
  - Channel: RGB, R, G, B, Luminance only, Hue only, Chroma only
  - Space: display or linear light
- **Transform:** Motion's controls, plus Edges (transparent, repeat, mirror, tile) and Sampling (smooth, sharp, nearest).
- **Same in export:** export uses the same pipeline, so files include effects.
- **Tests:**
  - 68 GPU-vs-CPU checks (worst 0.003)
  - the done-when export test: Invert on an adjustment layer over five clips, reordered, toggled and faded; the file matches the maths within 0.0025
- **Project format v6.**
- 209 tests.

## M5 · Export

- **Export window** (⌘M, or File → Export…), like Premiere's Export Settings:
  - H.264, HEVC, HEVC 10-bit (MP4 or MOV), ProRes 422 HQ, ProRes 4444 (MOV)
  - bitrate with a suggestion for your sequence's size and rate, keyframe interval, size estimate
  - progress with fps and time left; Cancel; Show in Finder
  - exports a snapshot of the edit, so you can keep working meanwhile
- **Same picture as playback:** frames come from the same compositor (Motion, blends, dissolves, speed/reverse/holds, Apple Log/HDR/LUT colour), converted to Rec.709 Y′CbCr on the GPU with dither, 8-bit or 10-bit.
- **Hardware encoding** for H.264/HEVC (VideoToolbox), ProRes via FFmpeg, **Rec.709 colour tags** in the stream and the container so QuickTime shows it as ginosa does.
- **Sound mixdown** by the same mixer as playback (volume, mute, solo, speed). AAC 320 kbit/s, or 24-bit PCM with ProRes.
- **Safe writes:** a cancelled or failed export leaves no file and never replaces an existing one.
- **Export tests** (`npm run export-test`) read the files back: sync within 0.02 ms, colour within one code step in every format, every frame of speed/reverse/dissolve exact.
- 190 tests.

## M4 · Playback (part 3)

- **HDR on ginosa's own maths** (decision 20): iPhone HLG and HDR10/PQ HEVC clips are converted to Rec.709 on the GPU with ginosa's HDR→SDR maths, not Chromium's tone-mapping. ginosa rewrites the stream's transfer tag as the file is read, so the raw values arrive.
- **Colour check** now covers HLG and PQ (`npm run snapshot -- --scenario logview`).
- **Source Monitor on the real player:** sound, colour conversion (log, HDR, LUTs), J/K/L, frame steps; starting one monitor stops the other. Mark Out now includes the frame on screen (Premiere). Checked by `npm run snapshot -- --scenario sourceplay` (Apple Log within 0.001; A/V sync p95 20 ms, 0 dropped).
- **Your LUTs:** all 57 in `Reference Materials` load (17 log→Rec.709, 40 looks).
- **Your Apple Log clips** (iPhone, HEVC 4:2:2 10-bit) are detected correctly, decode natively and play at 25 fps with 0 dropped. `npm run snapshot -- --scenario footage` runs them through ginosa.
- 184 tests.

## M4 · Playback (part 2)

- **Speed/Duration** (⌘R): speed %, duration (linked), Reverse Speed, and ripple that shifts later clips and sync-locked tracks. Linked picture and sound change together. Clips show [200%], [-100%] or [Hold].
- **Add Frame Hold:** holds the frame under the playhead to the clip's end. Its sound keeps playing.
- **Reverse playback** decodes short stretches backwards and keeps only the frames that will be shown.
- **Sound at other speeds** plays varispeed (pitch changes). Reversed and held sound is silent for now.
- **Cross-dissolves** (⌘D): 1 s, centred on the cut, or a fade at a free end. Select, delete, drag to resize, or type a duration. They use media past the clip's end, holding the edge frame if there isn't any.
- **Colour interpretation** per media file (right-click → Colour):
  - Auto detects Apple Log and Apple Log 2 (iPhone/Blackmagic Camera), with a built-in conversion to Rec.709 (Apple's published curve and gamut).
  - An input `.cube` LUT (3D or 1D) replaces the built-in conversion; it's copied into the project.
  - Rec.709 values come through exactly: Chromium's display conversion is undone on the GPU and reapplied once, at the monitor.
- **Speed test** (`npm run speed-test`): reads every played frame's number back off the GPU. Measured 275 frames, 0 dropped, 0 wrong, 0 late.
- **Colour check** (`npm run snapshot -- --scenario logview`): Apple Log within 0.001, Apple Log 2 exact, Rec.709 within 0.008.
- **Project format v5:** colour settings per media file; speed, reverse and transitions per clip.
- 169 tests.

## M4 · Playback (part 1)

- **Playback with sound:** Space plays and stops; J/K/L shuttle (L up to 8×, J reverse).
  - Web Audio is the master clock, and the picture always shows the frame for the moment being heard.
  - Decoders start before the clock does, so playback begins without a drop.
  - Mute, solo and Volume apply live; edits made during playback carry on playing.
- **GPU compositor (WebGPU)** in 16-bit float, shared by the paused frame and playback (and export in M5):
  - Motion: position, scale, Scale Width, rotation, anchor; soft edges.
  - Opacity and 13 Photoshop/Premiere blend modes, on display values.
  - Stills, and rotation metadata.
- **New clips are Set to Frame Size** (4K in a 1080p timeline arrives at 50%), Premiere style. M3 projects keep their fitted look.
- **Effect Controls window** (⌥7, docked by default):
  - Motion, Opacity + Blend Mode and Volume (dB), with Premiere-style scrubbable numbers (Shift faster, Option finer, click to type).
  - Each drag is one undo step, with reset buttons and Set to Frame Size.
- **Program monitor:** transport buttons, playback resolution (Full, 1/2, 1/4), and a timing overlay (fps, dropped frames, render time, A/V offset).
- **Sync test** (`npm run sync-test`): plays a flash-and-beep clip and writes `renders/sync/sync.json`. It measures A/V offset per frame, checks every frame by reading the composite back, and reports clock drift and dropped frames. Measured: 0 dropped, 0 wrong frames, 95% within 28 ms.
- **Project format v4:** Motion, opacity, blend mode and volume on every clip.
- 135 tests.

## M3 · Timeline

- **Clips on tracks:**
  - Drag in from Media or the Source Monitor (Cmd inserts), or press , / . to Insert / Overwrite from the Source Monitor at the playhead.
  - Camera clips arrive with their sound, linked.
  - Stills last 5 s.
- **Premiere's tools and shortcuts:**
  - Tools: Selection (V), Track Select Forward/Backward (A, Shift+A), Ripple Edit (B), Rolling Edit (N), Razor (C).
  - Move, copy (Option-drag), insert-move (Cmd-drag), trim, ripple trim (Cmd-drag an edge) and roll.
  - Add Edit (Cmd+K, Shift+Cmd+K), delete and ripple delete (Shift/Option+Delete), close gaps.
  - Nudge (Option+arrows), link/unlink (Cmd+L), copy/cut/paste/paste insert, select all.
- **Sync Lock and Solo** on every track, alongside eye/mute and lock. Ripple and insert edits shift sync-locked tracks Premiere-style. A ripple that would knock a sync-locked track out of sync is refused, and an insert that splits one says so.
- **Snapping** (S) to cuts, the playhead and markers, with a guide line.
- **Markers:** add (M), move, name, delete, next/previous.
- **Navigation:** zoom (=, −, \, pinch, Option+scroll), trackpad scrolling, a scrollbar, frame stepping, edit-point jumps (↑/↓) and typed timecode (Premiere style: "1000", "+10").
- **Timeline drawn on canvas:** thumbnails on video clips, waveforms on audio clips, a hatched look for locked tracks, offline clips in red, and live previews while dragging. Every preview runs the same engine function as the real edit.
- **Program monitor still frame:** the top visible (or soloed) clip under the playhead, fitted to the frame. Match Frame (F) opens the source at that frame.
- **Engine:** every edit is a command with a pure function behind it, frame-accurate and undoable.
  - Removing media or a track removes its clips (with a notice).
  - The frame rate is fixed once clips exist.
- **Project format v3:** adds clips, markers, sync lock and solo. M2 projects upgrade automatically.
- 129 tests (33 new timeline-engine tests, 3 new timecode tests).

## M2 · Media and cache

- **Import:** Cmd+I, the Import button, or drag from Finder. Folders become bins. Duplicates are skipped, unreadable files are reported, and each import is one undo step.
- **File details:** FFmpeg's ffprobe reads codec, size, rotation, frame rate, bit depth, colour tags and audio format, then scans the first 10 s for variable frame rate and keyframe spacing. Each file gets a fingerprint (size, date, and a hash of its first and last MiB).
- **Media panel (Premiere style):**
  - Bins nest and can be dragged into each other.
  - Selection works with Cmd and Shift, items rename inline, and search filters by name.
  - Columns (Name, Duration, Size, FPS, Codec, Status) appear as the panel widens.
  - Right-click menus, plus status pills for offline, changed, copying and optimised items.
- **Thumbnails and waveforms:** made by FFmpeg and stored in the cache. Waveforms keep 100 min/max peaks per second.
- **Source Monitor (⌥5):** plays video (from the optimised copy when there is one), steps frames, and shows waveforms for audio. In and Out marks (I/O) are saved with the project and undoable.
- **Optimised copies:** made automatically when a file can't be decoded here (ProRes) or has a variable frame rate. Offered, not forced, when keyframes are far apart.
  - 8-bit sources become H.264 and 10-bit sources become HEVC 10-bit (VideoToolbox), with keyframes every half second. Audio becomes 24-bit PCM.
  - HDR clips (HLG/PQ) are kept as HDR, with no automatic SDR copy (decision 20). When one needs a copy for another reason, the copy stays 10-bit HDR with its colour labels.
  - Copies are made one at a time, with progress shown and Cancel available. Partial files are removed if a copy fails or is cancelled.
- **Relink:** offline files show a pill. Locate a single file, or pick a folder and ginosa finds every missing file inside it by name and size.
- **Cache Manager (⌥6):**
  - Shows the cache folder, size per project and category, and active copies.
  - Clear a category, or Clean Up a whole project, with a two-click confirm.
  - The cache location can be changed.
  - Deletion is guarded: project-ID and category checks, real-path containment, and symlinks are refused. Originals are opened read-only and never touched.
- **Icons:** interface icons are SF Symbols, drawn by macOS at runtime and coloured like text: the track-header toggles (eye, speaker, padlock), window buttons, bins, audio and play.
- **Project format v2:** adds media and bins. v1 projects upgrade automatically.
- 93 unit and integration tests. The media tests run the real FFmpeg on generated clips.

## M1 · Workspace and project

- **Projects:** `Name.ginosa` folders with `project.json`; New / Open / Open Recent / Save / Save As / Close / Show in Finder; start screen with recent projects.
- **Undo/redo:** every edit is a command recorded as Immer patches. Unlimited undo, rapid typing merges into one step, the Edit menu names the step, and a History window lets you jump to any step. The project counts as unsaved only when it differs from the saved point.
- **Autosave:** 5 s after you stop editing (at most every 60 s), rotating 20 snapshots, written atomically.
- **Crash recovery:** a journal records every change; after a crash or force quit, the project reopens automatically and offers to restore every change. Covered by end-to-end tests that simulate a crash.
- **Workspace:** media panel, program monitor (shaped by the sequence settings), timeline with real track headers (rename, hide, mute, lock, add, delete), resizable splitters.
- **Floating windows (FL Studio style):** move, resize, snap to edges and other windows, minimise to a tray, maximise, dock as tabs in a side column, close and reopen (⌥1–⌥4), saved named workspaces.
- **Windows:** Project Settings, History, Diagnostics, Playback Test (the M0 player, kept until the real monitors arrive).
- **Native menus** with Premiere-style shortcuts; unsaved-changes prompt on close and Cmd+Q.
- **Dev tools:** agent runner (`npm run agent`) and UI snapshot mode (`npm run snapshot -- --scenario …`) for automated screenshots.
- 56 unit tests (engine, history, file format, workspace layout, project files and recovery).


## M0 · Foundations (in progress)

Verified on the M5 MacBook Pro (2026-10-30): typecheck clean, 20/20 unit tests, render harness frame-accurate (each render matches its source frame, inverted). See `docs/M0-results.md`.

- Electron + electron-vite + TypeScript project, macOS window with an inset title bar.
- Read-only `ginosa-media://` protocol that streams local files with range requests.
- WebGPU device setup and a WGSL test shader (none / invert) drawing decoded frames.
- Mediabunny clip access: frame-accurate frame-by-index decoding and sequential playback.
- Diagnostics shell: GPU details, hardware decode/encode support per codec, clip info, decode and GPU timings, playback throughput test (no audio yet).
- Render harness: `npm run render` renders chosen frames to PNG without a window and writes `report.json`.
- Engine time module (integer ticks, frame rates, timecode) with unit tests.
- Scripts: `doctor.sh` (environment check), `setup.sh` (dependencies), `make-test-media.sh` (synthetic test clips).
- Docs: README, decisions log, dependencies and licences, M0 checklist.

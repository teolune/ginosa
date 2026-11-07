# Changelog

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

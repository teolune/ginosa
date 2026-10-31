# Decisions log

**Approved** means you agreed to it. **Proposed** means Claude suggested it and it is waiting for your approval. Change a status by editing this file or by telling Claude. This file mirrors the decisions table in the Stage 2 Technical Plan doc.

| # | Decision | Status | Notes |
| --- | --- | --- | --- |
| 1 | Electron desktop app, macOS on Apple silicon only, personal use | Approved | No cross-platform or distribution work |
| 2 | TypeScript throughout, WGSL shaders for GPU effects, FFmpeg for media I/O | Approved | |
| 3 | Shared offline audio analysis; one source can drive many parameters | Approved | |
| 4 | Right-click Link to Audio / Create Keyframes / Modulate Parameter | Approved | |
| 5 | Shared mask system usable by any effect or adjustment layer | Approved | |
| 6 | Undo/redo, autosave, crash recovery, beat grid, cache management are core features | Approved | |
| 7 | Floating tool windows inside the main app window (FL Studio model) | Approved | |
| 8 | 1080p target; heavy 4K editing stays in Premiere | Approved | |
| 9 | Datamosh: GPU engine first (all modes), codec-level bake second | Approved | |
| 10 | Use any library needed; record every dependency and licence | Approved | See `DEPENDENCIES.md` |
| 11 | Direct 1080p import with automatic optimised copies; proxies later | Approved | |
| 12 | Any standard frame rate up to 60 fps; real-time 1080p preview target | Approved | |
| 13 | Working colour Rec.709 SDR, processed in 16-bit float | Approved | Camera footage is log: log-to-Rec.709 conversion and camera `.cube` LUTs move into M4 |
| 14 | React for panels; timeline, keyframe editor and scopes drawn on canvas/GPU | Approved | M0 uses plain DOM; React arrives in M1 |
| 15 | Gradient Map: Photoshop-matching editor plus .GRD import of solid gradients | Approved | |
| 16 | Workflow: Mac linked to Claude, local git repo, private GitHub repo as backup | Approved | Repo: `teolune/ginosa` |
| 17 | Effects build order as listed in the plan's milestones | Proposed | |
| 18 | App name: **ginosa** | Approved | 2026-10-30 |
| 19 | Log footage support (camera conversion + `.cube` LUT per clip) moves into M4 | Proposed | Raised by M0: camera originals are log |
| 20 | HDR clips (HLG/PQ, e.g. iPhone's normal HDR mode) stay HDR: no automatic SDR copy. They're converted to the Rec.709 sequence live on the GPU, as a per-clip input setting alongside Apple Log (M4), so grading keeps the highlights. Export stays SDR | Approved | 2026-10-31. A full HDR timeline and export was offered and not chosen |
| 21 | Interface icons are Apple's SF Symbols, drawn by macOS at runtime; text fallback if a symbol is missing | Approved | 2026-10-31, your request |
| 22 | Track headers: eye/mute, Solo, Sync Lock and lock. No track targeting: Insert/Overwrite go to the lowest unlocked video and audio tracks | Approved | 2026-10-31, your choice |
| 23 | Ripple and insert edits follow Premiere's Sync Lock (on for every track by default). A ripple that would push a sync-locked track out of sync is refused; an insert that has to split clips on one says so | Approved | 2026-10-31, your choice. Turn Sync Lock off on the song track |
| 24 | Camera clips are placed with their sound, linked (Option-click for one side, Cmd+L to unlink) | Approved | 2026-10-31 |
| 25 | M3 Program monitor shows a still of the top visible clip under the playhead, fitted to the frame, until M4's compositor | Approved | 2026-10-31 |
| 26 | New clips are Set to Frame Size (fitted, Scale shows e.g. 50%), keeping full source resolution for punch-ins | Approved | 2026-10-31, your choice |
| 27 | Opacity, blend modes and (in part 2) dissolves composite on display (gamma-encoded) values, matching Photoshop's formulas. Effects that need linear light convert for themselves (plan: each effect declares its colour space) | Proposed | Raised by M4. A linear-light compositing option could be added later |
| 28 | Shuttle (J, and L above 1×) plays picture only, no sound | Proposed | Raised by M4. Pitched or scrubbed shuttle audio could come later |
| 29 | Colour interpretation (Auto / Rec.709 / Apple Log / Apple Log 2 / input LUT) is set per media file, like Premiere's Interpret Footage, rather than per clip as row 19 put it. Every clip of that file follows it; looks per clip come with the colour effects | Proposed | Raised by M4. Per-clip overrides could be added |
| 30 | Sound at other speeds is varispeed (pitch follows speed); reversed and frame-held sound is silent until reversed audio and Maintain Audio Pitch are built | Proposed | Raised by M4 |
| 31 | Cross-dissolves default to 1 s, centred on the cut (Premiere's default). With no media left past a clip's end, the edge frame is held rather than refusing the dissolve | Proposed | Raised by M4 |

## Implementation notes (engineering choices, no approval needed)

- **Time** is stored as integer ticks at 254,016,000,000 per second (Premiere's rate). See `src/engine/time.ts`.
- **Local media** is served to the renderer through a read-only `ginosa-media://` protocol with HTTP range support. Mediabunny reads files in pieces rather than loading them whole.
- **M0 UI** is plain DOM on purpose. It is a diagnostics shell, replaced by the real workspace in M1.
- **Media files** are identified by a fingerprint: size, modification time, and a SHA-1 of the first and last MiB. A file that changes size shows as *Changed*; a missing one shows as *Offline*.
- **Optimised copies** (M2): H.264 CRF 16 for 8-bit sources, HEVC Main10 via VideoToolbox for 10-bit and all HDR sources, keyframes every 0.5 s, 24-bit PCM audio, in `.mov`. Made automatically only when needed (codec not decodable by WebCodecs, variable frame rate); offered for keyframes more than 2 s apart. HDR copies keep their BT.2020 + HLG/PQ labels, stamped into the bitstream because Apple's encoder drops them. File names carry a format version (now v2), so changing the recipe never reuses stale copies.
- **HDR to Rec.709** maths lives in `src/shared/colour/hdr-to-sdr.ts`, ready for M4: HLG inverse OETF + OOTF at 1000 nits (PQ via its EOTF), 203-nit reference white mapped to 1.0, a soft roll-off above 0.75, BT.2020→709 matrix, then BT.709 gamma, generated as a 33³ `.cube`. Until M4, the Source Monitor shows HDR clips with Chromium's own conversion.
- **Cache** lives at `~/Movies/ginosa Cache/<project id>/<category>/` with an `index.json` naming each project. Every delete goes through `CacheService`, which checks the project ID and category, resolves real paths, stays inside the cache root and refuses symlinks. A chosen location always gets its own `ginosa Cache` subfolder.
- **Timeline edits** (M3) live in `src/engine/timeline/`. Each edit has a pure `apply…` function used both for the live drag preview and by its command, so the preview is the edit. Every position sits on the sequence's frame grid, so the frame rate is locked once clips exist.
- **Clips** store `start`, `duration` and `sourceIn` in ticks, plus a `linkId` shared by linked picture and sound. Splitting keeps the left half's link and gives the right halves a new shared one.
- **Defaults** taken from Premiere: stills last 5 s; a drag overwrites and Cmd-drag inserts; Option-drag copies; picture and linked sound mirror around the middle when moved between tracks.
- **Snapping** targets: the playhead, clip edges, markers and the sequence start, within 8 px. The playhead snaps while snapping is on, or while Shift is held.
- **Typed timecode** reads Premiere's forms ("1:02:03:04", "1000" read right to left, "+10" relative). Display is non-drop-frame only.
- **Playback clock** (M4): Web Audio's clock minus its reported output latency is the master; the picture follows a smoothed version of it (re-locked if the two ever differ by 50 ms) and never steps backwards. `getOutputTimestamp()` proved unreliable here, so it isn't used.
- **Media time 0** is the file's first timestamp, but never below 0. AAC audio often starts a few ms early (encoder priming), and anchoring on that put every video frame one frame late; the sync test caught it.
- **Compositor**: each layer is one full-frame pass that reads the layers below and writes into the other of two `rgba16float` textures. Video frames arrive as external textures (no copies); stills are uploaded once.
- **Colour on the Mac** (M4): Chromium converts decoded Rec.709 frames for the display (a 1.961 gamma to sRGB) before ginosa sees them. ginosa undoes that on the GPU, so effects and blends work on the file's own values, and applies it once at the monitor. Measured round trip: within 0.008 of the file's values.
- **Apple Log** (M4): iPhone log files carry no transfer tag, so ginosa asks the decoder for plain BT.709 Y′CbCr→RGB and gets the raw log values. Built-in conversion: Apple Log curve → linear, gamut (BT.2020 for Apple Log, Apple Wide Gamut for Apple Log 2) → Rec.709, a soft shoulder above 0.5, then the Rec.709 curve. Detection: 10-bit, BT.2020 matrix, unspecified transfer; primaries BT.2020 → Apple Log, unspecified → Apple Log 2. Confirmed on your clips (`Reference Materials/AppleLogClips`): HEVC Rext 4:2:2 10-bit, 3840×2160, 25 fps, keyframes every 1 s; container `colr` and SPS VUI both 9/2/9 (Apple Log) and 2/2/9 (Apple Log 2). Chromium decodes 4:2:2 HEVC in hardware on your M5: both clips played at 25 fps with 0 dropped on a 1080p timeline, so they need no optimised copy. Checked by `npm run snapshot -- --scenario footage` (and `footage2`).
- **HDR** (M4): Chromium tone-maps HLG/PQ frames itself and ignores the decoder colour request for them. So as an HLG/PQ HEVC file is read, ginosa rewrites the 8-bit `transfer_characteristics` in its SPS (in the `hvcC` header and in any SPS repeated inside packets) to "unspecified" (`src/engine/colour/hevc-sps.ts`). Frames then arrive raw, as Apple Log does, and the shader applies the maths in `src/shared/colour/hdr-to-sdr.ts` exactly. The parser follows H.265 §7.3.2.2 and matches FFmpeg's bit positions on x265, VideoToolbox and a hand-built SPS covering every branch. Non-HEVC HDR (rare) still gets Chromium's conversion. Measured: within 0.011 (HLG) and 0.02 (PQ) of the maths, all of it on the brightest test patch where the test file's 10-bit rounding is amplified.
- **Speed and reverse** (M4): a clip at speed *s* covers `duration × s` of its media. A reversed clip shows exactly the frames it shows forwards, in the opposite order. Reverse playback decodes ~0.3 s stretches latest-first (keeping at most 8 frames each) while the previous one plays.
- **Source Monitor** (M4): plays the open file as a one-clip sequence at the file's own size and frame rate (`src/engine/timeline/source-sequence.ts`), through the same player as the Program monitor: sound, colour conversion and the audio clock. Starting playback in one monitor stops the other. Mark Out includes the frame on screen, as in Premiere (stored as the end of that frame; the label shows the frame itself). Files at non-standard rates (e.g. 120 fps) play at the nearest standard rate or 25 fps.

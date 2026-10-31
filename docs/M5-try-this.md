# M5 · Try this (export)

M5 is export: H.264, HEVC (8- or 10-bit) and ProRes 422 HQ / 4444, with the timeline's sound. Exports use the same compositor as playback, so the file looks like the Program monitor. This completes Stage 1, the core editor. About 15 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run test-media
npm run export-test
cat renders/export/sync.json
cat renders/export/colour.json
cat renders/export/speed.json
open renders/export
npm run dev
```

- [ ] `npm run check` ends with **Tests 190 passed (190)**. New tests cover:
  - the raw frame layouts piped to FFmpeg
  - the FFmpeg command for each format: hardware encoder, Rec.709 tags, sound, NTSC rates
  - refusing settings that would fail
  - suggested bitrates
  - the mixdown's WAV header
- [ ] `npm run export-test` opens ginosa three times (about a minute in all). Each run exports a test project into `renders/export/` and reads the file back with FFmpeg.
- [ ] `sync.json`: `"verdict": "pass"`.
  - All 10 flashes sit within a fraction of a millisecond of their beeps; I measured `offsetsMs` 0.02 each.
  - `frames` is 250.
  - `tags` are all `bt709`, with range `tv`.
- [ ] `colour.json`: `"verdict": "pass"`.
  - For each of `h264`, `hevc10`, `prores-422hq` and `prores-4444`, `worstError` is how far the decoded file is from what the Program monitor showed. I got 0.005, 0.0011, 0.0009 and 0.0008, about one step of each format's bit depth.
  - Tags are `bt709`.
- [ ] `speed.json`: `"verdict": "pass"`. Every one of the 275 frames of the forwards / reversed / 200% / hold / reversed 200% / dissolve timeline is exact in both H.264 and ProRes.
- [ ] `open renders/export` shows the exported files. Open `sync.mp4` and `colour-h264.mp4` in QuickTime: the flashes and beeps line up, and the patches look the same as in ginosa (see below).

## Exporting

- [ ] With a project open, press **⌘M** (or File → Export…). The Export window shows the sequence's size, frame rate and length.
- [ ] Pick a **Format**:
  - **H.264** or **HEVC** (8-bit), **HEVC 10-bit**: MP4 or MOV, hardware encoder, with a **Bitrate** (Suggested fills in one for your sequence) and **Keyframe every**
  - **ProRes 422 HQ** or **ProRes 4444**: MOV only, with 24-bit PCM sound
- [ ] **Choose…** where to save (it suggests the project's folder), or just press **Export** and you'll be asked.
- [ ] While it runs, the window shows the frame count, fps and time left. **Keep editing**: the export uses the edit as it was when you pressed Export.
- [ ] **Cancel Export** stops it and leaves nothing behind. An existing file with the same name is never replaced until an export finishes.
- [ ] When it's done, **Show in Finder**.
- [ ] Your settings are remembered for next time.

## Check it against Premiere and QuickTime

- [ ] Export a short edit of your Apple Log footage (H.264, 40 Mbit/s). On this Mac, 4K Apple Log → 1080p exported at about 66 fps for H.264 and 31 fps for ProRes 422 HQ. Tell me what you get.
- [ ] Open the file in QuickTime next to ginosa's Program monitor at the same frame. Colours and contrast should match, not washed out.
- [ ] Optionally import the export into Premiere: it should read as Rec.709, 1920×1080, your frame rate, with the sound in sync.

## Not yet

- Exporting an In–Out range (comes with sequence In/Out marks), transparency in ProRes 4444, and audio crossfades.
- Effects arrive from M6. Exports will include them automatically, since export uses the same compositor.

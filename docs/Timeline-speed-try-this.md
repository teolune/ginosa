# Timeline speed and zoomable waveforms · Try this

You asked for a faster timeline, and for the waveform to show more detail as you zoom in. What was slow, measured with your Apple Log clips: every step of a pinch or scroll re-rendered the Program monitor's paused frame (36 renders in one pinch, with a 150 ms stall). Stepping the playhead seeked back to the last keyframe for every frame, so only 21 of 120 steps showed. Both are fixed. The timeline's own drawing was never the problem: it takes well under a millisecond. About 10 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Quit the app if it's open. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario timelineperf4k
cat renders/ui/timelineperf4k.json
npm run snapshot -- --scenario waveformzoom
open renders/ui/waveformzoom.png
npm start
```

- [ ] `npm run check` ends with **Tests 375 passed (375)**. The 4 new tests cover the waveform peaks: one for every 10 samples whatever pieces the sound arrives in, the coarser copies, the shape up close (a crest stays a crest), and which copy a zoom reads.
- [ ] `timelineperf4k`: a 4-minute edit of your two Apple Log clips with the song under it and Datamosh on an adjustment layer, with Effect Controls and the Keyframe Editor open. Each step happens once a frame, timed by the screen's own frames (8.3 ms at 120 Hz). Expect `"verdict":"pass"`:
  - `zoomIn`, `zoomOut` and `scroll` at about **8.3 ms** a frame, worst under 10, with `"monitorRenders":0` (was 36 to 38).
  - `playhead` (a frame at a time, as when stepping): about **104** monitor renders of 120 (was 21), p95 about **17 ms** (was 100).
  - `playback` at **25 fps** with nothing dropped, with and without Datamosh.
- [ ] `waveformzoom.png`: the song at the closest zoom (2400 px a second). You can see the cycles of each kick. `waveformzoom2` shows it at 120 px a second.
- [ ] **`npm start`** instead of `npm run dev` from now on. `npm run dev` is for working on ginosa: it adds React's development checks and live reload, which make every redraw slower (I haven't measured by how much on your Mac). `npm start` builds first (about 10 s), then opens the same app with your projects.

## In the app

- [ ] Pinch or Option-scroll to zoom on a long edit: it should keep up with your fingers, and the monitor shouldn't flicker or redraw.
- [ ] Zoom into the song: the waveform gets more detailed, down to the shape of each hit. Waveforms are made again the first time each one shows (a moment per song); the old, coarser ones in the cache aren't used.
- [ ] Hold → (or step with the frame buttons) over your iPhone clips: frames should come quickly, one after another.
- [ ] Play with Effect Controls open: its values still follow the playhead, 10 times a second.

## Also

- [ ] If something is still slow, tell me exactly what (zooming, playing, a window, a particular effect) and I'll measure that next. Downscaled proxies for 4K footage are still planned for later; your clips play at 25 fps without them here, so they don't look needed yet.
- [ ] No new dependencies.

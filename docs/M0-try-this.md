# M0 · Try this

M0 is a diagnostics shell, not the editor yet. It answers one question: does this Mac do everything ginosa needs? This checklist takes about 10 minutes.

## In Terminal

```bash
cd ~/Desktop/video/Developer/Ginosa
npm run doctor        # every line should be a green tick
npm run check         # typecheck + unit tests should pass
npm run test-media    # creates clips in media/test/
npm run render -- --input media/test/testsrc_1080p24_h264.mp4 --frames 0,12,100 --effect invert
```

The render should finish with `done: 3 frame(s)`. The PNGs are in `renders/testsrc_1080p24_h264/`.

## In the app (`npm run dev`)

- [ ] The window opens with a dark title bar and the **This Mac** panel fills in.
- [ ] **WebGPU** shows *available*, and your GPU is named.
- [ ] Under **Hardware decode**, H.264 and HEVC show *yes*, and ProRes shows *no* (expected; that's why optimised copies exist).
- [ ] **Open video…** → `media/test/testsrc_1080p24_h264.mp4`. The frame counter drawn in the picture matches the timecode, and the arrow keys step exactly one frame.
- [ ] Drag the scrubber quickly: the picture keeps up without freezing.
- [ ] Switch the effect to **Invert** and move Amount: the picture fades smoothly to a negative.
- [ ] Press **Space** to play: the status bar should show close to 24 fps with few or no dropped frames.
- [ ] Open `testsrc_1080p24_prores.mov`: it should say it can't be decoded, without crashing.
- [ ] Open one of your own 1080p Premiere exports and scrub it.

Report back anything that looks wrong, feels slow, or doesn't match this list. Screenshots help.

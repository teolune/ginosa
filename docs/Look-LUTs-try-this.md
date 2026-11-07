# Look LUTs · Try this

Look LUTs (decision 77) were pulled forward from M16: a **Look LUT** effect for any clip or adjustment layer, with a **Strength** slider, like Lumetri's Creative Look. They also brought a fix that matters for your log footage: LUT colours just under 0.5, 0.125 or 2 came out halved on the GPU (dark specks). Input LUTs had it too, ever since M4.

How it works is in decision 86 (Proposed). About 20 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario lookgpu
cat renders/ui/lookgpu.json
npm run snapshot -- --scenario exportlook
cat renders/ui/exportlook.json
open renders/ui/exportlook.png
npm run dev
```

- [ ] `npm run check` ends with **Tests 368 passed (368)**. The 4 new tests cover: 1D LUTs and other domains turned into 0–1 cubes; Strength (0%, 50%, 100%, 200%) and light above white; finding the LUTs a sequence uses (values and keyframes); and half floats, every one of them, including the values that used to come out halved.
- [ ] `lookgpu`: the Look LUT on the GPU against the CPU maths, on a grey ramp, 16 colours and 128 hues. It runs made-up LUTs (3D at several strengths, 1D, one with its own domain), then every .cube in your `Reference Materials/Look LUTs` (only read). Expect `"verdict":"pass"` and `"yours":40`. Each check is a share of its allowance; the worst was **0.37**. Before the fix, 9 of your 40 failed. It costs about **0.7 ms** a 4K frame.
- [ ] `exportlook`: the repo's test look imported into the project, at 70% on an adjustment layer over the colour patches. Expect `"verdict":"pass"`: preview within **0.0007**, the exported file within **0.0013**, and that from the very first frame. `exportlook.png` shows the Look LUT in Effect Controls.

## In the app

Save your project first: LUTs are copied into its folder, so it carries them.

- [ ] Put an adjustment layer over a clip and drag **Look LUT** onto it (Effects › Colour & Light).
- [ ] **LUT** › **Choose .cube…** and pick one from your `Look LUTs` folder. It appears in the menu and is copied into the project's `luts` folder; your original isn't changed.
- [ ] **Strength**: 0% is the original, 100% the LUT as made, 200% twice as far.
- [ ] Pick another LUT from the menu; keyframe Strength (or the LUT itself, which switches at the keyframe).
- [ ] **Compare with Premiere**: the same clip, the same LUT in Lumetri › Creative › Look at Intensity 100. They should match within a level or two. Tell me if a LUT looks clearly different.
- [ ] **Recheck an Input LUT** on your log footage (right-click the media › Colour › Input LUT…) against Premiere with the same LUT. Colours that looked a little off in M4 may now match.
- [ ] Look LUTs work on Rec.709 picture values. On log footage, convert first (the media's colour setting or Input LUT), then the look.

## Also

- [ ] .cube files can now have 1D LUTs of up to 65,536 entries (was 256), as Adobe's spec allows.
- [ ] No new dependencies. The test look (`src/engine/colour/fixtures/test-look.cube`) is made by the test itself.
- [ ] M9–M13's GPU, playback and export tests ran again after the effect pipeline change and still pass.

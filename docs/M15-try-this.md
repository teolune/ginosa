# M15 · Datamosh B · Try this

**Datamosh Bake** (Effects › Time) is the codec-level datamosh from the plan, built the way you chose: an effect that bakes, with every kind of moment in its menu and every vector tool. Put it on a clip or an adjustment layer. It renders the picture it sees over its whole span and has FFglitch encode it as MPEG-4 Part 2. Then the stream is broken at your moments (keyframes removed, frames repeated), its motion vectors are rewritten, and it's decoded back with the errors left in. The result plays in place.

While it bakes you see the live Datamosh look (M14's Engine A) with the same settings, and Effect Controls shows how far the bake has got. Any change re-bakes it. How it all works is in decision 133 (Proposed). About 30 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario datamoshbake
cat renders/ui/datamoshbake.json
open renders/ui/datamoshbake.png
npm start
```

- [ ] `npm run check` ends with **Tests 463 passed (463)**. The 23 new tests cover:
  - The bake's plan: its settings, the size it's encoded at, finding cuts, markers and beats, and melts, blooms and heals in order.
  - Cutting an MPEG-4 stream into frames and joining them back.
  - Keys: what re-bakes and what doesn't.
  - The live look until a bake is ready, then the bake's frames.
  - What a bake is made from.
  - The vector tools and the ffedit scripts, run as ffedit runs them.
- [ ] `datamoshbake` (about 40 seconds). It sets FFglitch up first if it isn't (it already is on your Mac). Expect `"verdict":"pass"`:
  - **`firstBakeSeconds`** about **2–3**: 100 frames at 1080p.
  - **`beforeCut`**: the bake is the footage through the codec, about **0.04** on every frame.
  - **`melt`**: five frames after the cut, where the frame counter didn't change, the bake is near the old shot (about **0.08**) and far from the new one (about **0.39**). That's the melt.
  - **`exportVsBake`** about **0.001**.
  - **`playback`**: all **100** frames, with a mean about **0.0004**.
  - **`jumps`**: about **0.0003**.
  - **`pushX3.onStill.perFrame`** about **3** (Push X 3 px moves a still 3 px a frame, to the right).
  - **`motionTransferOnStill.perFrame`** **4** (a square sliding 4 px a frame on a hidden track moves the still with it).
  - **`clipBake`**: **50** frames at **1920 × 1080**.

  `datamoshbake.png` shows Effect Controls with **Baked: 100 frames** and every setting the last bake used.
- [ ] If ginosa was open, quit it and run `npm start` again (FFglitch and the slimmer Channel Rack cubes need a restart).

## In the app

Datamosh Bake looks best over a cut between two shots with movement. Your Apple Log clips are good for this.

- [ ] Put two shots on V1 back to back, press **+ Adjustment** over the cut, and drag **Datamosh Bake** (Add Effects › Time) onto it. Effect Controls shows **Waiting to bake**, then **Baking (rendering the picture), 40%** with a bar, and the live look plays meanwhile. Then it says **Baked: N frames**. Play across the cut: the second shot's movement smears the first shot's picture. That's the melt.
- [ ] Change **Cuts** to **Melt and Bloom** and set **Bloom Frames** to 12. It re-bakes. At the cut, the new shot's first movement repeats and keeps pushing. **Clean** keeps the keyframe, so the cut is clean.
- [ ] Press ⌘Z. The bake before comes back straight away, with no baking.
- [ ] **Push X** 4: the whole picture slides right as it smears. Then try:
  - **Rotate** 90°: it moves sideways to the footage's own motion.
  - **Swirl** 50%.
  - **Scale** −100%: the motion runs backwards.
  - **Fluid** 70%: movement flows on.
  - **Wrong Guesses** 30%: blocks fly off with a neighbour's motion.
- [ ] Link **Push Y** (or Scale) to the kick, like any value: right-click it › **Link to Channel: Kick** (or **Link to Audio…**). The bake follows the song: audio-driven baking.
- [ ] With the Channel Rack's **Kick** set, choose **Channel: Kick** with **On Its Cubes: Bloom**: a bloom on every kick. **Every 1 bar** with **On the Beat: Heal** clears the picture each bar. Add markers (M) and set **Markers** to Bloom or Heal.
- [ ] **Motion Source**: put a clip with strong movement (water, smoke, a dancer) on V3, hide V3, and choose V3. That clip's real motion vectors move your picture.
- [ ] **Block Size** 32 or 64 px and **Quality: Crushed**: chunkier blocks, and it bakes faster.
- [ ] Put Datamosh Bake straight on a clip instead of an adjustment layer. It bakes the clip's own picture (Cuts do nothing there, since a clip has none inside it).
- [ ] Export (⌘M): the export shows the bakes, and makes any that aren't ready first (**Making the Datamosh Bakes first…**).
- [ ] Cache window: **Datamosh bakes** lists what they take. Clearing them makes the ones in use again.

## Good to know

- At 1080p, 100 frames bake in about 2 s here. By that rate, an adjustment layer over a whole 3-minute song should take a minute or two (not measured yet). Bigger blocks are faster. Bakes are made one at a time, the ones beneath first.
- The live look while baking is Datamosh (Engine A) set as close as it goes. It isn't the bake, which is why the bake replaces it.
- A melt shows where the picture changes, so it's strongest at cuts and on movement. A heal or a melt in the middle of a shot shows little. Bloom shows anywhere there's motion; on a still nothing moves.
- Motion Source is read as shot (without its effects), even while its track is hidden. On a clip, the source is fitted to the clip's frame.
- **Push** is in pixels of a 1080-high picture a frame, measured at exactly that on a still. On footage the codec's corrections pull fine detail back, so the slide looks slower.

## Sign-off (M15)

- [ ] **Decision 133**, Datamosh Bake: an effect that bakes; Cuts (Melt, Melt and Bloom, Clean), Channel, Every, Markers (Bloom or Heal) and Heal After; Push, Scale, Rotate, Swirl, Fluid, Wrong Guesses and Motion Source; Block Size and Quality; the live look while it bakes; re-bake after 0.7 s; export bakes first; FFglitch 0.10.2 in `.ffglitch/`.
- [ ] The done-when: **bakes play on the timeline and re-bake on change**.

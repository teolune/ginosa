# Effect stacks: speed · Try this

You said stacking effects slows everything down, including adding new ones. I measured a stack of 10 effects on an adjustment layer (Feedback and Datamosh at the top) over clips with their own effects, and fixed what was slow. About 10 minutes.

What was slow:
- **Feedback and Datamosh replayed every frame before the one you see**, from the start of their layer, after any change beneath them. That happened on every step of a slider: frames took up to 1.3 s while dragging. Adding Datamosh froze the monitor for 2.5 s.
- **Clicking a clip redrew the monitor**, though the picture hadn't changed.
- Each effect's shaders compiled the first time it was used, separately in the monitor, export and render cache.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Quit the app if it's open. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario effectsperf
cat renders/ui/effectsperf.json
npm start
```

- [ ] `npm run check` ends with **Tests 376 passed (376)**. The new test: catching up renders only what feeds a stateful effect's state.
- [ ] `effectsperf`: expect `"verdict":"pass"` and roughly these (the screen draws every 8.3 ms):
  - `addEffect`: every effect shows within about **20 ms** (`firstMs`), including Feedback (was 428) and Datamosh (was 2,492). For those two, `exactMs` (about 1 s and 3 s) is when the exact frame follows; `worstFrameMs` under **10**, so the app kept drawing meanwhile (was 250).
  - `dragging` (a value beneath them, changed every frame): about **35 ms** a frame (was 196), worst about 43 (was 1,346).
  - `selecting`: `"monitorRenders":0` (was 60).
  - `warmed`: about 19 shaders compiled in the background in under 100 ms.
  - `gpuMsPerEffect`: each effect's time on a 1080p frame. Datamosh is about **6 ms**, Grain about 1, the rest well under 1.
  - `playback`: 25 fps, nothing dropped.

## In the app

- [ ] Stack several effects on an adjustment layer, with Feedback or Datamosh at the top. Drag a value of an effect beneath them: the picture follows as you drag (a preview). About a quarter of a second after you let go, the exact frame replaces it. "Catching up" shows in the monitor if that takes a while.
- [ ] Add an effect from the Effects Library: it appears straight away.
- [ ] Click between clips: the monitor doesn't flicker or redraw.
- [ ] Use **`npm start`** for editing, not `npm run dev` (that adds React's development checks to every redraw).

## Limits

- [ ] The exact frame under Feedback or Datamosh is worked out from the start of their layer: on a long layer, deep in, that can take several seconds after an edit (shown as "catching up"). The preview shows meanwhile. Playback starts from the exact state, and export and the render cache are always exact. Shorter adjustment layers (a section of the song each) keep it quick.
- [ ] The stack's own GPU time is now what limits it: about 17 ms a 1080p frame for this test stack, fine at 25 fps, too much for 60. Datamosh is a third of it. Making Datamosh's search cheaper, or previewing at half resolution while you drag, would be next if you need it.

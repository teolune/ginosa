# Channel Rack · Try this

The Channel Rack from your illustration: sections, cubes you click, the cube window, the channel controls, linking values to channels, and Automatic Detection from the song on A1. About 20 minutes, plus a one-time setup for stem separation.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Quit the app if it's open. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario rackui
cat renders/ui/rackui.json
open renders/ui/rackui.png
npm run snapshot -- --scenario rackdetect
cat renders/ui/rackdetect.json
```

- [ ] `npm run check` ends with **Tests 400 passed (400)**. New tests: sections, cubes and their amounts, saving and moving old racks over, each link's own curve from the cubes, the hit gates (a snare found among hi-hats, a quiet intro keeping its hits) and a song that ends mid-loop.
- [ ] `rackui`: `"ui"` ends with `"pass":true` (link mode's socket links and unlinks Contrast, dragging Clap onto Brightness links it, clicking an empty cube makes one, Backspace deletes it), and `pushes` is `[1,-0.5]` (a +100% cube and a −50% cube on Kick Flash's link).
- [ ] `rackui.png`: the Channel Rack with even, raised cubes, the beats in alternating shades of four; Kick on every beat, Clap on 2 and 4, Hi-hat on every 8th; one pink cube (it pushes its value down).
- [ ] `rackdetect`: `"verdict":"pass"` with `"method":"bands"` (no stem separation yet), one 11-bar section, Kick `[0,4,8,…,28]`, Clap `[4,12,20,28]`, Hi-hat every even 16th.

### Stem separation (once)

Detection is cleaner when the song is split into drums, bass, vocals and the rest first. That runs on this Mac with demucs-mlx (MIT licence; Demucs on Apple's MLX). It needs a one-time install into `.stems/` in the ginosa folder: a Python environment (a few hundred MB) and, on its first run, the model (htdemucs, about 160 MB from Hugging Face). Nothing is sent anywhere after that. To remove it all, delete the `.stems` folder.

```
npm run stems-setup
```

- [ ] It ends with **✓ Split song_120bpm.wav into drums, bass, vocals and other in … s** and **Ready.**
- [ ] If it says pip couldn't install for your Python (your Mac's Python is 3.15, newer than some of MLX's audio packages may be built for), run `brew install python@3.12`, then `npm run stems-setup` again: it picks 3.12 first.
- [ ] `npm run doctor` now shows **demucs-mlx installed (1.6.1)** under Stem separation.

Then detection again, now from the stems:

```
npm run snapshot -- --scenario rackdetect
cat renders/ui/rackdetect.json
npm start
```

- [ ] `rackdetect` says `"method":"stems"`. The test drums are synthetic and Demucs learned from real music, so tell me what it found if the verdict is `fail`. Your songs are the real test (below).

## Your song on A1

- [ ] In a project with nothing on A1, the A1 lane says **♪ Drop the song here**. Drop a song there.
- [ ] Set the tempo with the Control Panel's sparkles (or type it on the knob).
- [ ] Open the **Channel Rack** (Control Panel). Press its sparkles (**Detect**). The rack's top bar says what it's doing; with stems: *Separating the song into drums, bass and vocals…*, then *Finding kick, clap, hi-hat in the drums…* and *bass in the bass*. The first time takes a while; the stems are kept in the project's cache, so detecting again is quick.
- [ ] Kick, Clap, Hi-hat and Bass are filled (added first if they weren't there), and the song is split into sections (A, B, C…) where the pattern changes, up to 16 bars each. Undo brings back what was there.
- [ ] Tell me how it did: which channels are right, which miss hits or catch the wrong sound, and whether the sections fall where the song changes.

## Cubes

- [ ] Each cube is a 16th. A channel's cubes in a section are a 2-bar loop (32 cubes) that repeats to the section's end. They're evenly spaced keys raised out of the console; each beat's four alternate dark and light.
- [ ] Click an empty cube: it lights up (purple) and is selected. Click a lit one to select it. Drag across cubes to paint. **Backspace** deletes the selection. Cmd+A selects every cube in the section; Cmd+C / Cmd+V copy and paste cubes (with their amounts).
- [ ] **Double-click** a lit cube: the cube window lists every value linked to its channel (effect · clip), each with a slider from −100% to +100%: how far this hit moves that value, up or down. A cube that pushes a value down turns pink. Nothing else is set there.
- [ ] **Cmd+Opt+C** copies a cube's amounts (its effects); select cubes, in this section or the next, and **Cmd+Opt+V** gives them the same.

## Channels

- [ ] The **light** turns a channel on or off (its cubes stay).
- [ ] The **left/right knob** nudges its hits earlier or later, up to half a 16th. The **volume knob** is its strength, 0–150%, scaling everything it moves. Drag up or down, scroll, or use the arrow keys; double-click resets.
- [ ] Right-click a channel's name: Link Values to It, Rename…, Swing, Show Its Modulator (its rise and fall), Move Up, Move Down, Delete Channel. **+ Channel** adds one.

## Linking values to a channel

- [ ] Click a channel's name, then press **R**: *Linking to Kick* shows in the rack, and every value in Effect Controls gets a socket. Click a socket to link that value (Basic Correction's Contrast, say); click again to unlink. **R** or **Esc** ends.
- [ ] Or drag a channel's name onto a value in Effect Controls. Or right-click a value › **Link to Channel: Kick**.
- [ ] Under a linked value, its link's settings: adds or multiplies, how far it goes at 100%, and the fall (ms). The × unlinks it. The channel's name shows how many values it moves.
- [ ] Play: each lit cube moves its linked values on its 16th, by the cube's amount times the channel's strength.

## Sections

- [ ] The chips at the top: **A 8 bars**, **B …**. Click one to show its cubes; double-click to type its bars (1–16). Right-click for Change Length…, Add Empty Section After, Go to Its Start and Delete Section.
- [ ] **+** adds an empty 8-bar section after the one shown.
- [ ] The **Follow** button (the arrow) shows the section under the playhead as it plays; click it again to stop following.

## Later (on the to-do list)

- A1 as the song's track for everything (the other audio tracks for the clips' own sound), and a tool that syncs camera audio to the song on A1.
- Automation clips, then the rest of the wireframes.

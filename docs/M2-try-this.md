# M2 · Try this

M2 brings media in. You get import, bins, thumbnails, audio waveforms, a Source Monitor with In/Out marks, automatic optimised copies, relinking moved files, and the Cache Manager. Clips can't go on the timeline yet (that's M3), and sound doesn't play yet (M4). The whole checklist takes about 20 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run test-media
npm run snapshot -- --scenario waveform
open renders/ui/waveform.png
npm run snapshot -- --scenario cache
open renders/ui/cache.png
npm run dev
```

- [ ] `npm run check` ends with **Tests 93 passed (93)**.
  - New in M2: tests that run the real FFmpeg on short generated clips. They cover reading file details; detecting variable frame rate, HDR, 10-bit and far-apart keyframes; thumbnails; waveforms; making real optimised copies (ProRes, variable frame rate, and an HLG clip that must stay HDR); relinking; and the cache's delete guards.
  - The run takes a few seconds longer than M1 because it actually encodes video.
- [ ] `npm run test-media` finishes without errors.
  - `media/test/` now holds 7 files.
  - Two are new: `song_120bpm.wav`, a kick drum every half second, and `still_4k.png`.
- [ ] `waveform.png` shows the Source Monitor with the song's green waveform.
  - The waveform has 40 evenly spaced spikes.
  - A blue band on the scrubber runs from **In 00:00:04.00** to **Out 00:00:12.00**.
  - History lists *Import 7 Items, New Bin, Move to Bin, Set Marks*.
- [ ] `cache.png` shows the Cache Manager.
  - It lists the snapshot project's Thumbnails and Optimised copies with their sizes.
  - Snapshots use a temporary cache folder, so they never touch your real one.
- [ ] `npm run dev` opens the app. This tab stays busy while the app is running. Open another tab (Cmd+T) for the commands further down.

You can also screenshot the `media` and `source` scenarios. The M1 scenarios still work too.

### See the cache on disk

After you've imported something in the app (next section), run this in your spare tab:

```
ls ~/Movies/"ginosa Cache"
ls ~/Movies/"ginosa Cache"/*/
```

- [ ] You see one folder per project, named with a long ID, plus `index.json`.
- [ ] Inside a project's folder are category folders: `thumbnails`, `optimised`, and `waveforms` once you've opened audio.
- [ ] Nothing in the cache sits next to your original files. Your footage folders are unchanged.

### Prove the originals aren't touched

Pick one of your own clips. Type `shasum -a 256 ` (with the trailing space), drag the clip from Finder into Terminal to paste its path, and press Return. Copy the long code it prints somewhere. Then:

1. Import the clip, let any copy finish, and open it in the Source Monitor.
2. Clean up the project in the Cache Manager.
3. Run the same `shasum` line again (press the up arrow to get it back).

- [ ] The code is identical before and after.

### One thing I'd like to know (for M4)

Type the line below with a trailing space, drag one of your **Apple Log** clips onto Terminal, then press Return:

```
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,color_primaries,color_transfer,color_space -of default=nw=1 
```

Paste me what it prints. If you have both kinds, do it once for an Apple Log clip and once for an Apple Log 2 clip. The output tells me how your files label their colour, which M4 needs for the log conversion.

## Importing

- [ ] **Cmd+I** (or **Import…**) opens a picker that accepts files and folders, several at once.
  - A folder becomes a bin named after it, holding every media file inside it, including files in its subfolders.
- [ ] Drag files and folders from Finder onto the Media panel. Drop onto a bin's row to import straight into that bin.
- [ ] Each item gets a thumbnail; audio gets a ♪. Durations show as timecode, and Still for images.
- [ ] Importing the same file again just says *Nothing new to import*.
- [ ] Files that aren't media (a PDF, say) are ignored. A media file that can't be read is skipped, and a message names it with the reason.
- [ ] One **Cmd+Z** undoes a whole import, however many files it held.

## Bins and the list

- [ ] **+ Bin** or **Cmd+B** creates a bin with its name ready to type. Press Enter to keep the name.
- [ ] Drag items into bins, and bins into other bins. Dropping a bin into itself (or into one of its own bins) is refused.
- [ ] Click, Cmd-click and Shift-click select like Finder.
  - **Enter** renames the selected item.
  - **Delete** removes it from the project. The file on disk is never deleted.
- [ ] Right-click an item or a bin for its menu.
  - Items: Open in Source Monitor, Rename, Reveal in Finder, Create Optimised Copy (or Cancel while one is running), Locate File…, Remove from Project.
  - Bins: Import into Bin…, New Bin Inside, Rename, Delete Bin and Its Contents.
- [ ] The search box filters by name.
- [ ] Drag the panel's right edge wider. Size, FPS and Codec columns appear.

### What the status pills mean

| Pill | Meaning |
| --- | --- |
| **Optimising 42%** | An optimised copy is being made. The item uses it once finished. |
| **Waiting** | Queued behind another copy. Copies are made one at a time. |
| **Optimised** | The editor uses the copy. The original stays where it was, untouched. |
| **Needs copy** | Needs a copy that hasn't been made. Right-click → Create Optimised Copy. |
| **Slow scrub** | Keyframes are far apart, so scrubbing is sluggish. A copy is offered, never forced. |
| **Offline** | The file has moved or been deleted. Click the pill to locate it. |
| **Changed** | The file at that path has a different size from the one you imported. |
| **Copy failed** | FFmpeg couldn't make the copy. Hover for the reason. |

Copies are made automatically only when the editor can't work with a file as it is:

- a codec the Mac can't decode in the app (ProRes, for example)
- a variable frame rate (phone screen recordings, some phone clips)

HDR clips never get a copy just for being HDR. They stay HDR, and if one needs a copy for another reason, the copy stays HDR too.

Hover over a pill to see the exact reason.

## Your own footage

- [ ] Import a few of your real clips, including some Apple Log ones.
  - Log clips look flat and grey. That's correct: the log conversion and your LUTs arrive in M4.
- [ ] If a clip is ProRes, a copy starts automatically. 4K ProRes takes a while. The percentage keeps moving, and you can keep working.
- [ ] Clips shot in the iPhone's normal HDR mode import with no copy. The Codec column shows **HEVC 10-bit HLG**.
  - Until M4, the Source Monitor shows them with Chromium's own HDR-to-SDR conversion, so treat their look as approximate.
  - M4 converts them on the GPU as a per-clip setting, next to Apple Log.

## Source Monitor (⌥5)

- [ ] Double-click any item to open it in the Source Monitor.
- [ ] **Space** plays and pauses video. **← / →** step one frame; for audio they move a tenth of a second. Drag the scrubber to move freely.
- [ ] **I** and **O** (or the buttons) set In and Out. The blue band shows the range, and **Clear** removes both.
  - Each mark is one undo step.
  - Marks are saved with the project.
- [ ] Audio shows its waveform. It doesn't play yet; the monitor says so.
- [ ] An optimised clip plays from its copy. An offline clip shows a notice instead of a black frame.

## Moving files and relinking

1. Close the project.
2. In Finder, move one or two imported files into a different folder.
3. Reopen the project.

- [ ] The moved items show **Offline**, and their thumbnails remain.
- [ ] Click **Offline** (or right-click → **Locate File…**). Then either:
  - Choose the file itself. That one item relinks.
  - Choose a **folder**. ginosa searches it, including subfolders, for every missing file by name and size, and relinks all it finds.
- [ ] Relinking is undoable, and the pill disappears.

## Cache Manager (⌥6)

- [ ] It shows the cache folder and its total size, with **Show in Finder**, **Change…** and **Refresh** buttons.
- [ ] Copies in progress appear at the top with **Cancel**.
- [ ] Every project that has cached files gets a row, marked **Open** for the current one or **Project not found** if its project folder has gone.
- [ ] **Clear** on one category, or **Clean Up** for a whole project, needs a second click to confirm.
  - Clearing the open project's optimised copies sends its items back to *Needs copy* or *Optimising*.
  - Thumbnails come back on their own.
- [ ] **Change…** sets where cache files go from now on, an external SSD for example.
  - ginosa always makes a `ginosa Cache` folder inside the folder you pick and only ever deletes inside that, so nothing else in your chosen folder can be touched.
  - The old cache isn't moved. The window tells you where it is so you can delete it in Finder.
  - Clips that need copies get new ones made in the new location, and thumbnails regenerate there.

Tell me what feels slow or clumsy compared with Premiere's Project panel, especially with a big folder of real footage.

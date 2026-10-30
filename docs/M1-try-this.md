# M1 · Try this

M1 is the editor's skeleton: projects, the workspace with floating windows, undo/redo, autosave and crash recovery. There's still no media or clips (M2–M3), but everything you can change is real and saved. About 15 minutes.

## In Terminal

Open a new Terminal tab (Cmd+T), not the one running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario recovered
open renders/ui/recovered.png
npm run dev
```

- [ ] `npm run check` ends with **Tests 56 passed (56)**. That covers the timeline engine, undo/redo, the project file format, window layout, and crash recovery with a simulated crash.
- [ ] The snapshot command prints `[snapshot] recovered -> …/renders/ui/recovered.png`. A ginosa window flashes up for a moment, which is expected.
- [ ] `open renders/ui/recovered.png` shows the app after a simulated crash and restore: a vertical monitor, a track renamed **Recovered**, an **A4** track, and *Unsaved · autosaved* in the title bar.
- [ ] `npm run dev` opens the app. This tab stays busy while the app is open; that's normal. Use it for the checks below. Pressing Ctrl+C in this tab quits the app abruptly, which is handy for the crash test.

Other scenarios you can screenshot the same way: `start`, `workspace`, `windows`, `settings`, `docked`, `recovery`.

## Projects

- [ ] **New Project…** asks for a name and location (default: `Movies/ginosa Projects`). The workspace opens and the title bar shows the name.
- [ ] In Finder, the project is a folder `Name.ginosa` containing `project.json`.
- [ ] Quit (Cmd+Q) and relaunch: your project is under **Recent** on the start screen and opens with a click.

## Undo, redo, saving

- [ ] Open **Project Settings** (Window menu or ⌥1). Change the frame size to Vertical: the program monitor turns vertical.
- [ ] Add a few tracks, rename one (double-click its name in the timeline), mute or lock some.
- [ ] **Cmd+Z** steps back through each change; **Shift+Cmd+Z** steps forward. The Edit menu names what will be undone.
- [ ] **History** (⌥2) lists every step. Click an earlier row to jump back; click a later one to go forward again.
- [ ] The orange dot by the project name means unsaved. **Cmd+S** clears it. Undo back to the saved point and the dot disappears too.
- [ ] Close the window with unsaved changes: you're asked Save / Don't Save / Cancel.

## Crash recovery (the important one)

- [ ] Make a few changes **without saving**.
- [ ] Force-quit: Option+Cmd+Esc → ginosa (or "Electron" in dev) → Force Quit. Or press Ctrl+C in the `npm run dev` tab.
- [ ] Run `npm run dev` again. The project reopens by itself and offers **Restore changes**. After restoring, everything is back, marked unsaved.

## Floating windows

- [ ] Open Project Settings, History, Diagnostics and Playback Test (⌥1–⌥4).
- [ ] Drag windows by their title bars. Near an edge or another window they snap into place.
- [ ] Resize from any edge or corner.
- [ ] **–** minimises to a tab at the bottom left; click it to restore. **□** (or double-click the title bar) maximises; do it again to restore.
- [ ] **⇥** docks a window into the right-hand column as a tab; **⇤** floats it again.
- [ ] Drag the borders between Media, Monitor, Timeline and the dock column to resize them.
- [ ] Window → Workspaces → **Save Workspace As…**, rearrange things, then switch back between your saved workspaces. Relaunch: the layout is remembered.

## The M0 tools are still here

- [ ] **Playback Test (M0)** (⌥4) opens a clip, scrubs, plays and inverts, exactly as before.
- [ ] **Diagnostics** (⌥3) shows the GPU and codec checks.

Tell me anything that feels clumsy compared with Premiere or FL Studio, even if it technically works.

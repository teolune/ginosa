import type { Command } from '@engine/project/commands'
import type { Clip, Sequence } from '@engine/project/model'
import { frameRateOf } from '@engine/project/model'
import { formatTimecode, secondsToTicks, ticksToSeconds, type Ticks } from '@engine/time'
import {
  addMarker,
  copyClips,
  deleteClips,
  linkClips,
  moveClips,
  pasteClips,
  placeMedia,
  rippleDeleteClips,
  rippleDeleteGap,
  splitAllTracks,
  splitClips,
  unlinkClips,
  type ClipboardClip,
  type EditMode
} from '@engine/timeline/edits'
import { clipEnd, editPoints, findTrack, frameTicks, sequenceEnd, toFrame, topVideoClipAt, withLinked } from '@engine/timeline/timeline'
import { mediaController } from '../state/media-controller'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { MAX_PPS, MIN_PPS, type View } from './geometry'

export type Tool = 'select' | 'razor' | 'ripple' | 'roll' | 'forward' | 'backward'

export const TOOLS: Array<{ id: Tool; label: string; key: string }> = [
  { id: 'select', label: 'Selection', key: 'V' },
  { id: 'forward', label: 'Track Select Forward', key: 'A' },
  { id: 'ripple', label: 'Ripple Edit', key: 'B' },
  { id: 'roll', label: 'Rolling Edit', key: 'N' },
  { id: 'razor', label: 'Razor', key: 'C' }
]

export interface GapSelection {
  trackId: string
  start: Ticks
  end: Ticks
}

/** Things dragged into the timeline from the Media panel or the Source Monitor. */
export interface MediaDrag {
  items: Array<{ mediaId: string; sourceIn: Ticks; sourceOut: Ticks | null }>
}

/**
 * Timeline state that isn't part of the project (so it isn't undone or saved):
 * playhead, selection, tool, zoom and scroll, plus the live preview while dragging.
 * Every actual edit goes through the engine as a command.
 */
class TimelineController extends Observable {
  tool: Tool = 'select'
  snapping = true
  playhead: Ticks = 0
  selection = new Set<string>()
  gap: GapSelection | null = null
  view: View = { pps: 40, scroll: 0 }
  scrollY = 0
  viewportWidth = 800
  /** Shown instead of the project's sequence while a drag is in progress. */
  preview: Sequence | null = null
  snapLine: Ticks | null = null
  /** Where the Razor would cut (shown while hovering). */
  razorLine: { time: Ticks; trackId: string | null } | null = null
  marquee: { x0: number; y0: number; x1: number; y1: number } | null = null
  clipboard: ClipboardClip[] = []
  mediaDrag: MediaDrag | null = null
  private projectId: string | null = null

  constructor() {
    super()
    projectController.subscribe(() => this.onProjectChange())
  }

  get sequence(): Sequence | null {
    return this.preview ?? projectController.project?.sequence ?? null
  }

  private get committed(): Sequence | null {
    return projectController.project?.sequence ?? null
  }

  private onProjectChange(): void {
    const project = projectController.project
    if ((project?.id ?? null) !== this.projectId) {
      this.projectId = project?.id ?? null
      this.playhead = 0
      this.selection.clear()
      this.gap = null
      this.view = { pps: 40, scroll: 0 }
      this.scrollY = 0
      this.preview = null
      this.notify()
      return
    }
    if (!project) return
    const ids = new Set(project.sequence.clips.map((c) => c.id))
    let changed = false
    for (const id of this.selection) {
      if (!ids.has(id)) {
        this.selection.delete(id)
        changed = true
      }
    }
    if (changed) this.notify()
  }

  changed(): void {
    this.notify()
  }

  frame(): Ticks {
    const sequence = this.committed
    return sequence ? frameTicks(sequence) : secondsToTicks(1 / 25)
  }

  timecode(time: Ticks): string {
    const sequence = this.committed
    return sequence ? formatTimecode(time, frameRateOf(sequence.settings)) : ''
  }

  // ---- Edits ---------------------------------------------------------------------

  /** Runs an engine command; errors and notices appear in the toast. */
  run(command: Command): boolean {
    return projectController.dispatch(command)
  }

  private selectedClips(): Clip[] {
    const sequence = this.committed
    if (!sequence) return []
    return sequence.clips.filter((c) => this.selection.has(c.id))
  }

  deleteSelection(ripple: boolean): void {
    if (this.gap && this.selection.size === 0) {
      if (this.run(rippleDeleteGap(this.gap.trackId, this.gap.start, this.gap.end))) this.gap = null
      this.notify()
      return
    }
    const ids = [...this.selection]
    if (ids.length === 0) return
    if (this.run(ripple ? rippleDeleteClips(ids) : deleteClips(ids))) this.selection.clear()
    this.notify()
  }

  /** Cmd+K: split the selected clips at the playhead, or every track if nothing is selected. */
  splitAtPlayhead(allTracks: boolean): void {
    const ids = [...this.selection]
    if (allTracks || ids.length === 0) this.run(splitAllTracks(this.playhead))
    else this.run(splitClips(ids, this.playhead))
  }

  nudge(frames: number, trackDirection: number): void {
    const clips = this.selectedClips()
    if (clips.length === 0) return
    // Up on screen is a higher video track but a lower audio track.
    const offset = trackDirection === 0 ? 0 : clips.some((c) => c.kind === 'video') ? trackDirection : -trackDirection
    this.run(moveClips({ clipIds: clips.map((c) => c.id), delta: frames * this.frame(), trackOffset: offset, mode: 'overwrite', copy: false }))
  }

  toggleLink(): void {
    const clips = this.selectedClips()
    if (clips.length === 0) return
    if (clips.some((c) => c.linkId)) this.run(unlinkClips(clips.map((c) => c.id)))
    else this.run(linkClips(clips.map((c) => c.id)))
  }

  copy(): boolean {
    const sequence = this.committed
    if (!sequence || this.selection.size === 0) return false
    this.clipboard = copyClips(sequence, [...this.selection])
    return true
  }

  cut(): void {
    if (this.copy()) this.deleteSelection(false)
  }

  paste(mode: EditMode): void {
    if (this.clipboard.length === 0) return
    const created: string[] = []
    const command = pasteClips(this.clipboard, this.playhead, mode, () => {
      const id = globalThis.crypto.randomUUID()
      created.push(id)
      return id
    })
    if (this.run(command)) {
      const sequence = this.committed!
      const pasted = sequence.clips.filter((c) => created.includes(c.id))
      this.selection = new Set(pasted.map((c) => c.id))
      this.gap = null
      this.setPlayhead(Math.max(...pasted.map(clipEnd)))
    }
  }

  addMarkerAtPlayhead(): void {
    this.run(addMarker(this.playhead))
  }

  /** Insert (,) or Overwrite (.) from the Source Monitor at the playhead, onto the lowest unlocked tracks. */
  editFromSource(mode: EditMode): void {
    const project = projectController.project
    const item = project?.media.find((m) => m.id === mediaController.sourceId)
    if (!project || !item) {
      projectController.showMessage('Open a clip in the Source Monitor first (double-click it in Media)')
      return
    }
    const sequence = project.sequence
    const video = sequence.tracks.find((t) => t.kind === 'video' && !t.locked)
    const audio = sequence.tracks.find((t) => t.kind === 'audio' && !t.locked)
    const placed = this.placeMedia({ mediaId: item.id, sourceIn: item.marks.in ?? 0, sourceOut: item.marks.out }, this.playhead, video?.id ?? null, audio?.id ?? null, mode)
    if (placed.length) this.setPlayhead(Math.max(...placed.map(clipEnd)))
  }

  /** Places media (one after another for several items); returns the new clips. */
  placeMedia(
    item: { mediaId: string; sourceIn: Ticks; sourceOut: Ticks | null },
    at: Ticks,
    videoTrackId: string | null,
    audioTrackId: string | null,
    mode: EditMode
  ): Clip[] {
    const created: string[] = []
    const command = placeMedia({ ...item, at, videoTrackId, audioTrackId, mode }, () => {
      const id = globalThis.crypto.randomUUID()
      created.push(id)
      return id
    })
    if (!this.run(command)) return []
    const clips = this.committed!.clips.filter((c) => created.includes(c.id))
    this.selection = new Set(clips.map((c) => c.id))
    this.gap = null
    this.notify()
    return clips
  }

  /** F: shows the clip under the playhead in the Source Monitor, at the same frame (a selected clip first). */
  matchFrame(): void {
    const sequence = this.committed
    if (!sequence) return
    const under = (c: Clip) => c.start <= this.playhead && clipEnd(c) > this.playhead
    const clip = sequence.clips.find((c) => this.selection.has(c.id) && under(c)) ?? topVideoClipAt(sequence, this.playhead) ?? sequence.clips.find(under)
    if (!clip) {
      projectController.showMessage('No clip under the playhead')
      return
    }
    mediaController.openInSource(clip.mediaId, clip.sourceIn + (this.playhead - clip.start))
    workspaceController.open('source-monitor')
  }

  // ---- Selection -----------------------------------------------------------------

  select(ids: string[], mode: 'replace' | 'toggle' | 'add'): void {
    if (mode === 'replace') this.selection = new Set(ids)
    else if (mode === 'add') for (const id of ids) this.selection.add(id)
    else {
      const allSelected = ids.every((id) => this.selection.has(id))
      for (const id of ids) {
        if (allSelected) this.selection.delete(id)
        else this.selection.add(id)
      }
    }
    this.gap = null
    this.notify()
  }

  selectGap(gap: GapSelection | null): void {
    this.selection.clear()
    this.gap = gap
    this.notify()
  }

  selectAll(): void {
    const sequence = this.committed
    if (!sequence) return
    const unlocked = new Set(sequence.tracks.filter((t) => !t.locked).map((t) => t.id))
    this.select(sequence.clips.filter((c) => unlocked.has(c.trackId)).map((c) => c.id), 'replace')
  }

  deselect(): void {
    this.selection.clear()
    this.gap = null
    this.notify()
  }

  /** Track Select Forward/Backward: every clip from `time` on (or up to it), on all tracks or one. */
  selectFrom(time: Ticks, direction: 'forward' | 'backward', trackId: string | null, additive: boolean): void {
    const sequence = this.committed
    if (!sequence) return
    const ids = sequence.clips
      .filter((c) => (trackId ? c.trackId === trackId : !findTrack(sequence, c.trackId).locked))
      .filter((c) => (direction === 'forward' ? clipEnd(c) > time : c.start < time))
      .map((c) => c.id)
    this.select(ids, additive ? 'add' : 'replace')
  }

  /** Clicking a clip selects it with its linked partners, unless Option is held. */
  expand(ids: string[], linked: boolean): string[] {
    const sequence = this.committed
    return sequence && linked ? withLinked(sequence, ids) : ids
  }

  // ---- Playhead, zoom and scroll ---------------------------------------------------

  setPlayhead(time: Ticks, reveal = true): void {
    const sequence = this.committed
    const frame = this.frame()
    this.playhead = Math.max(0, toFrame(time, frame))
    if (sequence && reveal) this.reveal(this.playhead)
    this.notify()
  }

  stepFrames(frames: number): void {
    this.setPlayhead(this.playhead + frames * this.frame())
  }

  /** Up/Down: previous or next edit point on any track. */
  gotoEdit(direction: 1 | -1): void {
    const sequence = this.committed
    if (!sequence) return
    const points = [...editPoints(sequence), ...sequence.markers.map((m) => m.time)]
    const target = direction > 0 ? points.filter((p) => p > this.playhead).sort((a, b) => a - b)[0] : points.filter((p) => p < this.playhead).sort((a, b) => b - a)[0]
    if (target !== undefined) this.setPlayhead(target)
  }

  gotoMarker(direction: 1 | -1): void {
    const markers = this.committed?.markers ?? []
    const target = direction > 0 ? markers.find((m) => m.time > this.playhead) : [...markers].reverse().find((m) => m.time < this.playhead)
    if (target) this.setPlayhead(target.time)
  }

  gotoEnd(end: boolean): void {
    const sequence = this.committed
    this.setPlayhead(end && sequence ? sequenceEnd(sequence) : 0)
  }

  /** Scrolls just enough to show `time`. */
  reveal(time: Ticks): void {
    const seconds = ticksToSeconds(time)
    const width = this.viewportWidth / this.view.pps
    if (seconds < this.view.scroll) this.view = { ...this.view, scroll: Math.max(0, seconds - width * 0.1) }
    else if (seconds > this.view.scroll + width * 0.98) this.view = { ...this.view, scroll: seconds - width * 0.9 }
  }

  /** Zooms around a point on screen (the playhead if it's visible, else the middle). */
  zoom(factor: number, anchorX?: number): void {
    const pps = Math.min(MAX_PPS, Math.max(MIN_PPS, this.view.pps * factor))
    const playheadX = (ticksToSeconds(this.playhead) - this.view.scroll) * this.view.pps
    const x = anchorX ?? (playheadX >= 0 && playheadX <= this.viewportWidth ? playheadX : this.viewportWidth / 2)
    const anchor = this.view.scroll + x / this.view.pps
    this.view = { pps, scroll: Math.max(0, anchor - x / pps) }
    this.notify()
  }

  zoomToFit(): void {
    const sequence = this.committed
    const seconds = Math.max(10, ticksToSeconds(sequence ? sequenceEnd(sequence) : 0) * 1.05)
    this.view = { pps: Math.min(MAX_PPS, Math.max(MIN_PPS, this.viewportWidth / seconds)), scroll: 0 }
    this.notify()
  }

  scrollBy(dx: number, dy: number, maxY: number): void {
    this.view = { ...this.view, scroll: Math.max(0, this.view.scroll + dx / this.view.pps) }
    this.scrollY = Math.min(Math.max(0, maxY), Math.max(0, this.scrollY + dy))
    this.notify()
  }

  setTool(tool: Tool): void {
    this.tool = tool
    this.razorLine = null
    this.notify()
  }

  toggleSnapping(): void {
    this.snapping = !this.snapping
    this.notify()
  }

  // ---- Keyboard --------------------------------------------------------------------

  /**
   * Premiere's shortcuts. `focus` says where keyboard focus is: tool keys work
   * anywhere outside text fields; editing keys need the timeline focused, and
   * Insert/Overwrite also work from the Source Monitor.
   */
  handleKey(event: KeyboardEvent, focus: 'timeline' | 'source' | 'other'): boolean {
    const key = event.key
    const lower = key.toLowerCase()
    const cmd = event.metaKey || event.ctrlKey
    const plain = !cmd && !event.altKey

    if (plain && !event.shiftKey) {
      const tools: Record<string, Tool> = { v: 'select', c: 'razor', b: 'ripple', n: 'roll', a: 'forward' }
      if (tools[lower]) {
        this.setTool(tools[lower])
        return true
      }
      if (lower === 's') {
        this.toggleSnapping()
        return true
      }
    }
    if (plain && event.shiftKey && lower === 'a') {
      this.setTool('backward')
      return true
    }
    if (cmd && lower === 'k') {
      this.splitAtPlayhead(event.shiftKey)
      return true
    }
    if ((focus === 'timeline' || focus === 'source') && plain && (key === ',' || key === '.')) {
      this.editFromSource(key === ',' ? 'insert' : 'overwrite')
      return true
    }
    if (focus !== 'timeline') return false

    const shift = event.shiftKey
    if (event.altKey && !cmd && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      this.nudge((key === 'ArrowLeft' ? -1 : 1) * (shift ? 5 : 1), 0)
      return true
    }
    if (event.altKey && !cmd && (key === 'ArrowUp' || key === 'ArrowDown')) {
      this.nudge(0, key === 'ArrowUp' ? 1 : -1)
      return true
    }
    if ((key === 'Delete' || key === 'Backspace') && !cmd) {
      this.deleteSelection(shift || event.altKey)
      return true
    }
    if (cmd) {
      if (lower === 'l') this.toggleLink()
      else if (lower === 'a' && shift) this.deselect()
      else if (lower === 'a') this.selectAll()
      else if (lower === 'c') this.copy()
      else if (lower === 'x') this.cut()
      else if (lower === 'v') this.paste(shift ? 'insert' : 'overwrite')
      else if (lower === 'm' && shift) this.gotoMarker(-1)
      else return false
      return true
    }
    if (event.altKey) return false
    switch (key) {
      case 'ArrowLeft':
        this.stepFrames(shift ? -5 : -1)
        return true
      case 'ArrowRight':
        this.stepFrames(shift ? 5 : 1)
        return true
      case 'ArrowUp':
        this.gotoEdit(-1)
        return true
      case 'ArrowDown':
        this.gotoEdit(1)
        return true
      case 'Home':
        this.gotoEnd(false)
        return true
      case 'End':
        this.gotoEnd(true)
        return true
      case '=':
      case '+':
        this.zoom(1.5)
        return true
      case '-':
      case '_':
        this.zoom(1 / 1.5)
        return true
      case '\\':
        this.zoomToFit()
        return true
      case 'Escape':
        this.deselect()
        return true
      case ' ':
      case 'j':
      case 'J':
      case 'k':
      case 'K':
      case 'l':
      case 'L':
        projectController.showMessage('Timeline playback (Space, J, K, L) arrives in M4. Use the arrow keys to step for now.')
        return true
    }
    if (lower === 'm') {
      if (shift) this.gotoMarker(1)
      else this.addMarkerAtPlayhead()
      return true
    }
    if (lower === 'f' && !shift) {
      this.matchFrame()
      return true
    }
    return false
  }
}

export const timelineController = new TimelineController()

import { produce } from 'immer'
import { CommandError } from '@engine/project/commands'
import type { Clip, Marker, Sequence } from '@engine/project/model'
import type { Ticks } from '@engine/time'
import {
  applyMove,
  applyRippleTrim,
  applyRoll,
  applyTrim,
  moveClips,
  moveMarker,
  rippleTrimClips,
  rollEdit,
  splitAllTracks,
  splitClips,
  trimClips,
  type Edge,
  type EditMode,
  type MoveRequest
} from '@engine/timeline/edits'
import { snapDelta, snapTargets, snapTime } from '@engine/timeline/snapping'
import { EditContext, clipEnd, findTrack, gapAt, trackIndex, toFrame } from '@engine/timeline/timeline'
import { mediaController } from '../state/media-controller'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { EDGE_GRAB, RULER_HEIGHT, SNAP_PIXELS, layoutRows, pixelsToTicks, rowAt, timeToX, xToTime, type Row } from './geometry'
import { timelineController as tl } from './timeline-controller'

export type Hit =
  | { kind: 'ruler'; time: Ticks; marker: Marker | null }
  | { kind: 'clip'; clip: Clip; row: Row; edge: Edge | null; time: Ticks }
  | { kind: 'lane'; row: Row; time: Ticks }
  | { kind: 'none'; time: Ticks }

type TrimMode = 'trim' | 'ripple' | 'roll'

type Drag =
  | { type: 'pending'; x0: number; y0: number; clip: Clip; row: Row; ids: string[] }
  | { type: 'move'; x0: number; y0: number; clip: Clip; row: Row; ids: string[]; request: MoveRequest; valid: boolean; error: string | null }
  | { type: 'trim'; mode: TrimMode; x0: number; clip: Clip; edge: Edge; ids: string[]; delta: Ticks; moved: boolean }
  | { type: 'marquee'; x0: number; y0: number; additive: boolean; base: Set<string> }
  | { type: 'playhead' }
  | { type: 'marker'; marker: Marker; x0: number; time: Ticks; moved: boolean }

const DRAG_THRESHOLD = 3

function committed(): Sequence | null {
  return projectController.project?.sequence ?? null
}

/** Records ids an edit creates, so the new clips can be selected afterwards. */
function recordingIds(): { ids: string[]; newId: () => string } {
  const ids: string[] = []
  return {
    ids,
    newId: () => {
      const id = globalThis.crypto.randomUUID()
      ids.push(id)
      return id
    }
  }
}

function snapThreshold(): Ticks {
  return pixelsToTicks(SNAP_PIXELS, tl.view)
}

export function hitTest(x: number, y: number, edgeZone = EDGE_GRAB): Hit {
  const sequence = tl.sequence
  const time = xToTime(x, tl.view)
  if (!sequence) return { kind: 'none', time }
  if (y < RULER_HEIGHT) {
    const marker = sequence.markers.find((m) => Math.abs(timeToX(m.time, tl.view) - x) <= 6) ?? null
    return { kind: 'ruler', time, marker }
  }
  const rows = layoutRows(sequence)
  const row = rowAt(rows, y - RULER_HEIGHT + tl.scrollY)
  if (!row) return { kind: 'none', time }
  const clips = sequence.clips.filter((c) => c.trackId === row.track.id)
  let best: { clip: Clip; edge: Edge | null; distance: number } | null = null
  for (const clip of clips) {
    const left = timeToX(clip.start, tl.view)
    const right = timeToX(clipEnd(clip), tl.view)
    const zone = Math.min(edgeZone, (right - left) / 3)
    if (x >= left - zone / 2 && x <= right + zone / 2) {
      let edge: Edge | null = null
      let distance = 0
      if (Math.abs(x - left) <= zone) {
        edge = 'in'
        distance = Math.abs(x - left)
      } else if (Math.abs(x - right) <= zone) {
        edge = 'out'
        distance = Math.abs(x - right)
      } else if (x < left || x > right) continue
      if (!best || distance < best.distance) best = { clip, edge, distance }
    }
  }
  if (best) return { kind: 'clip', clip: best.clip, row, edge: best.edge, time }
  return { kind: 'lane', row, time }
}

/** Mouse handling for the timeline canvas. Coordinates are relative to the canvas. */
export class TimelineInteraction {
  private drag: Drag | null = null
  menu: ((x: number, y: number, hit: Hit) => void) | null = null

  get active(): boolean {
    return this.drag !== null && this.drag.type !== 'pending'
  }

  cursor(x: number, y: number, event: { shiftKey: boolean; altKey: boolean; metaKey: boolean }): string {
    if (this.drag?.type === 'move') return event.altKey ? 'copy' : 'grabbing'
    if (this.drag?.type === 'trim' || this.drag?.type === 'marker') return 'ew-resize'
    const hit = hitTest(x, y, this.edgeZone())
    if (hit.kind === 'ruler') return hit.marker ? 'ew-resize' : 'pointer'
    if (tl.tool === 'razor') return hit.kind === 'clip' || event.shiftKey ? 'crosshair' : 'default'
    if (tl.tool === 'forward') return 'e-resize'
    if (tl.tool === 'backward') return 'w-resize'
    if (hit.kind === 'clip' && hit.edge) {
      const locked = this.locked(hit.clip)
      if (locked) return 'not-allowed'
      return tl.tool === 'roll' ? 'col-resize' : 'ew-resize'
    }
    return 'default'
  }

  private edgeZone(): number {
    return tl.tool === 'ripple' || tl.tool === 'roll' ? EDGE_GRAB * 2 : EDGE_GRAB
  }

  private locked(clip: Clip): boolean {
    const sequence = committed()
    return !sequence || findTrack(sequence, clip.trackId).locked
  }

  hover(x: number, y: number, shiftKey: boolean): void {
    if (this.drag) return
    if (tl.tool !== 'razor') {
      if (tl.razorLine) {
        tl.razorLine = null
        tl.changed()
      }
      return
    }
    const hit = hitTest(x, y)
    if (hit.kind === 'clip' || (shiftKey && hit.kind !== 'ruler')) {
      const time = this.snapped(hit.time, new Set())
      tl.razorLine = { time, trackId: shiftKey ? null : hit.kind === 'clip' ? hit.row.track.id : null }
    } else tl.razorLine = null
    tl.changed()
  }

  leave(): void {
    if (tl.razorLine) {
      tl.razorLine = null
      tl.changed()
    }
  }

  /** Time snapped to the frame grid and (when snapping is on) to nearby edit points. */
  private snapped(time: Ticks, exclude: Set<string>, force = false): Ticks {
    const sequence = committed()
    const frame = tl.frame()
    const onFrame = toFrame(time, frame)
    if (!sequence || (!tl.snapping && !force)) {
      tl.snapLine = null
      return onFrame
    }
    const result = snapTime(onFrame, snapTargets(sequence, { playhead: tl.playhead, exclude }), snapThreshold())
    tl.snapLine = result.target
    return result.time
  }

  down(event: PointerEvent, x: number, y: number): void {
    const sequence = committed()
    if (!sequence || event.button !== 0) return
    const hit = hitTest(x, y, this.edgeZone())

    if (hit.kind === 'ruler') {
      if (hit.marker) {
        this.drag = { type: 'marker', marker: hit.marker, x0: x, time: hit.marker.time, moved: false }
        return
      }
      this.drag = { type: 'playhead' }
      tl.setPlayhead(this.snapped(hit.time, new Set(), event.shiftKey), false)
      return
    }
    if (hit.kind === 'none') return

    const additive = event.shiftKey || event.metaKey
    switch (tl.tool) {
      case 'razor': {
        const time = this.snapped(hit.time, new Set())
        tl.snapLine = null
        if (event.shiftKey) tl.run(splitAllTracks(time))
        else if (hit.kind === 'clip') tl.run(splitClips(tl.expand([hit.clip.id], !event.altKey), time))
        return
      }
      case 'forward':
      case 'backward': {
        const from = hit.kind === 'clip' ? (tl.tool === 'forward' ? hit.clip.start : clipEnd(hit.clip)) : hit.time
        tl.selectFrom(tl.tool === 'forward' ? from : from + 1, tl.tool, event.shiftKey ? hit.row.track.id : null, event.metaKey)
        return
      }
    }

    if (hit.kind === 'lane') {
      this.drag = { type: 'marquee', x0: x, y0: y, additive, base: additive ? new Set(tl.selection) : new Set() }
      return
    }

    // A clip.
    if (this.locked(hit.clip)) return
    if (hit.edge && (tl.tool === 'select' || tl.tool === 'ripple' || tl.tool === 'roll')) {
      const mode: TrimMode = tl.tool === 'roll' ? 'roll' : tl.tool === 'ripple' || event.metaKey ? 'ripple' : 'trim'
      const ids = mode === 'roll' ? [hit.clip.id] : tl.expand([hit.clip.id], !event.altKey)
      this.drag = { type: 'trim', mode, x0: x, clip: hit.clip, edge: hit.edge, ids, delta: 0, moved: false }
      return
    }
    const ids = tl.expand([hit.clip.id], !event.altKey)
    if (additive) tl.select(ids, 'toggle')
    else if (!tl.selection.has(hit.clip.id)) tl.select(ids, 'replace')
    // Only the Selection tool moves clips; the trim tools just select them.
    if (tl.tool === 'select' && tl.selection.has(hit.clip.id)) this.drag = { type: 'pending', x0: x, y0: y, clip: hit.clip, row: hit.row, ids: [...tl.selection] }
  }

  move(event: PointerEvent, x: number, y: number): void {
    const drag = this.drag
    const sequence = committed()
    if (!drag || !sequence) return
    switch (drag.type) {
      case 'playhead':
        tl.setPlayhead(this.snapped(xToTime(x, tl.view), new Set(), event.shiftKey), false)
        return
      case 'marker': {
        if (Math.abs(x - drag.x0) < DRAG_THRESHOLD && !drag.moved) return
        drag.moved = true
        drag.time = this.snapped(xToTime(x, tl.view), new Set())
        tl.preview = produce(sequence, (d) => {
          const marker = d.markers.find((m) => m.id === drag.marker.id)
          if (marker) marker.time = drag.time
        })
        tl.changed()
        return
      }
      case 'marquee': {
        tl.marquee = { x0: drag.x0, y0: drag.y0, x1: x, y1: y }
        const t0 = xToTime(Math.min(drag.x0, x), tl.view)
        const t1 = xToTime(Math.max(drag.x0, x), tl.view)
        const rows = layoutRows(sequence)
        const yTop = Math.min(drag.y0, y) - RULER_HEIGHT + tl.scrollY
        const yBottom = Math.max(drag.y0, y) - RULER_HEIGHT + tl.scrollY
        const tracks = new Set(rows.rows.filter((r) => r.top < yBottom && r.top + r.height > yTop && !r.track.locked).map((r) => r.track.id))
        const hits = sequence.clips.filter((c) => tracks.has(c.trackId) && c.start < t1 && clipEnd(c) > t0).map((c) => c.id)
        tl.selection = new Set([...drag.base, ...tl.expand(hits, !event.altKey)])
        tl.gap = null
        tl.changed()
        return
      }
      case 'pending': {
        if (Math.hypot(x - drag.x0, y - drag.y0) < DRAG_THRESHOLD) return
        this.drag = {
          type: 'move',
          x0: drag.x0,
          y0: drag.y0,
          clip: drag.clip,
          row: drag.row,
          ids: drag.ids,
          request: { clipIds: drag.ids, delta: 0, trackOffset: 0, mode: 'overwrite', copy: false },
          valid: true,
          error: null
        }
        this.move(event, x, y)
        return
      }
      case 'move': {
        const frame = tl.frame()
        let delta = toFrame(pixelsToTicks(x - drag.x0, tl.view), frame)
        const moving = sequence.clips.filter((c) => drag.ids.includes(c.id))
        const earliest = Math.min(...moving.map((c) => c.start))
        tl.snapLine = null
        if (tl.snapping) {
          const targets = snapTargets(sequence, { playhead: tl.playhead, exclude: new Set(drag.ids) })
          const edges = moving.flatMap((c) => [c.start, clipEnd(c)])
          const snapped = snapDelta(edges, delta, targets, snapThreshold())
          delta = snapped.delta
          tl.snapLine = snapped.target
        }
        delta = Math.max(delta, -earliest)
        // Track offset from the row under the pointer, if it holds the grabbed clip's kind.
        const rows = layoutRows(sequence)
        const row = rowAt(rows, y - RULER_HEIGHT + tl.scrollY)
        let offset = drag.request.trackOffset
        if (row && row.track.kind === drag.row.track.kind) offset = trackIndex(sequence, row.track) - trackIndex(sequence, drag.row.track)
        const mode: EditMode = event.metaKey ? 'insert' : 'overwrite'
        drag.request = { clipIds: drag.ids, delta, trackOffset: offset, mode, copy: event.altKey }
        try {
          tl.preview = produce(sequence, (d) => {
            applyMove(d, drag.request, new EditContext(() => globalThis.crypto.randomUUID()))
          })
          drag.valid = true
          drag.error = null
        } catch (error) {
          if (!(error instanceof CommandError)) throw error
          drag.valid = false
          drag.error = error.message
        }
        tl.changed()
        return
      }
      case 'trim': {
        if (!drag.moved && Math.abs(x - drag.x0) < DRAG_THRESHOLD) return
        drag.moved = true
        const media = projectController.project?.media ?? []
        let delta = toFrame(pixelsToTicks(x - drag.x0, tl.view), tl.frame())
        const edgeTime = drag.edge === 'in' ? drag.clip.start : clipEnd(drag.clip)
        tl.snapLine = null
        if (tl.snapping) {
          const targets = snapTargets(sequence, { playhead: tl.playhead, exclude: new Set(drag.ids) })
          const snapped = snapTime(edgeTime + delta, targets, snapThreshold())
          delta = snapped.time - edgeTime
          tl.snapLine = snapped.target
        }
        try {
          tl.preview = produce(sequence, (d) => {
            const ctx = new EditContext(() => globalThis.crypto.randomUUID())
            if (drag.mode === 'trim') drag.delta = applyTrim(d, media, { clipIds: drag.ids, edge: drag.edge, delta })
            else if (drag.mode === 'ripple') drag.delta = applyRippleTrim(d, media, { clipIds: drag.ids, edge: drag.edge, delta }, ctx)
            else drag.delta = applyRoll(d, media, { clipId: drag.clip.id, edge: drag.edge, delta })
          })
        } catch (error) {
          if (!(error instanceof CommandError)) throw error
        }
        tl.changed()
      }
    }
  }

  up(event: PointerEvent, x: number, y: number): void {
    const drag = this.drag
    this.drag = null
    tl.preview = null
    tl.snapLine = null
    tl.marquee = null
    const sequence = committed()
    if (!drag || !sequence) {
      tl.changed()
      return
    }
    switch (drag.type) {
      case 'marker':
        if (drag.moved) tl.run(moveMarker(drag.marker.id, drag.time))
        else tl.setPlayhead(drag.marker.time, false)
        break
      case 'marquee':
        if (Math.hypot(x - drag.x0, y - drag.y0) < DRAG_THRESHOLD) {
          // A click on empty track space: select the gap there, if any.
          const hit = hitTest(x, y)
          const gap = hit.kind === 'lane' && !hit.row.track.locked ? gapAt(sequence, hit.row.track.id, hit.time) : null
          tl.selectGap(gap ? { trackId: hit.kind === 'lane' ? hit.row.track.id : '', ...gap } : null)
        }
        break
      case 'move': {
        if (!drag.valid) {
          if (drag.error) projectController.showMessage(drag.error)
          break
        }
        if (drag.request.delta === 0 && drag.request.trackOffset === 0 && !drag.request.copy) break
        const ids = recordingIds()
        if (tl.run(moveClips(drag.request, ids.newId)) && drag.request.copy) {
          const created = new Set(ids.ids)
          tl.select((projectController.project?.sequence.clips ?? []).filter((c) => created.has(c.id)).map((c) => c.id), 'replace')
        }
        break
      }
      case 'trim':
        if (!drag.moved || drag.delta === 0) break
        if (drag.mode === 'trim') tl.run(trimClips({ clipIds: drag.ids, edge: drag.edge, delta: drag.delta }))
        else if (drag.mode === 'ripple') tl.run(rippleTrimClips({ clipIds: drag.ids, edge: drag.edge, delta: drag.delta }))
        else tl.run(rollEdit({ clipId: drag.clip.id, edge: drag.edge, delta: drag.delta }))
        break
    }
    void event
    tl.changed()
  }

  cancel(): void {
    this.drag = null
    tl.preview = null
    tl.snapLine = null
    tl.marquee = null
    tl.changed()
  }

  doubleClick(x: number, y: number): void {
    const hit = hitTest(x, y)
    if (hit.kind !== 'clip') return
    mediaController.openInSource(hit.clip.mediaId, hit.clip.sourceIn + Math.max(0, hit.time - hit.clip.start))
    workspaceController.open('source-monitor')
  }
}

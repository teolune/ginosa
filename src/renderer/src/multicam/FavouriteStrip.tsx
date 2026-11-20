import type { Clip, MulticamAngle, MulticamGroup, Sequence } from '@engine/project/model'
import type { Ticks } from '@engine/time'
import { addFavourite, setFavourite } from '@engine/timeline/multicam-edits'
import { clipEnd, frameTicks } from '@engine/timeline/timeline'
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { multicamUi } from './multicam-ui'

/** A take's part of a strip: its file's time `sourceIn` to `sourceIn + duration`, from x0 to x1 (0–1). */
interface Lane {
  clip: Clip
  x0: number
  x1: number
}

const EDGE_PX = 5
const DRAG_PX = 3

/**
 * Where each take of an angle sits along its strip. A synced angle's strip is song time, the
 * same stretch for every synced angle (so they line up, one over another); a B-roll angle's is
 * its takes' own time, one after another.
 */
export function stripLanes(sequence: Sequence, group: MulticamGroup, angle: MulticamAngle): { lanes: Lane[]; span: { from: Ticks; to: Ticks } | null } {
  const takes = sequence.clips.filter((c) => c.trackId === angle.trackId && c.kind === 'video' && !c.adjustment && !c.multicam).sort((a, b) => a.start - b.start)
  if (angle.bRoll) {
    const total = takes.reduce((n, c) => n + c.duration, 0)
    const gap = takes.length > 1 ? 0.01 : 0
    const room = 1 - gap * (takes.length - 1)
    let x = 0
    const lanes = takes.map((clip) => {
      const w = total > 0 ? (clip.duration / total) * room : 0
      const lane = { clip, x0: x, x1: x + w }
      x += w + gap
      return lane
    })
    return { lanes, span: null }
  }
  const synced = sequence.clips.filter((c) => group.angles.some((a) => !a.bRoll && a.trackId === c.trackId) && c.kind === 'video' && !c.adjustment && !c.multicam)
  const range = multicamUi.automaticRange()
  const from = Math.min(range?.from ?? Infinity, ...synced.map((c) => c.start))
  const to = Math.max(range?.to ?? -Infinity, ...synced.map(clipEnd))
  if (!(to > from)) return { lanes: [], span: null }
  const x = (t: Ticks) => (t - from) / (to - from)
  return { lanes: takes.map((clip) => ({ clip, x0: x(clip.start), x1: x(clipEnd(clip)) })), span: { from, to } }
}

const xOf = (lane: Lane, source: Ticks) => lane.x0 + ((source - lane.clip.sourceIn) / lane.clip.duration) * (lane.x1 - lane.x0)
const sourceOf = (lane: Lane, x: number) => lane.clip.sourceIn + ((Math.min(lane.x1, Math.max(lane.x0, x)) - lane.x0) / (lane.x1 - lane.x0)) * lane.clip.duration

type Drag =
  | { mode: 'new'; lane: Lane; anchor: Ticks; startX: number; id: string | null; stroke: string }
  | { mode: 'edge'; lane: Lane; id: string; fixed: Ticks; stroke: string }
  | { mode: 'move'; lane: Lane; id: string; length: Ticks; grab: Ticks; startX: number; moved: boolean; stroke: string }

let strokes = 0

/**
 * An angle's favourites strip (W5.4): drag across it to mark a favourite part, drag a
 * favourite's ends to change it, drag its middle to move it, ⌫ deletes the one selected. The
 * playhead follows the drag and the multi-camera view is on while you drag, so you see the frame
 * you're on.
 */
export function FavouriteStrip({ group, angle }: { group: MulticamGroup; angle: MulticamAngle }) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  /** The multi-camera view, turned on while you drag (so you see the frames), and back off after. */
  const viewForDrag = useRef(false)
  const [hover, setHover] = useState<'edge' | 'move' | null>(null)
  const sequence = projectController.project?.sequence
  if (!sequence) return null
  const frame = frameTicks(sequence)
  const { lanes, span } = stripLanes(sequence, group, angle)
  const width = () => ref.current?.getBoundingClientRect().width ?? 1
  const fraction = (event: PointerEvent) => {
    const box = ref.current!.getBoundingClientRect()
    return (event.clientX - box.left) / Math.max(1, box.width)
  }
  const laneAt = (x: number) => lanes.find((l) => x >= l.x0 && x <= l.x1) ?? null
  /** The timeline time a take's frame is at (where the multi-camera view shows it). */
  const showFrame = (lane: Lane, source: Ticks) => timelineController.setPlayhead(lane.clip.start + Math.round((source - lane.clip.sourceIn) / frame) * frame, false)
  const favouriteAt = (x: number) => {
    const px = EDGE_PX / width()
    for (const f of angle.favourites) {
      const lane = lanes.find((l) => l.clip.id === f.clipId)
      if (!lane) continue
      const a = xOf(lane, f.from)
      const b = xOf(lane, f.to)
      if (Math.abs(x - a) <= px) return { f, lane, part: 'from' as const }
      if (Math.abs(x - b) <= px) return { f, lane, part: 'to' as const }
      if (x > a && x < b) return { f, lane, part: 'middle' as const }
    }
    return null
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const x = fraction(event)
    const hit = favouriteAt(x)
    const stroke = `${angle.id}:${++strokes}`
    try {
      ref.current!.setPointerCapture(event.pointerId)
    } catch {
      // A pointer the browser doesn't know (a test's): nothing to capture.
    }
    ref.current!.focus()
    if (!multicamUi.view && lanes.length) {
      viewForDrag.current = true
      multicamUi.setView(true)
    }
    if (hit && hit.part !== 'middle') {
      multicamUi.selectFavourite(angle.id, hit.f.id)
      drag.current = { mode: 'edge', lane: hit.lane, id: hit.f.id, fixed: hit.part === 'from' ? hit.f.to : hit.f.from, stroke }
      showFrame(hit.lane, hit.part === 'from' ? hit.f.from : hit.f.to)
      return
    }
    if (hit) {
      multicamUi.selectFavourite(angle.id, hit.f.id)
      drag.current = { mode: 'move', lane: hit.lane, id: hit.f.id, length: hit.f.to - hit.f.from, grab: sourceOf(hit.lane, x) - hit.f.from, startX: x, moved: false, stroke }
      showFrame(hit.lane, sourceOf(hit.lane, x))
      return
    }
    const lane = laneAt(x)
    multicamUi.selectFavourite(angle.id, null)
    if (!lane) return
    drag.current = { mode: 'new', lane, anchor: sourceOf(lane, x), startX: x, id: null, stroke }
    showFrame(lane, sourceOf(lane, x))
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const x = fraction(event)
    const d = drag.current
    if (!d) {
      const hit = favouriteAt(x)
      setHover(hit ? (hit.part === 'middle' ? 'move' : 'edge') : null)
      return
    }
    const source = sourceOf(d.lane, x)
    if (d.mode === 'new') {
      if (Math.abs(x - d.startX) * width() < DRAG_PX && d.id === null) return
      if (Math.abs(source - d.anchor) < frame) return
      if (d.id === null) {
        const command = addFavourite(group.id, angle.id, d.lane.clip.id, d.anchor, source, undefined, d.stroke)
        if (projectController.dispatch(command)) {
          d.id = command.favouriteId
          multicamUi.selectFavourite(angle.id, d.id)
        }
      } else projectController.dispatch(setFavourite(group.id, angle.id, d.id, d.anchor, source, d.stroke))
      showFrame(d.lane, source)
    } else if (d.mode === 'edge') {
      if (Math.abs(source - d.fixed) < frame) return
      projectController.dispatch(setFavourite(group.id, angle.id, d.id, d.fixed, source, d.stroke))
      showFrame(d.lane, source)
    } else {
      if (!d.moved && Math.abs(x - d.startX) * width() < DRAG_PX) return
      d.moved = true
      const lo = d.lane.clip.sourceIn
      const hi = d.lane.clip.sourceIn + d.lane.clip.duration - d.length
      const from = Math.min(hi, Math.max(lo, source - d.grab))
      projectController.dispatch(setFavourite(group.id, angle.id, d.id, from, from + d.length, d.stroke))
      showFrame(d.lane, from)
    }
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (ref.current?.hasPointerCapture(event.pointerId)) ref.current.releasePointerCapture(event.pointerId)
    drag.current = null
    if (viewForDrag.current) {
      viewForDrag.current = false
      multicamUi.setView(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === 'Backspace' || event.key === 'Delete') && multicamUi.favourite?.angleId === angle.id) {
      event.preventDefault()
      event.stopPropagation()
      multicamUi.deleteSelectedFavourite()
    }
  }

  // The playhead: song time on a synced strip; on a B-roll strip, the take frame it's on (if any).
  const at = timelineController.playhead
  const under = lanes.find((l) => at >= l.clip.start && at < clipEnd(l.clip))
  const playhead = span ? (at >= span.from && at <= span.to ? (at - span.from) / (span.to - span.from) : null) : under ? xOf(under, under.clip.sourceIn + (at - under.clip.start)) : null
  const selected = multicamUi.favourite?.angleId === angle.id ? multicamUi.favourite.id : null
  const gaps = !angle.bRoll && span ? multicamUi.gaps.filter((g) => g.groupId === group.id) : []
  return (
    <div
      ref={ref}
      className={`favourite-strip ${angle.bRoll ? 'b-roll' : ''} ${hover ? `hover-${hover}` : ''}`}
      tabIndex={0}
      role="group"
      aria-label={angle.bRoll ? 'Favourites (B-roll: the take’s own time)' : 'Favourites (song time)'}
      title={angle.bRoll ? 'B-roll: your takes one after another. Drag to mark a favourite part; Automatic places it wherever nothing synced covers' : 'Drag to mark a favourite part of this take; drag its ends to change it, ⌫ deletes it'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => !drag.current && setHover(null)}
      onKeyDown={onKeyDown}
    >
      {lanes.map((lane) => (
        <div key={lane.clip.id} className="favourite-lane" style={{ left: `${lane.x0 * 100}%`, width: `${(lane.x1 - lane.x0) * 100}%` }} title={lane.clip.name} />
      ))}
      {span &&
        gaps.map((g, i) => (
          <div key={`gap${i}`} className="favourite-gap" style={{ left: `${((g.from - span.from) / (span.to - span.from)) * 100}%`, width: `${((g.to - g.from) / (span.to - span.from)) * 100}%` }} />
        ))}
      {angle.favourites.map((f) => {
        const lane = lanes.find((l) => l.clip.id === f.clipId)
        if (!lane) return null
        const a = xOf(lane, f.from)
        const b = xOf(lane, f.to)
        return <div key={f.id} className={`favourite ${selected === f.id ? 'selected' : ''}`} style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} />
      })}
      {playhead !== null && <div className="favourite-playhead" style={{ left: `${playhead * 100}%` }} />}
      {lanes.length === 0 && <span className="favourite-empty muted small">No take on this angle’s track</span>}
    </div>
  )
}

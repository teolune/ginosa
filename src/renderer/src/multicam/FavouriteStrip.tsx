import type { Clip, MulticamAngle, MulticamGroup, Sequence } from '@engine/project/model'
import type { Ticks } from '@engine/time'
import { setFavourite } from '@engine/timeline/multicam-edits'
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
  | { mode: 'scrub' }
  | { mode: 'edge'; lane: Lane; id: string; fixed: Ticks; stroke: string }
  | { mode: 'move'; lane: Lane; id: string; length: Ticks; grab: Ticks; startX: number; moved: boolean; stroke: string }

let strokes = 0

/**
 * A clip's strip in the Multi-Camera window: its own little timeline, with the favourite parts
 * marked on it in red (W5.4; mark them with Mark Clip and M). Click or drag on it to move the
 * playhead; drag a mark's start or end to change it, its middle to move it; click one and ⌫
 * deletes it. Each drag is one undo step.
 */
export function FavouriteStrip({ group, angle }: { group: MulticamGroup; angle: MulticamAngle }) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
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
  /** The timeline time a take's frame is at (where the preview shows it). */
  const showFrame = (lane: Lane, source: Ticks) => timelineController.setPlayhead(lane.clip.start + Math.round((source - lane.clip.sourceIn) / frame) * frame, false)
  /** The playhead to where the strip was clicked: song time on a synced strip; a B-roll take's frame where it sits on the timeline. */
  const scrubTo = (x: number) => {
    if (span) {
      const t = span.from + Math.min(1, Math.max(0, x)) * (span.to - span.from)
      timelineController.setPlayhead(Math.round(t / frame) * frame, false)
      return
    }
    const lane = lanes.find((l) => x >= l.x0 && x <= l.x1) ?? lanes.reduce<Lane | null>((best, l) => (!best || Math.abs(x - (l.x0 + l.x1) / 2) < Math.abs(x - (best.x0 + best.x1) / 2) ? l : best), null)
    if (lane) showFrame(lane, sourceOf(lane, x))
  }
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
    if (hit && hit.part !== 'middle') {
      multicamUi.selectFavourite(angle.id, hit.f.id)
      drag.current = { mode: 'edge', lane: hit.lane, id: hit.f.id, fixed: hit.part === 'from' ? hit.f.to : hit.f.from, stroke }
      showFrame(hit.lane, hit.part === 'from' ? hit.f.from : hit.f.to)
      return
    }
    if (hit) {
      multicamUi.selectFavourite(angle.id, hit.f.id)
      drag.current = { mode: 'move', lane: hit.lane, id: hit.f.id, length: hit.f.to - hit.f.from, grab: sourceOf(hit.lane, x) - hit.f.from, startX: x, moved: false, stroke }
      return
    }
    multicamUi.selectFavourite(angle.id, null)
    drag.current = { mode: 'scrub' }
    scrubTo(x)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const x = fraction(event)
    const d = drag.current
    if (!d) {
      const hit = favouriteAt(x)
      setHover(hit ? (hit.part === 'middle' ? 'move' : 'edge') : null)
      return
    }
    if (d.mode === 'scrub') return scrubTo(x)
    const source = sourceOf(d.lane, x)
    if (d.mode === 'edge') {
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
    const d = drag.current
    drag.current = null
    // A click on a mark (no drag): the playhead to its start.
    if (d?.mode === 'move' && !d.moved) {
      const f = angle.favourites.find((x) => x.id === d.id)
      if (f) showFrame(d.lane, f.from)
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
  const xAt = (t: Ticks) => (span ? (t - span.from) / (span.to - span.from) : null)
  const playhead = span ? (at >= span.from && at <= span.to ? xAt(at) : null) : under ? xOf(under, under.clip.sourceIn + (at - under.clip.start)) : null
  const selected = multicamUi.favourite?.angleId === angle.id ? multicamUi.favourite.id : null
  const gaps = !angle.bRoll && span ? multicamUi.gaps.filter((g) => g.groupId === group.id) : []
  // A mark being made (M pressed once): from its in-point to the playhead.
  const pending = multicamUi.pendingIn?.angleId === angle.id ? multicamUi.pendingIn : null
  const pendingLane = pending ? lanes.find((l) => l.clip.id === pending.clipId) : undefined
  const pendingX = pending && pendingLane ? [xOf(pendingLane, pendingLane.clip.sourceIn + (pending.at - pendingLane.clip.start)), xOf(pendingLane, pendingLane.clip.sourceIn + (Math.min(clipEnd(pendingLane.clip), Math.max(pendingLane.clip.start, at)) - pendingLane.clip.start))] : null
  return (
    <div
      ref={ref}
      className={`favourite-strip ${angle.bRoll ? 'b-roll' : ''} ${hover ? `hover-${hover}` : ''}`}
      tabIndex={0}
      role="group"
      aria-label={angle.bRoll ? 'Favourite parts (B-roll: the clip’s own time)' : 'Favourite parts (song time)'}
      title={angle.bRoll ? 'B-roll: its takes one after another. Click to move the playhead; drag a mark’s start or end to change it, ⌫ deletes it' : 'Click to move the playhead; drag a mark’s start or end to change it, its middle to move it; ⌫ deletes the one selected'}
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
          <div key={`gap${i}`} className="favourite-gap" style={{ left: `${xAt(g.from)! * 100}%`, width: `${((g.to - g.from) / (span.to - span.from)) * 100}%` }} />
        ))}
      {angle.favourites.map((f) => {
        const lane = lanes.find((l) => l.clip.id === f.clipId)
        if (!lane) return null
        const a = xOf(lane, f.from)
        const b = xOf(lane, f.to)
        return (
          <div key={f.id} className={`favourite ${selected === f.id ? 'selected' : ''}`} style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }}>
            <span className="favourite-edge start" />
            <span className="favourite-edge end" />
          </div>
        )
      })}
      {pendingX && (
        <div className="favourite pending" style={{ left: `${Math.min(pendingX[0]!, pendingX[1]!) * 100}%`, width: `${Math.abs(pendingX[1]! - pendingX[0]!) * 100}%` }}>
          <span className={`favourite-edge ${pendingX[1]! >= pendingX[0]! ? 'start' : 'end'}`} />
        </div>
      )}
      {playhead !== null && <div className="favourite-playhead" style={{ left: `${playhead * 100}%` }} />}
      {lanes.length === 0 && <span className="favourite-empty muted small">No picture on this clip’s track</span>}
    </div>
  )
}

import type { Sequence } from '../project/model'
import type { Ticks } from '../time'
import { clipEnd } from './timeline'

/** Where things snap: the playhead, clip edges, markers and the sequence start. */
export function snapTargets(sequence: Sequence, options: { playhead: Ticks | null; exclude: Set<string> }): Ticks[] {
  const targets = new Set<Ticks>([0])
  if (options.playhead !== null) targets.add(options.playhead)
  for (const clip of sequence.clips) {
    if (options.exclude.has(clip.id)) continue
    targets.add(clip.start)
    targets.add(clipEnd(clip))
  }
  for (const marker of sequence.markers) targets.add(marker.time)
  return [...targets].sort((a, b) => a - b)
}

function nearest(value: Ticks, targets: Ticks[], threshold: Ticks): Ticks | null {
  let best: Ticks | null = null
  for (const target of targets) {
    const distance = Math.abs(target - value)
    if (distance <= threshold && (best === null || distance < Math.abs(best - value))) best = target
  }
  return best
}

/** Snaps a single time (a playhead drag, a razor cut, a trimmed edge). */
export function snapTime(time: Ticks, targets: Ticks[], threshold: Ticks): { time: Ticks; target: Ticks | null } {
  const target = nearest(time, targets, threshold)
  return { time: target ?? time, target }
}

/** Snaps a drag: whichever moving edge lands nearest a target pulls the whole selection onto it. */
export function snapDelta(edges: Ticks[], delta: Ticks, targets: Ticks[], threshold: Ticks): { delta: Ticks; target: Ticks | null } {
  let best: { delta: Ticks; target: Ticks; distance: number } | null = null
  for (const edge of edges) {
    const target = nearest(edge + delta, targets, threshold)
    if (target === null) continue
    const distance = Math.abs(target - (edge + delta))
    if (!best || distance < best.distance) best = { delta: target - edge, target, distance }
  }
  return best ? { delta: best.delta, target: best.target } : { delta, target: null }
}

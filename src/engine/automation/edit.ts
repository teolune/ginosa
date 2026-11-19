import { beatAt, beatTime } from '../audio/beat-grid'
import type { AutomationPoint, AutomationShape, BeatGrid, Clip } from '../project/model'
import type { Ticks } from '../time'
import { automationValue, stretchCount } from './curve'

/**
 * The automation editor's edits (W2.2, decision 127), as pure functions on a clip's points, so
 * the window only turns the mouse into them. Times are the curve's own (the clip's source time).
 */

export const SHAPE_LABELS: Record<AutomationShape, string> = {
  single: 'Single curve',
  double: 'Double curve',
  hold: 'Hold',
  stairs: 'Stairs',
  'smooth-stairs': 'Smooth stairs',
  pulse: 'Pulse',
  wave: 'Wave'
}

/** Shapes whose tension does something (a hold just holds). */
export function usesTension(shape: AutomationShape): boolean {
  return shape !== 'hold'
}

/** Stairs, pulse and wave count steps or cycles with their tension; the curves bend with it. */
export function countsWithTension(shape: AutomationShape): boolean {
  return shape === 'stairs' || shape === 'smooth-stairs' || shape === 'pulse' || shape === 'wave'
}

/** What the tension means, for the editor's readout: "8 steps", "bend +40%". */
export function tensionLabel(point: AutomationPoint): string {
  if (!usesTension(point.shape)) return ''
  if (countsWithTension(point.shape)) {
    const n = stretchCount(point.tension)
    const unit = point.shape === 'pulse' || point.shape === 'wave' ? 'cycle' : 'step'
    return `${n} ${unit}${n === 1 ? '' : 's'}`
  }
  const t = Math.round(point.tension * 100)
  return t === 0 ? 'straight' : `bend ${t > 0 ? '+' : ''}${t}%`
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/**
 * Clicking empty space adds a point there. It takes the shape and tension of the stretch it lands
 * in, so the curve on either side keeps its kind. Returns the points and the new one's index.
 */
export function insertPoint(points: readonly AutomationPoint[], time: Ticks, value: number): { points: AutomationPoint[]; index: number } {
  const t = Math.max(0, Math.round(time))
  let index = points.findIndex((p) => p.time > t)
  if (index < 0) index = points.length
  const before = points[index - 1] ?? points[0]
  const point: AutomationPoint = { time: t, value: clamp(value, 0, 1), shape: before?.shape ?? 'single', tension: before?.tension ?? 0 }
  return { points: [...points.slice(0, index), point, ...points.slice(index)], index }
}

/** Dragging a point: its time stays between its neighbours' (it can't pass them), its value 0–1. */
export function movePoint(points: readonly AutomationPoint[], index: number, time: Ticks, value: number): AutomationPoint[] {
  const prev = points[index - 1]
  const next = points[index + 1]
  const lo = prev ? prev.time : 0
  const hi = next ? next.time : Number.MAX_SAFE_INTEGER
  return points.map((p, i) => (i === index ? { ...p, time: clamp(Math.round(time), lo, hi), value: clamp(value, 0, 1) } : p))
}

/** Delete: these points go, but a curve keeps at least one (null when that would leave none). */
export function removePoints(points: readonly AutomationPoint[], indexes: readonly number[]): AutomationPoint[] | null {
  const gone = new Set(indexes)
  const kept = points.filter((_, i) => !gone.has(i))
  return kept.length === 0 ? null : kept
}

/** Right-click › a shape: the stretches from these points take it (their tension kept). */
export function setShape(points: readonly AutomationPoint[], indexes: readonly number[], shape: AutomationShape): AutomationPoint[] {
  const chosen = new Set(indexes)
  return points.map((p, i) => (chosen.has(i) ? { ...p, shape } : p))
}

/**
 * Dragging a stretch's tension handle by `dy` pixels (up is negative, as on screen) on a graph
 * `height` pixels tall. A full height's drag is a change of 2 (the whole −1…1). For a curve the
 * handle follows the mouse: up bulges the curve up, whichever way the stretch goes; for stairs,
 * pulse and wave, up makes more steps or cycles.
 */
export function dragTension(start: number, point: AutomationPoint, next: AutomationPoint | undefined, dy: number, height: number): number {
  const change = (-dy / Math.max(1, height)) * 2
  if (countsWithTension(point.shape) || !next) return clamp(start + change, -1, 1)
  const falling = next.value < point.value
  return clamp(start + (falling ? -change : change), -1, 1)
}

/** The handle of the stretch from point `index`: halfway in time, on the curve. Null for the last point. */
export function tensionHandle(points: readonly AutomationPoint[], index: number): { time: Ticks; value: number } | null {
  const a = points[index]
  const b = points[index + 1]
  if (!a || !b || b.time <= a.time) return null
  const time = Math.round((a.time + b.time) / 2)
  return { time, value: automationValue(points, time) }
}

/** The finest grid step the editor snaps to at this zoom: 16ths, 8ths, beats or bars, whichever is at least `minPx` wide. */
export function snapStepBeats(grid: BeatGrid, pixelsPerTick: number, minPx = 8): number {
  const beatPx = pixelsPerTick * (beatTime(grid, 1) - beatTime(grid, 0))
  for (const beats of [0.25, 0.5, 1, grid.beatsPerBar, grid.beatsPerBar * 4]) if (beats * beatPx >= minPx) return beats
  return grid.beatsPerBar * 16
}

/**
 * Snapping a curve time (the clip's source time) to the beat grid in `stepBeats` (or to frames with
 * no grid), measured where the clip sits on the timeline.
 */
export function snapCurveTime(time: Ticks, clip: Pick<Clip, 'start' | 'sourceIn'>, grid: BeatGrid | null, stepBeats: number, frame: Ticks): Ticks {
  const onTimeline = clip.start + (time - clip.sourceIn)
  const snapped = grid ? beatTime(grid, Math.round(beatAt(grid, onTimeline) / stepBeats) * stepBeats) : Math.round(onTimeline / frame) * frame
  return Math.max(0, Math.round(snapped - clip.start + clip.sourceIn))
}

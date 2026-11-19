import type { AutomationPoint, AutomationShape } from '../project/model'
import type { Ticks } from '../time'

/**
 * Automation curves (W2, decision 127): points joined by FL Studio's shapes. A stretch runs from
 * a point to the next; its shape and tension say how. Before the first point the curve is the
 * first point's value, after the last the last's. Values are 0–1 (a linked value's range).
 */

/** Steps or cycles for stairs, pulse and wave: 1 at tension −1, 4 at 0, 16 at +1. */
export function stretchCount(tension: number): number {
  return Math.max(1, Math.round(4 * Math.pow(4, clamp(tension, -1, 1))))
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

/** A single curve from 0 to 1: straight at tension 0, rising fast then slowly above it, slowly then fast below. */
export function bend(p: number, tension: number): number {
  const t = clamp(tension, -1, 1)
  if (t === 0) return p
  const k = Math.pow(2, 3 * Math.abs(t))
  return t > 0 ? 1 - Math.pow(1 - p, k) : Math.pow(p, k)
}

/** How far (0–1) a stretch of `shape` is from its start value to its end value, `p` (0–1) of the way along it. */
export function shapeAt(shape: AutomationShape, p: number, tension: number): number {
  const x = clamp(p, 0, 1)
  switch (shape) {
    case 'single':
      return bend(x, tension)
    case 'double':
      // Two mirrored single curves meeting halfway: an S (or its reverse below 0).
      return x < 0.5 ? 0.5 * bend(2 * x, tension) : 1 - 0.5 * bend(2 - 2 * x, tension)
    case 'hold':
      return x < 1 ? 0 : 1
    case 'stairs': {
      // n even steps up (or down), reaching the end value at the next point.
      const n = stretchCount(tension)
      return x >= 1 ? 1 : Math.floor(x * n) / n
    }
    case 'smooth-stairs': {
      const n = stretchCount(tension)
      const position = x * n
      const step = Math.min(n - 1, Math.floor(position))
      const f = position - step
      return (step + f * f * (3 - 2 * f)) / n
    }
    case 'pulse': {
      // Square cycles between the two values, ending on the end value.
      const n = stretchCount(tension)
      if (x >= 1) return 1
      return Math.floor(x * n * 2) % 2 === 0 ? 0 : 1
    }
    case 'wave': {
      // Sine cycles from the start value to the end value and back, ending on the end value's side.
      const n = stretchCount(tension)
      return 0.5 - 0.5 * Math.cos(Math.PI * (2 * n - 1) * x)
    }
  }
}

/** The curve's value (0–1) at `time` ticks into it. */
export function automationValue(points: readonly AutomationPoint[], time: Ticks): number {
  if (points.length === 0) return 0
  const first = points[0]!
  if (time <= first.time) return first.value
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    if (time < b.time) {
      const span = b.time - a.time
      const p = span > 0 ? (time - a.time) / span : 1
      return a.value + (b.value - a.value) * shapeAt(a.shape, p, a.tension)
    }
  }
  return points[points.length - 1]!.value
}

/**
 * Curves (M10): a curve is a list of points (x, y, both 0–1, x increasing), stored as
 * text ("0,0 0.5,0.62 1,1") so it keyframes and saves like a choice: curves hold between
 * keyframes (decision in the plan: whole states, smooth morphing later). The shape between
 * points is a natural cubic spline, as Photoshop's Curves draws it, clipped to 0–1; outside
 * the first and last points it's flat.
 */

export type CurvePoint = [number, number]

export const IDENTITY_CURVE = '0,0 1,1'
/** Samples a curve is baked into for the GPU (linear in between). */
export const CURVE_SAMPLES = 256
export const MAX_CURVE_POINTS = 16

/** The points of a curve, or null if the text isn't one (two to 16 points, x strictly increasing, all within 0–1). */
export function parseCurve(text: string): CurvePoint[] | null {
  const parts = text.trim().split(/\s+/)
  if (parts.length < 2 || parts.length > MAX_CURVE_POINTS) return null
  const points: CurvePoint[] = []
  for (const part of parts) {
    const [x, y, ...rest] = part.split(',').map(Number)
    if (rest.length || x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null
    if (points.length && x <= points[points.length - 1]![0]) return null
    points.push([x, y])
  }
  return points
}

const round = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000

export function formatCurve(points: readonly CurvePoint[]): string {
  return points.map(([x, y]) => `${round(x)},${round(y)}`).join(' ')
}

/** Second derivatives of the natural cubic spline through the points. */
function secondDerivatives(p: readonly CurvePoint[]): number[] {
  const n = p.length
  const m = new Array<number>(n).fill(0)
  if (n < 3) return m
  const u = new Array<number>(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    const sig = (p[i]![0] - p[i - 1]![0]) / (p[i + 1]![0] - p[i - 1]![0])
    const q = sig * m[i - 1]! + 2
    m[i] = (sig - 1) / q
    const d = (p[i + 1]![1] - p[i]![1]) / (p[i + 1]![0] - p[i]![0]) - (p[i]![1] - p[i - 1]![1]) / (p[i]![0] - p[i - 1]![0])
    u[i] = ((6 * d) / (p[i + 1]![0] - p[i - 1]![0]) - sig * u[i - 1]!) / q
  }
  for (let i = n - 2; i >= 0; i--) m[i] = m[i]! * m[i + 1]! + u[i]!
  return m
}

/** The curve's value at x (0–1). */
export function curveValue(points: readonly CurvePoint[], x: number, m = secondDerivatives(points)): number {
  const n = points.length
  if (x <= points[0]![0]) return points[0]![1]
  if (x >= points[n - 1]![0]) return points[n - 1]![1]
  let hi = 1
  while (points[hi]![0] < x) hi++
  const lo = hi - 1
  const h = points[hi]![0] - points[lo]![0]
  const a = (points[hi]![0] - x) / h
  const b = (x - points[lo]![0]) / h
  const y = a * points[lo]![1] + b * points[hi]![1] + (((a * a * a - a) * m[lo]! + (b * b * b - b) * m[hi]!) * h * h) / 6
  return Math.min(1, Math.max(0, y))
}

/** The curve sampled at CURVE_SAMPLES evenly spaced inputs, 0 to 1 (what the shader reads). */
export function curveTable(text: string): Float32Array {
  const points = parseCurve(text) ?? parseCurve(IDENTITY_CURVE)!
  const m = secondDerivatives(points)
  const out = new Float32Array(CURVE_SAMPLES)
  for (let i = 0; i < CURVE_SAMPLES; i++) out[i] = curveValue(points, i / (CURVE_SAMPLES - 1), m)
  return out
}

/** The table read the way the shader reads it (linear between samples), for CPU references. */
export function tableValue(table: Float32Array, x: number): number {
  const f = Math.min(1, Math.max(0, x)) * (table.length - 1)
  const i = Math.min(table.length - 2, Math.floor(f))
  const t = f - i
  return table[i]! + (table[i + 1]! - table[i]!) * t
}

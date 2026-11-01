import type { ParamValue } from '../effects/types'
import type { Ticks } from '../time'

/**
 * Keyframes. A value's keyframes are a list sorted by time, with times in ticks from the
 * start of its clip, so they travel with the clip. Each keyframe says how the value
 * travels on to the next one: hold, linear, or a bezier curve shaped by two handles (the
 * leaving keyframe's `out` and the arriving one's `in`). Choices and toggles always hold.
 * Before the first keyframe and after the last, the value holds.
 */

export type Interpolation = 'hold' | 'linear' | 'bezier'

/**
 * A bezier handle: `t` is how far along its segment it reaches (0–1), `v` the value
 * offset from its keyframe, per component (one for numbers, two for points).
 * Flat handles (v = 0) ease; handles can overshoot.
 */
export interface Handle {
  t: number
  v: number[]
}

export interface Keyframe {
  id: string
  time: Ticks
  value: ParamValue
  /** How the value travels from here to the next keyframe. */
  interpolation: Interpolation
  /** Shape of the curve arriving here and leaving here (used by bezier segments). */
  in: Handle
  out: Handle
}

/** Numbers and points interpolate (as one or two numbers); choices and toggles don't. */
export function components(value: ParamValue): number[] | null {
  if (typeof value === 'number') return [value]
  if (Array.isArray(value)) return [value[0], value[1]]
  return null
}

function fromComponents(c: number[], like: ParamValue): ParamValue {
  return Array.isArray(like) ? [c[0]!, c[1]!] : c[0]!
}

export function flatHandle(value: ParamValue): Handle {
  return { t: 1 / 3, v: (components(value) ?? [0]).map(() => 0) }
}

/** A handle pointing straight at the neighbouring keyframe: that end of the curve stays straight (for easing only the other end). */
export function straightHandle(own: ParamValue, other: ParamValue): Handle {
  const a = components(own) ?? [0]
  const b = components(other) ?? [0]
  return { t: 1 / 3, v: a.map((v, i) => (b[i]! - v) / 3) }
}

// ---- Evaluation -------------------------------------------------------------------------

function bezierX(s: number, x1: number, x2: number): number {
  const u = 1 - s
  return 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s
}

/** x'(s), for the speed integral. */
function bezierDX(s: number, x1: number, x2: number): number {
  const u = 1 - s
  return 3 * u * u * x1 + 6 * u * s * (x2 - x1) + 3 * s * s * (1 - x2)
}

/**
 * Solves x(s) = x for s. With both control x values in [0, 1] (handles never reach past
 * their segment), x(s) only increases, so bisection always finds the one answer.
 */
function solveS(x: number, x1: number, x2: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  let lo = 0
  let hi = 1
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    if (bezierX(mid, x1, x2) < x) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function bezier(p0: number, p1: number, p2: number, p3: number, s: number): number {
  const u = 1 - s
  return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3
}

/** A bezier segment's controls: x values (fractions of the segment) and, per component, y values. */
function controls(a: Keyframe, b: Keyframe, ca: number[], cb: number[]) {
  const x1 = Math.min(1, Math.max(0, a.out.t))
  const x2 = 1 - Math.min(1, Math.max(0, b.in.t))
  const ys = ca.map((v, i) => [v, v + (a.out.v[i] ?? 0), cb[i]! + (b.in.v[i] ?? 0), cb[i]!] as const)
  return { x1, x2, ys }
}

/** The value of the segment from `a` to `b` at time `t` within it. */
function segmentValue(a: Keyframe, b: Keyframe, t: Ticks): ParamValue {
  const ca = components(a.value)
  const cb = components(b.value)
  if (!ca || !cb || a.interpolation === 'hold') return a.value
  const p = Math.min(1, Math.max(0, (t - a.time) / Math.max(1, b.time - a.time)))
  if (a.interpolation === 'linear') return fromComponents(ca.map((v, i) => v + (cb[i]! - v) * p), a.value)
  const { x1, x2, ys } = controls(a, b, ca, cb)
  const s = solveS(p, x1, x2)
  return fromComponents(ys.map((y) => bezier(y[0], y[1], y[2], y[3], s)), a.value)
}

/** Index of the last keyframe at or before `t` (-1 if `t` is before them all). */
function segmentIndex(track: readonly Keyframe[], t: Ticks): number {
  let lo = -1
  let hi = track.length
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (track[mid]!.time <= t) lo = mid
    else hi = mid
  }
  return lo
}

/** The value at `t` (ticks from the clip's start). */
export function evaluate(track: readonly Keyframe[], t: Ticks, fallback: ParamValue): ParamValue {
  if (track.length === 0) return fallback
  const i = segmentIndex(track, t)
  if (i < 0) return track[0]!.value
  if (i >= track.length - 1) return track[track.length - 1]!.value
  return segmentValue(track[i]!, track[i + 1]!, t)
}

// ---- Speed ramps ------------------------------------------------------------------------

/** 3-point Gauss–Legendre: exact for polynomials up to degree 5. */
const GAUSS = [
  [-Math.sqrt(3 / 5), 5 / 9],
  [0, 8 / 9],
  [Math.sqrt(3 / 5), 5 / 9]
] as const

/**
 * ∫ speed dt over [from, to] (inside one segment), with speed in % → media ticks.
 * Exact: linear is a trapezoid; a bezier segment is integrated in its curve parameter,
 * where y(s)·x'(s) is a degree-5 polynomial, so 3-point Gauss–Legendre has no error.
 */
function segmentIntegral(a: Keyframe, b: Keyframe, from: Ticks, to: Ticks): number {
  const va = Number(a.value) / 100
  if (a.interpolation === 'hold') return (to - from) * va
  const vb = Number(b.value) / 100
  const span = Math.max(1, b.time - a.time)
  if (a.interpolation === 'linear') {
    const at = (t: Ticks) => va + (vb - va) * ((t - a.time) / span)
    return ((to - from) * (at(from) + at(to))) / 2
  }
  // Handles are in the keyframes' own units (%), so the curve is built in % and scaled after.
  const { x1, x2, ys } = controls(a, b, [va * 100], [vb * 100])
  const [y0, y1, y2, y3] = ys[0]!.map((v) => v / 100) as [number, number, number, number]
  const s0 = solveS((from - a.time) / span, x1, x2)
  const s1 = solveS((to - a.time) / span, x1, x2)
  const half = (s1 - s0) / 2
  const mid = (s1 + s0) / 2
  let sum = 0
  for (const [node, weight] of GAUSS) {
    const s = mid + half * node
    sum += weight * bezier(y0, y1, y2, y3, s) * bezierDX(s, x1, x2)
  }
  return sum * half * span
}

/** ∫ speed over [from, to] (from ≤ to), holding the first and last values beyond the keyframes. */
function speedIntegralForward(track: readonly Keyframe[], from: Ticks, to: Ticks): number {
  if (to <= from) return 0
  const first = track[0]!
  const last = track[track.length - 1]!
  let total = 0
  let at = from
  if (at < first.time) {
    const end = Math.min(to, first.time)
    total += (end - at) * (Number(first.value) / 100)
    at = end
  }
  for (let i = Math.max(0, segmentIndex(track, at)); i < track.length - 1 && at < to; i++) {
    const a = track[i]!
    const b = track[i + 1]!
    const end = Math.min(to, b.time)
    if (end > at) total += segmentIntegral(a, b, at, end)
    at = Math.max(at, end)
  }
  // Past the last keyframe (the loop only stops early once it reaches `to`).
  if (to > at) total += (to - at) * (Number(last.value) / 100)
  return total
}

/**
 * How far a speed-ramped clip has travelled through its media `t` ticks after its start
 * (negative before it), from its Speed keyframes (values in %).
 */
export function speedIntegral(track: readonly Keyframe[], t: Ticks): number {
  if (track.length === 0) return t
  return t >= 0 ? speedIntegralForward(track, 0, t) : -speedIntegralForward(track, t, 0)
}

/** The speed (%) at `t`. */
export function speedAt(track: readonly Keyframe[], t: Ticks): number {
  return Number(evaluate(track, t, 100))
}

/**
 * The longest stretch of timeline, from `t` going forwards (or backwards), that uses no
 * more than `media` ticks of media. Unlimited if the speed there falls to 0 for good.
 */
export function timelineForMedia(track: readonly Keyframe[], t: Ticks, media: Ticks, direction: 1 | -1): Ticks {
  if (media <= 0) return 0
  const used = (d: number) => (direction > 0 ? speedIntegral(track, t + d) - speedIntegral(track, t) : speedIntegral(track, t) - speedIntegral(track, t - d))
  let hi = 1
  while (used(hi) < media) {
    hi *= 2
    if (hi > Number.MAX_SAFE_INTEGER / 4) return Number.MAX_SAFE_INTEGER
  }
  let lo = 0
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (used(mid) <= media) lo = mid
    else hi = mid
  }
  return lo
}

// ---- Editing (pure; works on Immer drafts) ---------------------------------------------

export function sortKeyframes(track: Keyframe[]): void {
  track.sort((a, b) => a.time - b.time)
}

export function cloneKeyframe(k: Keyframe, id = k.id): Keyframe {
  return {
    ...k,
    id,
    value: Array.isArray(k.value) ? [k.value[0], k.value[1]] : k.value,
    in: { t: k.in.t, v: [...k.in.v] },
    out: { t: k.out.t, v: [...k.out.v] }
  }
}

export type KeyframeMap = Record<string, Keyframe[]>

export function cloneKeyframeMap(map: KeyframeMap): KeyframeMap {
  return Object.fromEntries(Object.entries(map).map(([key, track]) => [key, track.map((k) => cloneKeyframe(k))]))
}

/**
 * Sets the value at `time`: changes the keyframe there, or adds one. A new keyframe
 * carries on the interpolation of the keyframe before it (linear if there's none);
 * stepped values (choices, toggles) always hold.
 */
export function putKeyframe(track: Keyframe[], time: Ticks, value: ParamValue, id: string, stepped: boolean): Keyframe {
  const existing = track.find((k) => k.time === time)
  if (existing) {
    existing.value = value
    return existing
  }
  const before = track[segmentIndex(track, time)]
  const keyframe: Keyframe = {
    id,
    time,
    value,
    interpolation: stepped ? 'hold' : (before?.interpolation ?? 'linear'),
    in: flatHandle(value),
    out: flatHandle(value)
  }
  track.push(keyframe)
  sortKeyframes(track)
  return keyframe
}

export type InterpolationPreset = 'linear' | 'hold' | 'bezier' | 'ease-in' | 'ease-out' | 'ease-in-out'

/**
 * Premiere's keyframe interpolation menu, applied to keyframe `index`. Linear, Hold and
 * Bezier set how the value leaves it; Ease In flattens how it arrives, Ease Out how it
 * leaves, Ease In and Out both (the neighbouring end of each segment stays as it was).
 */
export function applyPreset(track: Keyframe[], index: number, preset: InterpolationPreset): void {
  const k = track[index]
  if (!k || components(k.value) === null) return
  const before = track[index - 1]
  const after = track[index + 1]
  switch (preset) {
    case 'linear':
    case 'hold':
      k.interpolation = preset
      return
    case 'bezier':
      // Straight to begin with, so switching changes nothing until a handle is dragged.
      if (k.interpolation !== 'bezier' && after) {
        k.out = straightHandle(k.value, after.value)
        after.in = straightHandle(after.value, k.value)
      }
      k.interpolation = 'bezier'
      return
    case 'ease-in':
      k.in = flatHandle(k.value)
      if (before) {
        if (before.interpolation !== 'bezier') before.out = straightHandle(before.value, k.value)
        before.interpolation = 'bezier'
      }
      return
    case 'ease-out':
      if (k.interpolation !== 'bezier' && after) after.in = straightHandle(after.value, k.value)
      k.out = flatHandle(k.value)
      k.interpolation = 'bezier'
      return
    case 'ease-in-out':
      applyPreset(track, index, 'ease-in')
      applyPreset(track, index, 'ease-out')
  }
}

/** Moves every keyframe by `delta` ticks (when a clip's start is trimmed, keyframes stay with the picture). */
export function shiftKeyframeMap(map: KeyframeMap, delta: Ticks): void {
  if (delta === 0) return
  for (const track of Object.values(map)) for (const k of track) k.time += delta
}

/**
 * Scales keyframe times (a clip's speed changed, so its length did), snapped to frames.
 * Keyframes landing on the same frame keep the later one.
 */
export function scaleKeyframeMap(map: KeyframeMap, factor: number, frame: Ticks): void {
  for (const [key, track] of Object.entries(map)) {
    for (const k of track) k.time = Math.round((k.time * factor) / frame) * frame
    const kept: Keyframe[] = []
    for (const k of track) {
      if (kept.length > 0 && kept[kept.length - 1]!.time === k.time) kept[kept.length - 1] = k
      else kept.push(k)
    }
    map[key] = kept
  }
}

/**
 * A keyframe list made valid (when loading): sorted, one keyframe per time, each value
 * passed through `clean`, stepped values set to hold, handles within their segments and
 * with one offset per component.
 */
export function normaliseTrack(track: readonly Keyframe[], clean: (value: ParamValue) => ParamValue, stepped: boolean): Keyframe[] {
  const sorted = [...track].sort((a, b) => a.time - b.time)
  const out: Keyframe[] = []
  for (const k of sorted) {
    const value = clean(k.value)
    const n = components(value)?.length ?? 1
    const handle = (h: Handle): Handle => ({ t: Number.isFinite(h.t) ? Math.min(1, Math.max(0, h.t)) : 1 / 3, v: Array.from({ length: n }, (_, i) => (Number.isFinite(h.v[i]) ? h.v[i]! : 0)) })
    const fixed: Keyframe = { id: k.id, time: k.time, value, interpolation: stepped || components(value) === null ? 'hold' : k.interpolation, in: handle(k.in), out: handle(k.out) }
    if (out.length > 0 && out[out.length - 1]!.time === fixed.time) out[out.length - 1] = fixed
    else out.push(fixed)
  }
  return out
}

import type { ParamValue } from '../effects/types'
import { components, evaluate } from '../keyframes/keyframes'
import { applyLinks } from '../modulation/apply'
import type { ModulationContext } from '../modulation/types'
import type { Ticks } from '../time'
import { MASK_PARAMS, maskParams, type Mask, type MaskMode, type MaskParam, type MaskShape, type MaskShapeKind, type PathPoint } from './types'

/**
 * Mask maths shared by everything that draws or edits masks: values (stored, keyframed,
 * modulated), pen paths flattened to polygons, the buffer the GPU reads, and a CPU
 * reference of the GPU's alpha (tests compare the two).
 */

export interface FrameSize {
  width: number
  height: number
}

/** A new shape with sensible defaults for the frame it's drawn on. */
export function newShape(id: string, kind: MaskShapeKind, frame: FrameSize): MaskShape {
  const w = frame.width
  const h = frame.height
  return {
    id,
    kind,
    mode: 'add',
    invert: false,
    feather: kind === 'edge' ? 40 : 10,
    expansion: 0,
    opacity: 100,
    position: [w / 2, h / 2],
    size: kind === 'ellipse' ? [Math.round(h / 2), Math.round(h / 2)] : [Math.round(w / 2), Math.round(h / 2)],
    rotation: 0,
    scale: 100,
    roundness: 0,
    points: kind === 'path' ? defaultPath(Math.min(w, h) / 4) : [],
    width: Math.round(Math.min(w, h) / 10),
    low: 60,
    high: 100,
    softness: 10,
    keyframes: {},
    modulation: {}
  }
}

/** A five-pointed outline to start from (drag its points, click its edges to add more). */
function defaultPath(radius: number): PathPoint[] {
  return Array.from({ length: 5 }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5
    return { x: Math.round(Math.cos(a) * radius), y: Math.round(Math.sin(a) * radius), inX: 0, inY: 0, outX: 0, outY: 0 }
  })
}

export function hasParam(shape: MaskShape, param: MaskParam): boolean {
  return maskParams(shape.kind).includes(param)
}

/** A setting's stored value (used when it isn't animated). */
export function shapeStatic(shape: MaskShape, param: MaskParam): ParamValue {
  const v = shape[param]
  return Array.isArray(v) ? [v[0], v[1]] : v
}

export function writeShapeStatic(shape: MaskShape, param: MaskParam, value: ParamValue): void {
  if (MASK_PARAMS[param].kind === 'point') (shape as unknown as Record<string, [number, number]>)[param] = [...(value as [number, number])]
  else (shape as unknown as Record<string, number>)[param] = Number(value)
}

/** A value made valid for a setting, or null. */
export function clampMaskValue(param: MaskParam, value: ParamValue): ParamValue | null {
  const spec = MASK_PARAMS[param]
  const c = components(value)
  if (!c || c.some((v) => !Number.isFinite(v))) return null
  const clamp = (v: number) => Math.min(spec.max, Math.max(spec.min, v))
  if (spec.kind === 'point') return c.length === 2 ? [clamp(c[0]!), clamp(c[1]!)] : null
  return c.length === 1 ? clamp(c[0]!) : null
}

/** A setting at sequence time `time`: keyframes (if any), then modulation (if given), clamped to its range. */
export function shapeValueAt(shape: MaskShape, param: MaskParam, time: Ticks, modulation: ModulationContext | null = null): ParamValue {
  const track = shape.keyframes[param]
  let value = track?.length ? evaluate(track, time, shapeStatic(shape, param)) : shapeStatic(shape, param)
  const links = modulation ? shape.modulation[param] : undefined
  if (links?.length) {
    const out = applyLinks(components(value)!, links, modulation!, time)
    value = Array.isArray(value) ? [out[0]!, out[1]!] : out[0]!
  }
  return track?.length || links?.length ? (clampMaskValue(param, value) ?? shapeStatic(shape, param)) : value
}

/** A shape with every setting worked out for one moment, and a pen path as a polygon in frame pixels. */
export interface ResolvedShape {
  kind: MaskShapeKind
  mode: MaskMode
  invert: boolean
  /** 0–1. */
  opacity: number
  feather: number
  expansion: number
  position: [number, number]
  size: [number, number]
  rotation: number
  roundness: number
  width: number
  /** Luminance range, 0–1. */
  low: number
  high: number
  softness: number
  /** Pen paths: closed polygon x0, y0, x1, y1… in frame pixels. */
  polygon: Float32Array | null
}

export function resolveShape(shape: MaskShape, time: Ticks, modulation: ModulationContext | null = null): ResolvedShape {
  const num = (p: MaskParam) => Number(shapeValueAt(shape, p, time, modulation))
  const pt = (p: MaskParam) => shapeValueAt(shape, p, time, modulation) as [number, number]
  const position = pt('position')
  const rotation = num('rotation')
  return {
    kind: shape.kind,
    mode: shape.mode,
    invert: shape.invert,
    opacity: num('opacity') / 100,
    feather: num('feather'),
    expansion: num('expansion'),
    position,
    size: pt('size'),
    rotation,
    roundness: num('roundness'),
    width: num('width'),
    low: num('low') / 100,
    high: num('high') / 100,
    softness: num('softness') / 100,
    polygon: shape.kind === 'path' ? placePath(flattenPath(shape.points), position, num('scale'), rotation) : null
  }
}

export function resolveMask(mask: Mask, time: Ticks, modulation: ModulationContext | null = null): ResolvedShape[] {
  return mask.shapes.map((s) => resolveShape(s, time, modulation))
}

/** Masks used at one moment, worked out once per frame, by id. */
export type ResolvedMasks = ReadonlyMap<string, ResolvedShape[]>

export function resolveMasks(masks: readonly Mask[], ids: Iterable<string>, time: Ticks, modulation: ModulationContext | null = null): Map<string, ResolvedShape[]> {
  const out = new Map<string, ResolvedShape[]>()
  for (const id of ids) {
    if (out.has(id)) continue
    const mask = masks.find((m) => m.id === id)
    if (mask) out.set(id, resolveMask(mask, time, modulation))
  }
  return out
}

// ---- Pen paths ----------------------------------------------------------------------------

/** Most line pieces one bezier segment becomes; straight segments stay one piece. */
const MAX_PIECES = 32
/** Most edges a mask sends to the GPU (every pixel visits each one). */
export const MAX_MASK_EDGES = 4096

/**
 * A closed pen path as a polygon (in the path's own coordinates): each segment from a
 * point to the next is a cubic bezier (the point's out handle, the next one's in handle),
 * cut into pieces about 4 px long.
 */
export function flattenPath(points: readonly PathPoint[], pieceLength = 4): number[] {
  const out: number[] = []
  if (points.length < 3) return out
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    const b = points[(i + 1) % points.length]!
    const p1x = a.x + a.outX
    const p1y = a.y + a.outY
    const p2x = b.x + b.inX
    const p2y = b.y + b.inY
    out.push(a.x, a.y)
    const curved = a.outX !== 0 || a.outY !== 0 || b.inX !== 0 || b.inY !== 0
    if (!curved) continue
    const hull = Math.hypot(p1x - a.x, p1y - a.y) + Math.hypot(p2x - p1x, p2y - p1y) + Math.hypot(b.x - p2x, b.y - p2y)
    const pieces = Math.max(2, Math.min(MAX_PIECES, Math.ceil(hull / pieceLength)))
    for (let k = 1; k < pieces; k++) {
      const s = k / pieces
      const u = 1 - s
      const w0 = u * u * u
      const w1 = 3 * u * u * s
      const w2 = 3 * u * s * s
      const w3 = s * s * s
      out.push(w0 * a.x + w1 * p1x + w2 * p2x + w3 * b.x, w0 * a.y + w1 * p1y + w2 * p2y + w3 * b.y)
    }
  }
  return out
}

/** A flattened path scaled (%), rotated (degrees, clockwise) and moved to `position`. */
export function placePath(polygon: number[], position: [number, number], scale: number, rotation: number): Float32Array {
  const s = scale / 100
  const r = (rotation * Math.PI) / 180
  const cos = Math.cos(r) * s
  const sin = Math.sin(r) * s
  const out = new Float32Array(polygon.length)
  for (let i = 0; i < polygon.length; i += 2) {
    const x = polygon[i]!
    const y = polygon[i + 1]!
    out[i] = position[0] + cos * x - sin * y
    out[i + 1] = position[1] + sin * x + cos * y
  }
  return out
}

/** A path point's position, scaled, rotated and moved like the path (for drawing it on the monitor). */
export function placePoint(x: number, y: number, position: [number, number], scale: number, rotation: number): [number, number] {
  const s = scale / 100
  const r = (rotation * Math.PI) / 180
  return [position[0] + (Math.cos(r) * x - Math.sin(r) * y) * s, position[1] + (Math.sin(r) * x + Math.cos(r) * y) * s]
}

/** The inverse of placePoint: a frame pixel into the path's own coordinates. */
export function unplacePoint(x: number, y: number, position: [number, number], scale: number, rotation: number): [number, number] {
  const s = Math.max(1e-6, scale / 100)
  const r = (rotation * Math.PI) / 180
  const dx = (x - position[0]) / s
  const dy = (y - position[1]) / s
  return [Math.cos(r) * dx + Math.sin(r) * dy, -Math.sin(r) * dx + Math.cos(r) * dy]
}

// ---- GPU buffer -----------------------------------------------------------------------------

const KINDS: Record<MaskShapeKind, number> = { rectangle: 0, ellipse: 1, path: 2, edge: 3, luminance: 4 }
const MODES: Record<MaskMode, number> = { add: 0, subtract: 1, intersect: 2 }

/** vec4s per shape in the buffer. */
export const PART_VEC4S = 4

/**
 * The buffer mask.wgsl reads: four vec4s per shape, then the pen paths' edges (one vec4
 * per edge: its two ends). Per shape:
 *   0: kind, mode, invert, opacity
 *   1: feather, expansion, centre x, centre y
 *   2: rectangle/ellipse: half width, half height, roundness · path: first edge, edge count · edge: width · luminance: low, high, softness
 *   3: rectangle/ellipse: cos(rotation), sin(rotation) · path: its bounding box (min x, min y, max x, max y),
 *      so pixels well outside it skip the edges
 * Edges beyond MAX_MASK_EDGES are dropped (the path is then cut short).
 */
export function packMask(shapes: readonly ResolvedShape[]): { data: Float32Array; parts: number } {
  const parts = shapes.length
  let edges = 0
  for (const s of shapes) if (s.polygon && s.polygon.length >= 6) edges += s.polygon.length / 2
  edges = Math.min(edges, MAX_MASK_EDGES)
  const data = new Float32Array(Math.max(1, parts * PART_VEC4S + edges) * 4)
  let edge = parts * PART_VEC4S
  const end = parts * PART_VEC4S + edges
  shapes.forEach((s, i) => {
    const o = i * PART_VEC4S * 4
    const r = (s.rotation * Math.PI) / 180
    data.set([KINDS[s.kind], MODES[s.mode], s.invert ? 1 : 0, s.opacity, s.feather, s.expansion, s.position[0], s.position[1]], o)
    if (s.kind === 'rectangle' || s.kind === 'ellipse') data.set([s.size[0] / 2, s.size[1] / 2, s.roundness, 0], o + 8)
    else if (s.kind === 'edge') data.set([s.width, 0, 0, 0], o + 8)
    else if (s.kind === 'luminance') data.set([s.low, s.high, s.softness, 0], o + 8)
    else if (s.kind === 'path') {
      const p = s.polygon
      const n = p && p.length >= 6 ? Math.min(p.length / 2, end - edge) : 0
      data.set([edge, n, 0, 0], o + 8)
      const box = [Infinity, Infinity, -Infinity, -Infinity]
      for (let k = 0; k < n; k++) {
        const j = (k + p!.length / 2 - 1) % (p!.length / 2)
        data.set([p![j * 2]!, p![j * 2 + 1]!, p![k * 2]!, p![k * 2 + 1]!], (edge + k) * 4)
        box[0] = Math.min(box[0]!, p![k * 2]!)
        box[1] = Math.min(box[1]!, p![k * 2 + 1]!)
        box[2] = Math.max(box[2]!, p![k * 2]!)
        box[3] = Math.max(box[3]!, p![k * 2 + 1]!)
      }
      data.set(n > 0 ? box : [0, 0, 0, 0], o + 12)
      edge += n
      return
    }
    data.set([Math.cos(r), Math.sin(r), 0, 0], o + 12)
  })
  return { data, parts }
}

// ---- CPU reference (mask.wgsl does the same) -----------------------------------------------

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

function sdRoundBox(px: number, py: number, hw: number, hh: number, r: number): number {
  const rr = Math.min(Math.max(r, 0), Math.min(hw, hh))
  const qx = Math.abs(px) - hw + rr
  const qy = Math.abs(py) - hh + rr
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr
}

/** Signed distance to an ellipse, close to exact near its edge (where feathering happens). */
function sdEllipse(px: number, py: number, rx: number, ry: number): number {
  const ax = Math.max(rx, 1e-3)
  const ay = Math.max(ry, 1e-3)
  const k0 = Math.hypot(px / ax, py / ay)
  const k1 = Math.hypot(px / (ax * ax), py / (ay * ay))
  if (k1 < 1e-9) return -Math.min(ax, ay)
  return (k0 * (k0 - 1)) / k1
}

/** Signed distance to a closed polygon (negative inside, even-odd rule). */
function sdPolygon(px: number, py: number, p: Float32Array): number {
  const n = p.length / 2
  let d = Infinity
  let s = 1
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const vix = p[i * 2]!
    const viy = p[i * 2 + 1]!
    const ex = p[j * 2]! - vix
    const ey = p[j * 2 + 1]! - viy
    const wx = px - vix
    const wy = py - viy
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / Math.max(ex * ex + ey * ey, 1e-12)))
    const bx = wx - ex * t
    const by = wy - ey * t
    d = Math.min(d, bx * bx + by * by)
    const c1 = py >= viy
    const c2 = py < p[j * 2 + 1]!
    const c3 = ex * wy > ey * wx
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s
  }
  return s * Math.sqrt(d)
}

/**
 * How much of an effect shows at frame pixel (x, y): 0–1. `luma` is the effect's input
 * there (0–1, display values); `aa` is how many frame pixels one processed pixel covers
 * (the softest an edge gets, so hard edges stay smooth). No shapes: everywhere.
 */
export function maskAlpha(shapes: readonly ResolvedShape[], x: number, y: number, luma: number, frame: FrameSize, aa = 1): number {
  if (shapes.length === 0) return 1
  let acc = shapes[0]!.mode === 'add' ? 0 : 1
  for (const s of shapes) {
    const f = Math.max(s.feather, aa)
    let a: number
    if (s.kind === 'luminance') {
      const soft = Math.max(s.softness, 1e-4)
      a = smoothstep(s.low - soft, s.low, luma) * (1 - smoothstep(s.high, s.high + soft, luma))
    } else if (s.kind === 'edge') {
      const d = Math.min(x, y, frame.width - x, frame.height - y)
      const reach = s.width + s.expansion
      a = 1 - smoothstep(reach - f / 2, reach + f / 2, d)
    } else {
      let d: number
      if (s.kind === 'path') d = s.polygon && s.polygon.length >= 6 ? sdPolygon(x, y, s.polygon) : Infinity
      else {
        const r = (s.rotation * Math.PI) / 180
        const dx = x - s.position[0]
        const dy = y - s.position[1]
        const lx = Math.cos(r) * dx + Math.sin(r) * dy
        const ly = -Math.sin(r) * dx + Math.cos(r) * dy
        d = s.kind === 'rectangle' ? sdRoundBox(lx, ly, s.size[0] / 2, s.size[1] / 2, s.roundness) : sdEllipse(lx, ly, s.size[0] / 2, s.size[1] / 2)
      }
      a = d === Infinity ? 0 : 1 - smoothstep(-f / 2, f / 2, d - s.expansion)
    }
    if (s.invert) a = 1 - a
    a *= Math.min(1, Math.max(0, s.opacity))
    if (s.mode === 'add') acc = acc + a - acc * a
    else if (s.mode === 'subtract') acc *= 1 - a
    else acc *= a
  }
  return acc
}

/** Rec. 709 luma of display values, as the luminance range reads it. */
export function luma(r: number, g: number, b: number): number {
  return Math.min(1, Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b))
}

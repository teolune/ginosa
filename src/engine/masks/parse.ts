import { normaliseTrack, type KeyframeMap } from '../keyframes/keyframes'
import { clampMaskValue, hasParam, shapeStatic } from './masks'
import { MASK_PARAMS, type Mask, type MaskMode, type MaskParam, type MaskRef, type MaskShape, type MaskShapeKind, type PathPoint } from './types'

/**
 * Reading masks from a project file. Anything malformed is a clear error; values out of
 * range are brought into range, and keyframes for settings a shape doesn't have are dropped.
 */

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export class MaskFormatError extends Error {}

function num(o: Json, key: string, where: string): number {
  const v = o[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  throw new MaskFormatError(`${where}.${key} should be a number`)
}

function str(o: Json, key: string, where: string): string {
  const v = o[key]
  if (typeof v !== 'string') throw new MaskFormatError(`${where}.${key} should be text`)
  return v
}

function pair(o: Json, key: string, where: string): [number, number] {
  const v = o[key]
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new MaskFormatError(`${where}.${key} should be two numbers`)
  return [v[0], v[1]]
}

const KINDS: MaskShapeKind[] = ['rectangle', 'ellipse', 'path', 'edge', 'luminance']
const MODES: MaskMode[] = ['add', 'subtract', 'intersect']

function parsePoint(v: unknown, where: string): PathPoint {
  if (!isObject(v)) throw new MaskFormatError(`${where} should be a point`)
  return { x: num(v, 'x', where), y: num(v, 'y', where), inX: num(v, 'inX', where), inY: num(v, 'inY', where), outX: num(v, 'outX', where), outY: num(v, 'outY', where) }
}

function parseShape(raw: unknown, where: string, parseKeyframes: (v: unknown, where: string) => KeyframeMap, parseModulation: (v: unknown, where: string) => MaskShape['modulation']): MaskShape {
  if (!isObject(raw)) throw new MaskFormatError(`${where} should be an object`)
  const kind = raw['kind']
  if (!KINDS.includes(kind as MaskShapeKind)) throw new MaskFormatError(`${where}.kind is not a mask shape`)
  const mode = raw['mode']
  if (!MODES.includes(mode as MaskMode)) throw new MaskFormatError(`${where}.mode should be add, subtract or intersect`)
  if (!Array.isArray(raw['points'])) throw new MaskFormatError(`${where}.points should be a list`)
  const shape: MaskShape = {
    id: str(raw, 'id', where),
    kind: kind as MaskShapeKind,
    mode: mode as MaskMode,
    invert: raw['invert'] === true,
    feather: num(raw, 'feather', where),
    expansion: num(raw, 'expansion', where),
    opacity: num(raw, 'opacity', where),
    position: pair(raw, 'position', where),
    size: pair(raw, 'size', where),
    rotation: num(raw, 'rotation', where),
    scale: num(raw, 'scale', where),
    roundness: num(raw, 'roundness', where),
    points: raw['points'].map((p, i) => parsePoint(p, `${where}.points[${i}]`)),
    width: num(raw, 'width', where),
    low: num(raw, 'low', where),
    high: num(raw, 'high', where),
    softness: num(raw, 'softness', where),
    keyframes: {},
    modulation: {}
  }
  for (const param of Object.keys(MASK_PARAMS) as MaskParam[]) {
    const clean = clampMaskValue(param, shapeStatic(shape, param))
    if (clean !== null) (shape as unknown as Record<string, unknown>)[param] = clean
  }
  const keyframes = parseKeyframes(raw['keyframes'] ?? {}, `${where}.keyframes`)
  for (const [param, track] of Object.entries(keyframes)) {
    if (!(param in MASK_PARAMS) || !hasParam(shape, param as MaskParam) || track.length === 0) continue
    const fallback = shapeStatic(shape, param as MaskParam)
    shape.keyframes[param] = normaliseTrack(track, (v) => clampMaskValue(param as MaskParam, v) ?? fallback, false)
  }
  shape.modulation = Object.fromEntries(Object.entries(parseModulation(raw['modulation'] ?? {}, `${where}.modulation`)).filter(([param]) => param in MASK_PARAMS && hasParam(shape, param as MaskParam)))
  return shape
}

export function parseMasks(value: unknown, parseKeyframes: (v: unknown, where: string) => KeyframeMap, parseModulation: (v: unknown, where: string) => MaskShape['modulation']): Mask[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new MaskFormatError('sequence.masks should be a list')
  const masks = value.map((raw, i): Mask => {
    const where = `sequence.masks[${i}]`
    if (!isObject(raw)) throw new MaskFormatError(`${where} should be an object`)
    if (!Array.isArray(raw['shapes'])) throw new MaskFormatError(`${where}.shapes should be a list`)
    const shapes = raw['shapes'].map((s, j) => parseShape(s, `${where}.shapes[${j}]`, parseKeyframes, parseModulation))
    if (new Set(shapes.map((s) => s.id)).size !== shapes.length) throw new MaskFormatError(`Two shapes in ${where} share the same id`)
    return { id: str(raw, 'id', where), name: str(raw, 'name', where), shapes }
  })
  if (new Set(masks.map((m) => m.id)).size !== masks.length) throw new MaskFormatError('Two masks share the same id')
  return masks
}

/** A mask reference as stored, or null (also null when it names a mask that isn't there). */
export function parseMaskRef(value: unknown, where: string, masks: ReadonlySet<string>): MaskRef | null {
  if (value === null || value === undefined) return null
  if (!isObject(value)) throw new MaskFormatError(`${where} should be a mask reference`)
  const id = str(value, 'id', where)
  if (!masks.has(id)) return null
  return value['followClip'] === true ? { id, invert: value['invert'] === true, followClip: true } : { id, invert: value['invert'] === true }
}

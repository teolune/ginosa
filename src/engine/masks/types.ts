import type { KeyframeMap } from '../keyframes/keyframes'
import type { ModulationMap } from '../modulation/types'

/**
 * Shared masks (M9). A mask is its own object, kept with the sequence: any effect or
 * adjustment layer can use it, so one mask can drive several effects. It's made of shapes
 * combined in order (add, subtract, intersect), each feathered, expanded, faded and
 * optionally inverted. Masks live in frame coordinates (sequence pixels): they stay where
 * they were drawn on screen, whichever clip uses them.
 */

export type MaskShapeKind = 'rectangle' | 'ellipse' | 'path' | 'edge' | 'luminance'
export type MaskMode = 'add' | 'subtract' | 'intersect'

/** A pen-path point, relative to the shape's position; `in`/`out` are its bezier handles (offsets from the point). */
export interface PathPoint {
  x: number
  y: number
  inX: number
  inY: number
  outX: number
  outY: number
}

export interface MaskShape {
  id: string
  kind: MaskShapeKind
  mode: MaskMode
  invert: boolean
  /** Softness of the edge, px. */
  feather: number
  /** Grows (or, negative, shrinks) the shape, px. */
  expansion: number
  /** 0–100. */
  opacity: number
  /** Centre of a rectangle or ellipse; where a path is moved to. */
  position: [number, number]
  /** Rectangle or ellipse width and height, px. */
  size: [number, number]
  /** Degrees. */
  rotation: number
  /** Path size, % (100 = as drawn). */
  scale: number
  /** Rectangle corner rounding, px. */
  roundness: number
  points: PathPoint[]
  /** Edge mask: how far in from the frame edges it reaches, px. */
  width: number
  /** Luminance range, 0–100, with its soft edges. */
  low: number
  high: number
  softness: number
  /** Keyframes by setting, in ticks from the sequence start. */
  keyframes: KeyframeMap
  /** Modulation links by setting. */
  modulation: ModulationMap
}

/** Where an effect or adjustment layer uses a mask; `invert` uses its outside instead (the same mask can drive one effect inside and another outside). */
export interface MaskRef {
  id: string
  invert: boolean
}

export interface Mask {
  id: string
  name: string
  shapes: MaskShape[]
}

export const MASK_KIND_LABELS: Record<MaskShapeKind, string> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  path: 'Pen Path',
  edge: 'Edge',
  luminance: 'Luminance Range'
}

/** Settings that can be keyframed and modulated, by shape kind, with their ranges. */
export interface MaskParamSpec {
  label: string
  kind: 'number' | 'point'
  min: number
  max: number
  unit: string
  decimals: number
}

const P = (label: string, kind: 'number' | 'point', min: number, max: number, unit: string, decimals = 1): MaskParamSpec => ({ label, kind, min, max, unit, decimals })

export const MASK_PARAMS = {
  feather: P('Feather', 'number', 0, 2000, 'px'),
  expansion: P('Expansion', 'number', -2000, 2000, 'px'),
  opacity: P('Opacity', 'number', 0, 100, '%'),
  position: P('Position', 'point', -100_000, 100_000, 'px'),
  size: P('Size', 'point', 0, 100_000, 'px'),
  rotation: P('Rotation', 'number', -100_000, 100_000, '°'),
  scale: P('Scale', 'number', 0, 10_000, '%'),
  roundness: P('Roundness', 'number', 0, 10_000, 'px'),
  width: P('Width', 'number', 0, 10_000, 'px'),
  low: P('Low', 'number', 0, 100, '%'),
  high: P('High', 'number', 0, 100, '%'),
  softness: P('Softness', 'number', 0, 100, '%')
} as const satisfies Record<string, MaskParamSpec>

export type MaskParam = keyof typeof MASK_PARAMS

export function maskParams(kind: MaskShapeKind): MaskParam[] {
  const common: MaskParam[] = ['feather', 'expansion', 'opacity']
  switch (kind) {
    case 'rectangle':
      return ['position', 'size', 'rotation', 'roundness', ...common]
    case 'ellipse':
      return ['position', 'size', 'rotation', ...common]
    case 'path':
      return ['position', 'scale', 'rotation', ...common]
    case 'edge':
      return ['width', ...common]
    case 'luminance':
      return ['low', 'high', 'softness', 'opacity']
  }
}

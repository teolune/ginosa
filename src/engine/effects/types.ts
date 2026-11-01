import type { BlendMode } from '../project/model'
import type { KeyframeMap } from '../keyframes/keyframes'
import type { ModulationMap } from '../modulation/types'

/**
 * What an effect module declares (one folder per effect in src/effects/<id>/: a
 * manifest, its WGSL and its tests; the registry finds them automatically).
 */

/** The colour an effect's shader works in. The engine converts in and out. */
export type EffectColourSpace = 'display' | 'linear' | 'oklab'

/** How an effect uses time. Only per-frame effects exist so far; the others arrive with M9. */
export type TimeBehaviour = 'per-frame'

export type ParamValue = number | boolean | string | [number, number]

interface ParamBase {
  id: string
  label: string
  /** Can be keyframed (M7) / driven by audio or LFOs (M8). Default true for numbers, angles and points. */
  keyframable?: boolean
  modulatable?: boolean
  help?: string
}

export interface NumberParam extends ParamBase {
  type: 'number'
  default: number
  min: number
  max: number
  /** Shown after the value, e.g. "%". */
  unit?: string
  /** A length in pixels of the image the effect sees (scaled for reduced-resolution playback). */
  pixels?: boolean
  decimals?: number
}

export interface AngleParam extends ParamBase {
  type: 'angle'
  /** Degrees, clockwise. */
  default: number
}

export interface ChoiceParam extends ParamBase {
  type: 'choice'
  default: string
  options: ReadonlyArray<{ id: string; label: string }>
}

export interface ToggleParam extends ParamBase {
  type: 'toggle'
  default: boolean
}

/** A position in pixels of the image the effect sees; the default is a fraction of its size. */
export interface PointParam extends ParamBase {
  type: 'point'
  default: readonly [number, number]
}

export type ParamSpec = NumberParam | AngleParam | ChoiceParam | ToggleParam | PointParam

export interface EffectManifest {
  id: string
  name: string
  category: string
  description: string
  /** Bump when parameters change; `migrate` upgrades older instances. */
  version: number
  params: readonly ParamSpec[]
  colourSpace: EffectColourSpace
  time: TimeBehaviour
  /**
   * WGSL defining `fn effect(px: vec2f) -> vec4f`, which returns the effect's colour
   * (straight alpha, in its colour space) for output pixel `px`. Helpers:
   * `inputAt(px)` (bilinear, in the effect's space), `inputNearest(px)`, `imageSize()`,
   * and `params.<id>` (choices are option indexes; points are `<id>_x`, `<id>_y`).
   */
  shader: string
  migrate?(params: Record<string, unknown>, from: number): Record<string, unknown>
}

/** An effect on a clip or adjustment layer. */
export interface EffectInstance {
  id: string
  effectId: string
  /** The manifest version these params were made with. */
  version: number
  enabled: boolean
  /** 0–100: blend between the input and the effect's result. */
  mix: number
  blendMode: BlendMode
  params: Record<string, ParamValue>
  /** Keyframes by parameter id ('mix' for Mix), times in ticks from the clip's start. */
  keyframes: KeyframeMap
  /** Modulation links by parameter id ('mix' for Mix). */
  modulation: ModulationMap
}

export interface ImageSize {
  width: number
  height: number
}

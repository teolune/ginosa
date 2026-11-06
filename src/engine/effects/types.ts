import type { BeatGrid, BlendMode } from '../project/model'
import type { KeyframeMap } from '../keyframes/keyframes'
import type { ModulationMap } from '../modulation/types'
import type { MaskRef } from '../masks/types'

/**
 * What an effect module declares (one folder per effect in src/effects/<id>/: a
 * manifest, its WGSL and its tests; the registry finds them automatically).
 */

/** The colour an effect's shader works in. The engine converts in and out. */
export type EffectColourSpace = 'display' | 'linear' | 'oklab'

/**
 * How an effect uses time (M9). `per-frame`: each frame from its own input. `stateful`:
 * each frame also reads the effect's own output on the frame before (feedback, datamosh),
 * so a frame depends on every frame back to the clip's first (its reset); the engine
 * keeps that state, checkpoints it every second and replays from the nearest checkpoint
 * when you jump. (Posterize Time, which shows another moment, is `holdsTime`.)
 */
export type TimeBehaviour = 'per-frame' | 'stateful'

export type ParamValue = number | boolean | string | [number, number]

interface ParamBase {
  id: string
  label: string
  /** Can be keyframed (M7) / driven by audio or LFOs (M8). Default true for numbers, angles and points. */
  keyframable?: boolean
  modulatable?: boolean
  help?: string
  /** Effect Controls shows parameters with the same group under one heading (e.g. "Tone"). */
  group?: string
  /** Shown only while a choice parameter has one of these values (e.g. Every N Frames only with Refresh on "Every N frames"). */
  showIf?: { param: string; is: readonly string[] }
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

/**
 * A curve (M10): points as text, "x,y x,y …" with both 0–1 (curves.ts). Shown as a curve
 * editor; holds between keyframes; the shader reads it baked into a table: `curveAt(CURVE_<id>, x)`.
 */
export interface CurveParam extends ParamBase {
  type: 'curve'
  default: string
}

/**
 * A detented knob (M12): one of a fixed list of steps (e.g. note values), stored as its index.
 * It holds between keyframes like a choice, but modulation can move it by whole steps (the
 * result is rounded to the nearest), so loud sections can turn it up.
 */
export interface StepsParam extends ParamBase {
  type: 'steps'
  default: number
  steps: ReadonlyArray<{ id: string; label: string }>
}

/**
 * A gradient (M13): the gradient as JSON text (engine/gradients/gradient.ts). Shown as a
 * swatch that opens the Gradient Editor; holds between keyframes; the shader reads it baked
 * into a 4096-entry RGBA table: `gradientAt(GRADIENT_<id>, x)`. `methodParam` names the choice
 * parameter that says how it's drawn (Classic, Perceptual, Linear or Smooth).
 */
export interface GradientParam extends ParamBase {
  type: 'gradient'
  default: string
  methodParam?: string
}

export type ParamSpec = NumberParam | AngleParam | ChoiceParam | ToggleParam | PointParam | CurveParam | StepsParam | GradientParam

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
   * Stateful effects also get `previousAt(px)` (their own output on the frame before,
   * bilinear, transparent outside the image), `hasPrevious()` (false on the first frame)
   * and `framesSinceReset()`.
   */
  shader: string
  /**
   * Optional passes before the main shader (M10), each into its own image (e.g. Mosaic: one
   * value per cell and pixel row, then one per cell). Each pass's WGSL defines
   * `fn prepass(texel: vec2i) -> vec4f`, with the same helpers as the shader plus
   * `passSize()` (the size it writes); each pass reads the one before it, and the main
   * shader the last, with `prepassLoad(texel)` and `prepassSize()`.
   */
  passes?: readonly EffectPass[]
  /** Parameter groups Effect Controls shows folded at first (e.g. Levels' Red, Green, Blue). */
  closedGroups?: readonly string[]
  /**
   * The effect changes with the frame number or the beat even on a still picture (M11:
   * grain), through `frameIndex()`, `beatPosition()`, `beatsPerFrame()` and `beatsPerBar()`.
   * The render cache then keys its frames by them too.
   */
  readsClock?: boolean
  /**
   * The effect changes which moment is shown rather than the pixels (M12: Posterize Time).
   * The render plan works it out, and it has no GPU pass of its own.
   */
  holdsTime?: boolean
  /** What a parameter's value means right now, shown next to it (Posterize Time: "1/16 · 8.53 fps"). */
  readout?(param: string, params: Record<string, ParamValue>, context: { beatGrid: BeatGrid | null }): string | null
  migrate?(params: Record<string, unknown>, from: number): Record<string, unknown>
  /**
   * Converts one number from an older version's units (a parameter's value, its keyframes and
   * their handles, and modulation ranges), for an effect whose controls changed scale
   * (Basic Correction version 2). Runs after `migrate`.
   */
  migrateValue?(param: string, value: number, from: number): number
}

/** Where a frame is in time, for effects that read it (sequence frames from 0, and beats on the beat grid). */
export interface EffectClock {
  frame: number
  /** Beats since the grid's downbeat (negative before it); the default 120 BPM grid without one. */
  beat: number
  beatsPerFrame: number
  beatsPerBar: number
}

export interface EffectPass {
  shader: string
  /** The image this pass writes, for an effect input of `input` pixels. */
  size(input: ImageSize, params: Record<string, ParamValue>): ImageSize
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
  /** The shared mask limiting where the effect shows (M9), or null for everywhere. */
  mask: MaskRef | null
}

export interface ImageSize {
  width: number
  height: number
}

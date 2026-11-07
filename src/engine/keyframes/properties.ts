import { effectById } from '../../effects/registry'
import type { EffectInstance, ParamSpec, ParamValue } from '../effects/types'
import type { Clip } from '../project/model'
import type { Ticks } from '../time'
import { CommandError } from '../project/commands'
import { parseCurve } from '../effects/curves'
import { parseGradient } from '../gradients/gradient'
import { isLutPath } from '../effects/params'
import { components, evaluate, putKeyframe, type Keyframe } from './keyframes'
import { applyLinks, hasLinks } from '../modulation/apply'
import type { ModLink, ModulationContext, ModulationMap } from '../modulation/types'

/**
 * Everything that can be keyframed, addressed the same way: a clip's own properties
 * (Motion, Opacity, Volume, Speed) or an effect's parameters and Mix.
 */

export const MAX_VOLUME_DB = 15
export const MIN_VOLUME_DB = -96
/** Speed keyframes, in %: 0 pauses the picture; the top matches Speed/Duration's 10,000%. */
export const MAX_SPEED_PERCENT = 10_000

export type ClipProperty = 'position' | 'scale' | 'scaleWidth' | 'rotation' | 'anchor' | 'opacity' | 'volume' | 'speed'

/** Which value: `effectId` null for the clip's own properties; `param` 'mix' is an effect's Mix. */
export interface PropertyRef {
  clipId: string
  effectId: string | null
  param: string
}

export interface PropertySpec {
  label: string
  /** Numbers and points interpolate; stepped values (choices, toggles) always hold. */
  kind: 'number' | 'point' | 'stepped'
  /** A number whose keyframes always hold (a steps knob: whole steps, modulation allowed). */
  hold?: boolean
  min?: number
  max?: number
  unit?: string
  decimals?: number
  /** For an effect parameter: its manifest entry. */
  param?: ParamSpec
}

export const CLIP_PROPERTIES: Record<ClipProperty, PropertySpec> = {
  position: { label: 'Position', kind: 'point', decimals: 1 },
  scale: { label: 'Scale', kind: 'number', min: 0, max: 10_000, decimals: 1 },
  scaleWidth: { label: 'Scale Width', kind: 'number', min: 0, max: 10_000, unit: '%', decimals: 1 },
  rotation: { label: 'Rotation', kind: 'number', unit: '°', decimals: 1 },
  anchor: { label: 'Anchor Point', kind: 'point', decimals: 1 },
  opacity: { label: 'Opacity', kind: 'number', min: 0, max: 100, unit: '%', decimals: 1 },
  volume: { label: 'Volume', kind: 'number', min: MIN_VOLUME_DB, max: MAX_VOLUME_DB, unit: 'dB', decimals: 1 },
  speed: { label: 'Speed', kind: 'number', min: 0, max: MAX_SPEED_PERCENT, unit: '%', decimals: 1 }
}

/** The clip properties a clip has, in Effect Controls order. */
export function clipProperties(clip: Clip): ClipProperty[] {
  if (clip.kind === 'audio') return ['volume']
  if (clip.adjustment) return ['opacity']
  return ['position', 'scale', 'scaleWidth', 'rotation', 'anchor', 'opacity', 'speed']
}

/** Why Speed can't be keyframed on this clip, or null if it can. */
export function speedKeyframeProblem(clip: Clip): string | null {
  if (clip.kind !== 'video' || clip.adjustment) return 'Only video clips have speed keyframes'
  if (clip.reverse) return 'Speed keyframes work forwards only: turn off Reverse first (⌘R)'
  if (clip.speed === 0) return 'A frame hold has no speed to keyframe'
  return null
}

export function refKey(ref: Pick<PropertyRef, 'effectId' | 'param'>): string {
  return `${ref.effectId ?? 'clip'}:${ref.param}`
}

function paramProperty(spec: ParamSpec): PropertySpec {
  switch (spec.type) {
    case 'number':
      return { label: spec.label, kind: 'number', min: spec.min, max: spec.max, unit: spec.unit, decimals: spec.decimals ?? 1, param: spec }
    case 'angle':
      return { label: spec.label, kind: 'number', unit: '°', decimals: 1, param: spec }
    case 'point':
      return { label: spec.label, kind: 'point', decimals: 1, param: spec }
    case 'choice':
    case 'toggle':
    case 'curve':
    case 'gradient':
    case 'lut':
    case 'track':
      return { label: spec.label, kind: 'stepped', param: spec }
    case 'steps':
      return { label: spec.label, kind: 'number', min: 0, max: spec.steps.length - 1, decimals: 0, hold: true, param: spec }
  }
}

/** Whether a value's keyframes always hold (choices, toggles, curves, gradients and steps knobs). */
export function holds(spec: PropertySpec): boolean {
  return spec.kind === 'stepped' || spec.hold === true
}

const MIX: PropertySpec = { label: 'Mix', kind: 'number', min: 0, max: 100, unit: '%', decimals: 1 }

export function findEffect(clip: Clip, effectId: string): EffectInstance | undefined {
  return clip.effects.find((e) => e.id === effectId)
}

/** What a value is (its label, kind and range), or null if the clip doesn't have it. */
export function propertySpec(clip: Clip, effectId: string | null, param: string): PropertySpec | null {
  if (effectId === null) return (clipProperties(clip) as string[]).includes(param) ? CLIP_PROPERTIES[param as ClipProperty] : null
  const effect = findEffect(clip, effectId)
  if (!effect) return null
  if (param === 'mix') return MIX
  const spec = effectById(effect.effectId)?.params.find((p) => p.id === param)
  return spec ? paramProperty(spec) : null
}

/** The keyframes of a value (empty when it isn't animated). */
export function keyframesOf(clip: Clip, effectId: string | null, param: string): Keyframe[] {
  const map = effectId === null ? clip.keyframes : findEffect(clip, effectId)?.keyframes
  return map?.[param] ?? []
}

export function isAnimated(clip: Clip, effectId: string | null, param: string): boolean {
  return keyframesOf(clip, effectId, param).length > 0
}

/** The value when not animated (what's stored on the clip or effect). */
export function staticValue(clip: Clip, effectId: string | null, param: string): ParamValue {
  if (effectId !== null) {
    const effect = findEffect(clip, effectId)
    if (!effect) return 0
    return param === 'mix' ? effect.mix : (effect.params[param] ?? 0)
  }
  const m = clip.motion
  switch (param as ClipProperty) {
    case 'position':
      return [m.positionX, m.positionY]
    case 'anchor':
      return [m.anchorX, m.anchorY]
    case 'scale':
      return m.scale
    case 'scaleWidth':
      return m.scaleWidth
    case 'rotation':
      return m.rotation
    case 'opacity':
      return clip.opacity
    case 'volume':
      return clip.volume
    case 'speed':
      return clip.speed * 100
  }
}

/** A value made valid for its property: numbers clamped and finite, points finite. */
export function clampValue(spec: PropertySpec, value: ParamValue): ParamValue | null {
  if (spec.kind === 'stepped') {
    const p = spec.param
    if (p?.type === 'choice') return typeof value === 'string' && p.options.some((o) => o.id === value) ? value : null
    if (p?.type === 'toggle') return typeof value === 'boolean' ? value : null
    if (p?.type === 'curve') return typeof value === 'string' && parseCurve(value) ? value : null
    if (p?.type === 'gradient') return typeof value === 'string' && parseGradient(value) ? value : null
    if (p?.type === 'lut') return typeof value === 'string' && isLutPath(value) ? value : null
    if (p?.type === 'track') return typeof value === 'string' ? value : null
    return null
  }
  const c = components(value)
  if (!c || c.some((v) => !Number.isFinite(v))) return null
  if (spec.kind === 'point') return c.length === 2 ? [c[0]!, c[1]!] : null
  if (c.length !== 1) return null
  const v = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, c[0]!))
  return spec.param?.type === 'steps' ? Math.round(v) : v
}

/** Writes the value that's used when not animated. Speed isn't written here (Speed/Duration changes the clip's length). */
export function writeStatic(clip: Clip, effectId: string | null, param: string, value: ParamValue): void {
  if (effectId !== null) {
    const effect = findEffect(clip, effectId)
    if (!effect) return
    if (param === 'mix') effect.mix = Number(value)
    else effect.params[param] = Array.isArray(value) ? [value[0], value[1]] : value
    return
  }
  const m = clip.motion
  const n = Number(value)
  switch (param as ClipProperty) {
    case 'position':
      ;[m.positionX, m.positionY] = value as [number, number]
      return
    case 'anchor':
      ;[m.anchorX, m.anchorY] = value as [number, number]
      return
    case 'scale':
      m.scale = n
      return
    case 'scaleWidth':
      m.scaleWidth = n
      return
    case 'rotation':
      m.rotation = n
      return
    case 'opacity':
      clip.opacity = n
      return
    case 'volume':
      clip.volume = n
      return
    case 'speed':
      clip.speed = n / 100
  }
}

/** The value at `t` ticks from the clip's start (animated or not). */
export function valueAt(clip: Clip, effectId: string | null, param: string, t: Ticks): ParamValue {
  return evaluate(keyframesOf(clip, effectId, param), t, staticValue(clip, effectId, param))
}

export function hasKeyframes(clip: Clip): boolean {
  for (const key in clip.keyframes) if (clip.keyframes[key]!.length > 0) return true
  for (const effect of clip.effects) for (const key in effect.keyframes) if (effect.keyframes[key]!.length > 0) return true
  return false
}

/** Every animated value of a clip, clip properties first, then effects top to bottom. */
export function animatedRefs(clip: Clip): PropertyRef[] {
  const refs: PropertyRef[] = []
  for (const param of clipProperties(clip)) if (isAnimated(clip, null, param)) refs.push({ clipId: clip.id, effectId: null, param })
  for (const effect of clip.effects) {
    if (effect.keyframes['mix']?.length) refs.push({ clipId: clip.id, effectId: effect.id, param: 'mix' })
    for (const spec of effectById(effect.effectId)?.params ?? []) if (effect.keyframes[spec.id]?.length) refs.push({ clipId: clip.id, effectId: effect.id, param: spec.id })
  }
  return refs
}

/** Whether a value can be modulated: numbers and points (not Speed, choices, toggles or curves, nor what an effect marks `modulatable: false`). */
export function modulatable(clip: Clip, effectId: string | null, param: string): boolean {
  const spec = propertySpec(clip, effectId, param)
  if (spec === null || spec.kind === 'stepped' || (effectId === null && param === 'speed')) return false
  if (effectId === null) return true
  const effect = clip.effects.find((e) => e.id === effectId)
  return effectById(effect?.effectId ?? '')?.params.find((p) => p.id === param)?.modulatable !== false
}

/**
 * The clip as it is at sequence time `time`: Motion, Opacity, Volume and effect values
 * from their keyframes, then their modulation (when `modulation` is given), then clamped
 * to their ranges. Clips with neither come back as they are (no copy).
 */
export function resolveClip(clip: Clip, time: Ticks, modulation: ModulationContext | null = null): Clip {
  const modulated = modulation !== null && (hasLinks(clip.modulation) || clip.effects.some((e) => hasLinks(e.modulation)))
  if (!hasKeyframes(clip) && !modulated) return clip
  const t = time - clip.start
  const k = clip.keyframes
  const links = (map: ModulationMap, key: string) => (modulation && map[key]?.length ? map[key]! : null)
  // Curves can overshoot (bezier handles) and modulation can push past a range; values stay within it.
  const clamp = (v: number, min = -Infinity, max = Infinity) => Math.min(max, Math.max(min, v))
  const num = (param: ClipProperty, fallback: number) => {
    let v = k[param]?.length ? Number(evaluate(k[param]!, t, fallback)) : fallback
    const l = links(clip.modulation, param)
    if (l) v = applyLinks([v], l, modulation!, time)[0]!
    return k[param]?.length || l ? clamp(v, CLIP_PROPERTIES[param].min, CLIP_PROPERTIES[param].max) : v
  }
  const point = (param: ClipProperty, x: number, y: number): [number, number] => {
    let v = k[param]?.length ? (evaluate(k[param]!, t, [x, y]) as [number, number]) : ([x, y] as [number, number])
    const l = links(clip.modulation, param)
    if (l) v = applyLinks(v, l, modulation!, time) as [number, number]
    return v
  }
  const m = clip.motion
  const [positionX, positionY] = point('position', m.positionX, m.positionY)
  const [anchorX, anchorY] = point('anchor', m.anchorX, m.anchorY)
  return {
    ...clip,
    motion: { positionX, positionY, scale: num('scale', m.scale), scaleWidth: num('scaleWidth', m.scaleWidth), rotation: num('rotation', m.rotation), anchorX, anchorY },
    opacity: num('opacity', clip.opacity),
    volume: num('volume', clip.volume),
    effects: clip.effects.map((effect) => {
      const effectModulated = modulation !== null && hasLinks(effect.modulation)
      if (Object.keys(effect.keyframes).length === 0 && !effectModulated) return effect
      const params = { ...effect.params }
      const specs = effectById(effect.effectId)?.params
      const keys = new Set([...Object.keys(effect.keyframes), ...(effectModulated ? Object.keys(effect.modulation) : [])])
      for (const param of keys) {
        if (param === 'mix') continue
        const track = effect.keyframes[param]
        let value = track?.length ? evaluate(track, t, params[param] ?? 0) : (params[param] ?? 0)
        const spec = specs?.find((p) => p.id === param)
        const l = links(effect.modulation, param)
        const parts = components(value)
        if (l && parts && spec && spec.type !== 'choice' && spec.type !== 'toggle' && spec.type !== 'curve' && spec.type !== 'gradient' && spec.type !== 'lut' && spec.type !== 'track') {
          const out = applyLinks(parts, l, modulation!, time)
          value = Array.isArray(value) ? [out[0]!, out[1]!] : out[0]!
        }
        if (spec?.type === 'number' && typeof value === 'number') value = clamp(value, spec.min, spec.max)
        // A steps knob moves by whole steps: modulation is rounded to the nearest.
        if (spec?.type === 'steps' && typeof value === 'number') value = Math.round(clamp(value, 0, spec.steps.length - 1))
        params[param] = value
      }
      let mix = effect.keyframes['mix']?.length ? Number(evaluate(effect.keyframes['mix']!, t, effect.mix)) : effect.mix
      const mixLinks = links(effect.modulation, 'mix')
      if (mixLinks) mix = applyLinks([mix], mixLinks, modulation!, time)[0]!
      return { ...effect, params, mix: clamp(mix, 0, 100) }
    })
  }
}

/** A value with its modulation at sequence time `time` (for showing it, and the graph's faint curve). */
export function modulatedValueAt(clip: Clip, effectId: string | null, param: string, time: Ticks, modulation: ModulationContext): ParamValue {
  const resolved = resolveClip(clip, time, modulation)
  return effectId === null ? staticValue(resolved, null, param) : staticValue(resolved, effectId, param)
}

/** The modulation links on a value. */
export function linksOf(clip: Clip, effectId: string | null, param: string): ModLink[] {
  const map = effectId === null ? clip.modulation : findEffect(clip, effectId)?.modulation
  return map?.[param] ?? []
}

/** The frame a keyframe at `t` (ticks from the clip's start) lands on, or an error if that's outside the clip. */
export function keyframeTime(clip: Clip, t: Ticks | null, frame: Ticks): Ticks {
  if (t === null || t < 0 || t >= clip.duration) throw new CommandError(`Move the playhead over “${clip.name}” to set a keyframe there`)
  return Math.min(Math.floor((clip.duration - 1) / frame) * frame, Math.max(0, Math.round(t / frame) * frame))
}

/** The keyframe list for a value, created if missing (on a draft). */
export function trackFor(clip: Clip, effectId: string | null, param: string): Keyframe[] {
  const map = effectId === null ? clip.keyframes : findEffect(clip, effectId)?.keyframes
  if (!map) throw new CommandError('That effect is no longer on the clip')
  return (map[param] ??= [])
}

/**
 * Sets a value as the user sees it at `t` (ticks from the clip's start): if it's animated
 * that adds or changes the keyframe on that frame; otherwise it changes the stored value.
 */
export function writeValueAt(clip: Clip, effectId: string | null, param: string, value: ParamValue, t: Ticks | null, frame: Ticks, newId: () => string): void {
  const spec = propertySpec(clip, effectId, param)
  if (!spec) throw new CommandError(`“${clip.name}” has no ${param}`)
  const clean = clampValue(spec, value)
  if (clean === null) throw new CommandError(`${spec.label} can’t be set to that`)
  if (isAnimated(clip, effectId, param)) putKeyframe(trackFor(clip, effectId, param), keyframeTime(clip, t, frame), clean, newId(), holds(spec))
  else if (effectId === null && param === 'speed') throw new CommandError('Change the speed with Speed/Duration (⌘R), or turn on Speed keyframes')
  else writeStatic(clip, effectId, param, clean)
}

import { effectById } from '../../effects/registry'
import { BLEND_MODES, type BlendMode } from '../project/model'
import type { Interpolation, Keyframe, KeyframeMap } from '../keyframes/keyframes'
import { cloneEffect, sanitiseKeyframes } from './params'
import type { EffectInstance, ImageSize, ParamValue } from './types'

/**
 * Effect presets: one effect or a whole stack, saved to a library shared by every
 * project. They remember the image size they were made on, so positions (Transform's
 * Position and Anchor, pixel sizes) scale to the clip they're applied to.
 */
export interface EffectPreset {
  id: string
  name: string
  effects: EffectInstance[]
  size: ImageSize
  createdAt: string
}

/** Rescales pixel values (points and pixel lengths) from one image size to another. */
export function rescaleEffects(effects: EffectInstance[], from: ImageSize, to: ImageSize): EffectInstance[] {
  const sx = to.width / Math.max(1, from.width)
  const sy = to.height / Math.max(1, from.height)
  return effects.map((effect) => {
    const manifest = effectById(effect.effectId)
    const copy = cloneEffect(effect)
    if (!manifest || (sx === 1 && sy === 1)) return copy
    const scale = (spec: (typeof manifest.params)[number], value: ParamValue | undefined): ParamValue | undefined => {
      if (spec.type === 'point' && Array.isArray(value)) return [value[0] * sx, value[1] * sy]
      if (spec.type === 'number' && spec.pixels && typeof value === 'number') return value * sx
      return value
    }
    for (const spec of manifest.params) {
      const value = scale(spec, copy.params[spec.id])
      if (value !== undefined) copy.params[spec.id] = value
      // Keyframed positions scale too; bezier handles are offsets in the same units.
      for (const k of copy.keyframes[spec.id] ?? []) {
        k.value = scale(spec, k.value) ?? k.value
        if (spec.type === 'point') for (const h of [k.in, k.out]) h.v = [(h.v[0] ?? 0) * sx, (h.v[1] ?? 0) * sy]
        if (spec.type === 'number' && spec.pixels) for (const h of [k.in, k.out]) h.v = h.v.map((v) => v * sx)
      }
    }
    return copy
  })
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseValue(value: unknown): ParamValue | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number' && Number.isFinite(v))) return [value[0], value[1]]
  return null
}

const INTERPOLATIONS: readonly Interpolation[] = ['hold', 'linear', 'bezier']

function parseHandle(value: unknown): Keyframe['in'] | null {
  if (!isObject(value) || typeof value['t'] !== 'number' || !Array.isArray(value['v']) || !value['v'].every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  return { t: value['t'], v: value['v'] as number[] }
}

/** Keyframes as stored in a preset; damaged ones are skipped. */
function parseKeyframes(value: unknown): KeyframeMap {
  const map: KeyframeMap = {}
  if (!isObject(value)) return map
  for (const [key, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue
    const track: Keyframe[] = []
    for (const k of list) {
      if (!isObject(k) || typeof k['time'] !== 'number' || !Number.isInteger(k['time']) || !INTERPOLATIONS.includes(k['interpolation'] as Interpolation)) continue
      const value = parseValue(k['value'])
      const handleIn = parseHandle(k['in'])
      const handleOut = parseHandle(k['out'])
      if (value === null || !handleIn || !handleOut) continue
      track.push({ id: typeof k['id'] === 'string' ? k['id'] : `k${track.length}`, time: k['time'], value, interpolation: k['interpolation'] as Interpolation, in: handleIn, out: handleOut })
    }
    if (track.length > 0) map[key] = track
  }
  return map
}

/** The preset library as stored; anything damaged is skipped rather than failing the whole library. */
export function parsePresets(raw: unknown): EffectPreset[] {
  if (!isObject(raw) || !Array.isArray(raw['presets'])) return []
  const presets: EffectPreset[] = []
  for (const p of raw['presets']) {
    if (!isObject(p) || typeof p['id'] !== 'string' || typeof p['name'] !== 'string' || !Array.isArray(p['effects']) || !isObject(p['size'])) continue
    const effects: EffectInstance[] = []
    for (const e of p['effects']) {
      if (!isObject(e) || typeof e['effectId'] !== 'string' || !isObject(e['params'])) continue
      const blend = BLEND_MODES.some((m) => m.id === e['blendMode']) ? (e['blendMode'] as BlendMode) : 'normal'
      const params: Record<string, ParamValue> = {}
      for (const [key, value] of Object.entries(e['params'])) {
        const parsed = parseValue(value)
        if (parsed !== null) params[key] = parsed
      }
      effects.push({
        id: typeof e['id'] === 'string' ? e['id'] : `${p['id']}-${effects.length}`,
        effectId: e['effectId'],
        version: typeof e['version'] === 'number' ? e['version'] : 1,
        enabled: e['enabled'] !== false,
        mix: typeof e['mix'] === 'number' ? Math.min(100, Math.max(0, e['mix'])) : 100,
        blendMode: blend,
        params,
        keyframes: parseKeyframes(e['keyframes']),
        // Modulators and masks belong to a project, so presets never carry links to them.
        modulation: {},
        mask: null
      })
    }
    const width = Number(p['size']['width'])
    const height = Number(p['size']['height'])
    for (const effect of effects) {
      const manifest = effectById(effect.effectId)
      if (manifest) effect.keyframes = sanitiseKeyframes(manifest, effect.keyframes, { width: width > 0 ? width : 1, height: height > 0 ? height : 1 })
    }
    if (effects.length === 0 || !(width > 0) || !(height > 0)) continue
    presets.push({ id: p['id'], name: p['name'], effects, size: { width, height }, createdAt: typeof p['createdAt'] === 'string' ? p['createdAt'] : '' })
  }
  return presets
}

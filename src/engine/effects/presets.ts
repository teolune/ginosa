import { effectById } from '../../effects/registry'
import { BLEND_MODES, type BlendMode } from '../project/model'
import { cloneEffect } from './params'
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
    for (const spec of manifest.params) {
      const value = copy.params[spec.id]
      if (spec.type === 'point' && Array.isArray(value)) copy.params[spec.id] = [value[0] * sx, value[1] * sy]
      if (spec.type === 'number' && spec.pixels && typeof value === 'number') copy.params[spec.id] = value * sx
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
        params
      })
    }
    const width = Number(p['size']['width'])
    const height = Number(p['size']['height'])
    if (effects.length === 0 || !(width > 0) || !(height > 0)) continue
    presets.push({ id: p['id'], name: p['name'], effects, size: { width, height }, createdAt: typeof p['createdAt'] === 'string' ? p['createdAt'] : '' })
  }
  return presets
}

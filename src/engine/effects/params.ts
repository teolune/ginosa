import { cloneKeyframeMap, normaliseTrack, type KeyframeMap } from '../keyframes/keyframes'
import { cloneModulationMap } from '../modulation/apply'
import type { EffectInstance, EffectManifest, ImageSize, ParamSpec, ParamValue } from './types'
import { parseCurve } from './curves'

/** A parameter's default for an image of `size` (points are fractions of it). */
export function paramDefault(spec: ParamSpec, size: ImageSize): ParamValue {
  if (spec.type === 'point') return [spec.default[0] * size.width, spec.default[1] * size.height]
  return spec.default
}

export function defaultParams(manifest: EffectManifest, size: ImageSize): Record<string, ParamValue> {
  return Object.fromEntries(manifest.params.map((spec) => [spec.id, paramDefault(spec, size)]))
}

/** One value made valid for its spec: numbers clamped, unknown choices and wrong types replaced by the default. */
export function sanitiseValue(spec: ParamSpec, value: unknown, size: ImageSize): ParamValue {
  const fallback = paramDefault(spec, size)
  switch (spec.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? Math.min(spec.max, Math.max(spec.min, value)) : fallback
    case 'angle':
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    case 'choice':
      return typeof value === 'string' && spec.options.some((o) => o.id === value) ? value : fallback
    case 'toggle':
      return typeof value === 'boolean' ? value : fallback
    case 'point':
      return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number' && Number.isFinite(v)) ? [value[0] as number, value[1] as number] : fallback
    case 'curve':
      return typeof value === 'string' && parseCurve(value) ? value : fallback
    case 'steps':
      return typeof value === 'number' && Number.isFinite(value) ? Math.min(spec.steps.length - 1, Math.max(0, Math.round(value))) : fallback
  }
}

/** Parameters that hold between keyframes rather than move smoothly. */
export function isStepped(spec: ParamSpec): boolean {
  return spec.type === 'choice' || spec.type === 'toggle' || spec.type === 'curve' || spec.type === 'steps'
}

export function sanitiseParams(manifest: EffectManifest, raw: Record<string, unknown>, size: ImageSize): Record<string, ParamValue> {
  return Object.fromEntries(manifest.params.map((spec) => [spec.id, sanitiseValue(spec, raw[spec.id], size)]))
}

/** An effect's keyframes made valid: parameters it doesn't have dropped, values checked like the parameters, Mix 0–100. */
export function sanitiseKeyframes(manifest: EffectManifest, keyframes: KeyframeMap, size: ImageSize): KeyframeMap {
  const out: KeyframeMap = {}
  for (const [key, track] of Object.entries(keyframes)) {
    if (track.length === 0) continue
    if (key === 'mix') {
      out[key] = normaliseTrack(track, (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100), false)
      continue
    }
    const spec = manifest.params.find((p) => p.id === key)
    if (!spec) continue
    out[key] = normaliseTrack(track, (v) => sanitiseValue(spec, v, size), isStepped(spec))
  }
  return out
}

/**
 * Brings an instance made with an older version of its effect up to date. (Keyframes
 * are kept as they are: no effect has changed its parameters yet, so there's no
 * migration for them to need.)
 */
export function upgradeInstance(manifest: EffectManifest, instance: EffectInstance, size: ImageSize): EffectInstance {
  if (instance.version === manifest.version) return instance
  const raw = instance.version < manifest.version && manifest.migrate ? manifest.migrate({ ...instance.params }, instance.version) : instance.params
  return { ...instance, version: manifest.version, params: sanitiseParams(manifest, raw, size), keyframes: sanitiseKeyframes(manifest, instance.keyframes, size) }
}

/** A deep copy (params hold arrays for points), keyframes included. */
export function cloneEffect(effect: EffectInstance, id = effect.id): EffectInstance {
  return {
    ...effect,
    id,
    params: Object.fromEntries(Object.entries(effect.params).map(([k, v]) => [k, Array.isArray(v) ? ([v[0], v[1]] as [number, number]) : v])),
    keyframes: cloneKeyframeMap(effect.keyframes),
    modulation: cloneModulationMap(effect.modulation ?? {}),
    mask: effect.mask ? { ...effect.mask } : null
  }
}

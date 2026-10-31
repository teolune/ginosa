import type { EffectInstance, EffectManifest, ImageSize, ParamSpec, ParamValue } from './types'

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
  }
}

export function sanitiseParams(manifest: EffectManifest, raw: Record<string, unknown>, size: ImageSize): Record<string, ParamValue> {
  return Object.fromEntries(manifest.params.map((spec) => [spec.id, sanitiseValue(spec, raw[spec.id], size)]))
}

/** Brings an instance made with an older version of its effect up to date. */
export function upgradeInstance(manifest: EffectManifest, instance: EffectInstance, size: ImageSize): EffectInstance {
  if (instance.version === manifest.version) return instance
  const raw = instance.version < manifest.version && manifest.migrate ? manifest.migrate({ ...instance.params }, instance.version) : instance.params
  return { ...instance, version: manifest.version, params: sanitiseParams(manifest, raw, size) }
}

/** A deep copy (params hold arrays for points). */
export function cloneEffect(effect: EffectInstance, id = effect.id): EffectInstance {
  return {
    ...effect,
    id,
    params: Object.fromEntries(Object.entries(effect.params).map(([k, v]) => [k, Array.isArray(v) ? ([v[0], v[1]] as [number, number]) : v]))
  }
}

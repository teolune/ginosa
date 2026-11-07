import { cloneKeyframeMap, normaliseTrack, type KeyframeMap } from '../keyframes/keyframes'
import { cloneModulationMap } from '../modulation/apply'
import type { EffectInstance, EffectManifest, ImageSize, ParamSpec, ParamValue } from './types'
import { parseCurve } from './curves'
import { parseGradient } from '../gradients/gradient'

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
    case 'gradient':
      return typeof value === 'string' && parseGradient(value) ? value : fallback
    case 'lut':
      return typeof value === 'string' && isLutPath(value) ? value : fallback
    case 'track':
      return typeof value === 'string' ? value : fallback
    case 'steps':
      return typeof value === 'number' && Number.isFinite(value) ? Math.min(spec.steps.length - 1, Math.max(0, Math.round(value))) : fallback
  }
}

/** Parameters that hold between keyframes rather than move smoothly. */
export function isStepped(spec: ParamSpec): boolean {
  return spec.type === 'choice' || spec.type === 'toggle' || spec.type === 'curve' || spec.type === 'steps' || spec.type === 'gradient' || spec.type === 'lut' || spec.type === 'track'
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
 * Brings an instance made with an older version of its effect up to date: `migrate` for
 * renamed or reshaped parameters, then `migrateValue` for numbers whose scale changed, which
 * converts the values, keyframes (handles too: they're offsets in the same units) and
 * modulation ranges alike.
 */
export function upgradeInstance(manifest: EffectManifest, instance: EffectInstance, size: ImageSize): EffectInstance {
  if (instance.version === manifest.version) return instance
  const older = instance.version < manifest.version
  let raw: Record<string, unknown> = older && manifest.migrate ? manifest.migrate({ ...instance.params }, instance.version) : instance.params
  let keyframes = instance.keyframes
  let modulation = instance.modulation
  const convert = older ? manifest.migrateValue : undefined
  if (convert) {
    const from = instance.version
    const value = (param: string, v: number) => convert(param, v, from)
    raw = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'number' ? value(k, v) : v]))
    keyframes = cloneKeyframeMap(keyframes)
    for (const [param, track] of Object.entries(keyframes)) {
      for (const k of track) {
        if (typeof k.value !== 'number') continue
        const v = k.value
        const offset = (h: number[]) => (h.length === 1 && Number.isFinite(h[0]) ? [value(param, v + h[0]!) - value(param, v)] : h)
        k.in = { ...k.in, v: offset(k.in.v) }
        k.out = { ...k.out, v: offset(k.out.v) }
        k.value = value(param, v)
      }
    }
    // Ranges are in the value's units for add (as offsets) and replace; multiply's are factors.
    modulation = cloneModulationMap(modulation ?? {})
    for (const [param, links] of Object.entries(modulation)) {
      for (const link of links) {
        if (link.mode === 'multiply') continue
        const map = (x: number) => (link.mode === 'add' ? value(param, x) - value(param, 0) : value(param, x))
        link.min = link.min.length === 1 ? [map(link.min[0]!)] : link.min
        link.max = link.max.length === 1 ? [map(link.max[0]!)] : link.max
      }
    }
  }
  return { ...instance, version: manifest.version, params: sanitiseParams(manifest, raw, size), keyframes: sanitiseKeyframes(manifest, keyframes, size), modulation }
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

/** A LUT parameter's value: '' (none) or a .cube inside the project's luts folder. */
export function isLutPath(value: string): boolean {
  return value === '' || (/^luts\/[^/\\]+\.cube$/i.test(value) && !value.includes('..'))
}

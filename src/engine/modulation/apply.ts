import type { ModLink, ModulationContext, ModulationMap } from './types'

/**
 * A value after its modulation links, in order: each maps the modulator's 0–1 into the
 * value's units (min → max, or max → min inverted), then adds to, multiplies or replaces
 * the value, by its amount. Links whose modulator isn't ready are skipped.
 */
export function applyLinks(value: number[], links: readonly ModLink[], ctx: ModulationContext, time: number): number[] {
  let out = value
  for (const link of links) {
    let m = ctx.value(link.modulatorId, time)
    if (m === null) continue
    if (link.invert) m = 1 - m
    const amount = Math.min(1, Math.max(0, link.amount / 100))
    out = out.map((v, c) => {
      const lo = link.min[c] ?? link.min[0] ?? 0
      const hi = link.max[c] ?? link.max[0] ?? 0
      const mapped = lo + (hi - lo) * m!
      const target = link.mode === 'add' ? v + mapped : link.mode === 'multiply' ? v * mapped : mapped
      return v + (target - v) * amount
    })
  }
  return out
}

export function hasLinks(map: ModulationMap | undefined): boolean {
  if (!map) return false
  for (const key in map) if (map[key]!.length > 0) return true
  return false
}

export function cloneModulationMap(map: ModulationMap): ModulationMap {
  return Object.fromEntries(Object.entries(map).map(([key, links]) => [key, links.map((l) => ({ ...l, min: [...l.min], max: [...l.max] }))]))
}

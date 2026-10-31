/// <reference types="vite/client" />
import type { EffectManifest } from '../engine/effects/types'

/**
 * Every effect, found automatically: each folder here with a manifest.ts is an
 * effect. Adding an effect means adding a folder.
 */
const modules = import.meta.glob<{ default: EffectManifest }>('./*/manifest.ts', { eager: true })

export const EFFECTS: readonly EffectManifest[] = Object.entries(modules)
  .map(([path, module]) => {
    const folder = path.split('/')[1]
    if (module.default.id !== folder) throw new Error(`Effect in ${path} has id "${module.default.id}"; it must match its folder`)
    return module.default
  })
  .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))

const byId = new Map(EFFECTS.map((e) => [e.id, e]))

export function effectById(id: string): EffectManifest | undefined {
  return byId.get(id)
}

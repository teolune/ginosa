import type { Sequence } from '../project/model'
import type { ModLink } from '../modulation/types'

/**
 * After clips are deleted (W2): an automation modulator that no clip carries any more goes, with
 * its links, so the values it set keep their own again. Returns how many links went. (Kept apart
 * from automation-edits so the timeline's edits can use it without importing them back.)
 */
export function pruneAutomation(sequence: Sequence): number {
  const carried = new Set(sequence.clips.map((c) => c.automation?.modulatorId).filter((id): id is string => Boolean(id)))
  const gone = new Set(sequence.modulators.filter((m) => m.source.kind === 'automation' && !carried.has(m.id)).map((m) => m.id))
  if (gone.size === 0) return 0
  sequence.modulators = sequence.modulators.filter((m) => !gone.has(m.id))
  let links = 0
  const strip = (map: Record<string, ModLink[]>) => {
    for (const key of Object.keys(map)) {
      const kept = map[key]!.filter((l) => !gone.has(l.modulatorId))
      links += map[key]!.length - kept.length
      if (kept.length > 0) map[key] = kept
      else delete map[key]
    }
  }
  for (const clip of sequence.clips) {
    strip(clip.modulation)
    for (const effect of clip.effects) strip(effect.modulation)
  }
  for (const mask of sequence.masks) for (const shape of mask.shapes) strip(shape.modulation)
  return links
}

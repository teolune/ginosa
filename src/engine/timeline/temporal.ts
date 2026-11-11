import { effectById } from '../../effects/registry'
import { hashText } from '../audio/sources'
import type { EffectInstance } from '../effects/types'
import type { MediaItem } from '../project/media'
import type { Clip, Sequence } from '../project/model'
import type { VideoLayer } from './render-plan'
import type { Ticks } from '../time'
import { frameTicks } from './timeline'

/**
 * Stateful effects (M9): which clips have them, how many frames a clip's state has run
 * (from its reset, the first frame it's seen), and the key their state depends on.
 */

/** A checkpoint of every stateful effect's state is kept this often (frames since its reset), so a jump replays at most this many frames. */
export const CHECKPOINT_SECONDS = 1

export function isStateful(effectId: string): boolean {
  return effectById(effectId)?.time === 'stateful'
}

/** Whether a clip has a switched-on stateful effect. */
export function hasStatefulEffect(clip: Clip): boolean {
  return clip.effects.some((e) => e.enabled && isStateful(e.effectId))
}

/**
 * The video track an effect takes its motion from (M14, motion transfer), when it has a track
 * parameter naming one that's in the sequence; null otherwise (its own picture's motion).
 */
export function motionTrackOf(sequence: Sequence, effect: EffectInstance): string | null {
  if (!effect.enabled) return null
  const spec = effectById(effect.effectId)?.params.find((p) => p.type === 'track')
  const id = spec ? effect.params[spec.id] : undefined
  return typeof id === 'string' && id !== '' && sequence.tracks.some((t) => t.id === id && t.kind === 'video') ? id : null
}

/** Frames since the state's reset: the clip's first visible frame (a cross-dissolve's start, otherwise the clip's start). */
export function stateFrame(time: Ticks, resetAt: Ticks, frame: Ticks): number {
  return Math.max(0, Math.round((time - resetAt) / frame))
}

/** Every `CHECKPOINT_SECONDS`, in frames. */
export function checkpointEvery(sequence: Sequence): number {
  const frame = frameTicks(sequence)
  return Math.max(1, Math.round((CHECKPOINT_SECONDS * 254_016_000_000) / frame))
}

const keys = new WeakMap<Sequence, Map<string, string>>()

/**
 * What a clip's stateful effects depend on, as a key: any change to it throws their state
 * and checkpoints away (state from a different edit would be wrong). On a clip: the clip
 * (its effects, keyframes, links and masks), its media, the masks and modulators it uses,
 * the clips and media of any track it takes motion from (M14), and the frame size. On an adjustment layer, whose input is everything beneath it: the
 * whole sequence and its media. The modulation curves' id is added by the caller.
 */
export function stateKey(sequence: Sequence, media: readonly MediaItem[], clip: Clip, resetAt: Ticks): string {
  let cache = keys.get(sequence)
  if (!cache) {
    cache = new Map()
    keys.set(sequence, cache)
  }
  const cached = cache.get(clip.id)
  if (cached) return cached
  const stored = sequence.clips.find((c) => c.id === clip.id) ?? clip
  const shared = { settings: sequence.settings, modulators: sequence.modulators, beatGrid: sequence.beatGrid, audioSources: sequence.audioSources }
  const fingerprint = (item: MediaItem | undefined) => (item ? { id: item.id, fingerprint: item.fingerprint, colour: item.colour, info: item.info.video } : null)
  let content: unknown
  if (stored.adjustment) {
    const used = new Set(sequence.clips.map((c) => c.mediaId))
    content = { ...shared, tracks: sequence.tracks, clips: sequence.clips, masks: sequence.masks, media: media.filter((m) => used.has(m.id)).map(fingerprint), resetAt }
  } else {
    const maskIds = new Set([stored.mask?.id, ...stored.effects.map((e) => e.mask?.id)].filter(Boolean))
    // Motion sources (M14): every track any of its effects could take motion from, at any keyframe.
    const sourceTracks = new Set(stored.effects.flatMap((e) => [e, ...trackKeyframes(e)].map((v) => motionTrackOf(sequence, v)).filter((id): id is string => id !== null)))
    const sourceClips = sequence.clips.filter((c) => sourceTracks.has(c.trackId))
    const sources = sourceTracks.size ? { tracks: [...sourceTracks], clips: sourceClips, media: sourceClips.map((c) => fingerprint(media.find((m) => m.id === c.mediaId))) } : null
    content = { ...shared, clip: stored, media: fingerprint(media.find((m) => m.id === stored.mediaId)), masks: sequence.masks.filter((m) => maskIds.has(m.id)), sources, resetAt }
  }
  const key = hashText(JSON.stringify(content))
  cache.set(clip.id, key)
  return key
}

/** An effect as it is at each of its track parameter's keyframes (a motion source can be keyframed). */
function trackKeyframes(effect: EffectInstance): EffectInstance[] {
  const spec = effectById(effect.effectId)?.params.find((p) => p.type === 'track')
  const track = spec ? effect.keyframes[spec.id] : undefined
  return (track ?? []).map((k) => ({ ...effect, params: { ...effect.params, [spec!.id]: k.value } }))
}

/**
 * The layers a frame needs when it's rendered only for stateful effects' state: top down, a
 * layer with a stateful effect keeps its effects up to its last stateful one; an adjustment
 * layer's state depends on everything beneath it, so those are kept whole; anything else (layers
 * above the stateful ones, effects after the last stateful one) changes no state and is skipped.
 */
export function stateLayers(plan: readonly VideoLayer[]): VideoLayer[] {
  const out: VideoLayer[] = []
  let beneathCounts = false
  const consumers = new Set<string>()
  for (let i = plan.length - 1; i >= 0; i--) {
    const layer = plan[i]!
    if (layer.motionFor) {
      // A motion source: needed by its effect's state, or as part of an input that counts.
      if (beneathCounts || consumers.has(layer.motionFor)) out.push(layer)
      continue
    }
    if (beneathCounts) {
      out.push(layer)
      continue
    }
    let last = -1
    if (layer.temporal) layer.clip.effects.forEach((e, k) => e.enabled && isStateful(e.effectId) && (last = k))
    if (last < 0) continue
    const effects = layer.clip.effects.slice(0, last + 1)
    out.push(effects.length === layer.clip.effects.length ? layer : { ...layer, clip: { ...layer.clip, effects } })
    for (const id of Object.values(layer.motion ?? {})) consumers.add(id)
    if (layer.clip.adjustment) beneathCounts = true
  }
  return out.reverse()
}

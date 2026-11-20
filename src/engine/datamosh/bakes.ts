import { effectById } from '../../effects/registry'
import { hashText } from '../audio/sources'
import { tempoKey } from '../audio/tempo-map'
import type { EffectInstance } from '../effects/types'
import type { MediaItem } from '../project/media'
import type { Clip, Sequence } from '../project/model'
import type { ModulationContext } from '../modulation/types'
import type { Ticks } from '../time'
import { tracksOf } from '../timeline/timeline'
import { BAKE_VERSION, bakeSettings, bakeSpan, type BakeSpan } from './bake-plan'

/**
 * Datamosh Bake's bakes (M15): what each depends on (its key), the ones that are ready, and
 * how the render plan draws a baked effect: with its bake's frames once that's ready, and as
 * its live look (Datamosh, Engine A) until then.
 */

/** A finished bake: its file (in the project's cache), as a media item the players can open, and its span. */
export interface ReadyBake {
  key: string
  path: string
  item: MediaItem
  frames: number
}

const ready = new Map<string, ReadyBake>()
let version = 0

/** The bakes on disk, by key (the bake controller fills it; the render plan reads it). */
export const bakeStore = {
  get(key: string): ReadyBake | null {
    return ready.get(key) ?? null
  },
  set(bake: ReadyBake): void {
    ready.set(bake.key, bake)
    version++
  },
  delete(key: string): void {
    if (ready.delete(key)) version++
  },
  clear(): void {
    if (ready.size) version++
    ready.clear()
  },
  /** Changes whenever a bake comes or goes. */
  get version(): number {
    return version
  }
}

/** Whether an effect is baked (its manifest has `bake`), switched on. */
export function isBaked(effect: EffectInstance): boolean {
  return effect.enabled && effectById(effect.effectId)?.bake !== undefined
}

/** The video tracks beneath an adjustment layer's track. */
function tracksBelow(sequence: Sequence, trackId: string): Set<string> {
  const tracks = tracksOf(sequence, 'video')
  return new Set(tracks.slice(0, Math.max(0, tracks.findIndex((t) => t.id === trackId))).map((t) => t.id))
}

const hasLinks = (clips: readonly Clip[]) => clips.some((c) => Object.values(c.modulation).some((l) => l?.length) || c.effects.some((e) => Object.values(e.modulation).some((l) => l?.length)))

const keys = new WeakMap<Sequence, { media: readonly MediaItem[]; modulation: string; byEffect: Map<string, string> }>()

/**
 * What a bake depends on, as a key: anything that changes the picture it's made from, or how
 * it's made, changes the key (and so starts a new bake). On a clip: the clip with its effects
 * down to the bake (their keyframes and links too), its media, the masks those effects use and
 * the tracks they or the bake take motion from. On an adjustment layer: the layer with its effects
 * down to the bake, the tracks beneath and their clips and media, and every mask. Both: the frame
 * size and rate, the tempo, the markers (when markers are moments), the Channel Rack and the
 * modulators (when a channel is a moment or anything is linked), and the modulation curves' id
 * (when anything is linked). Edits elsewhere (a clip above, an effect below the bake) keep the key.
 */
export function bakeKey(sequence: Sequence, media: readonly MediaItem[], modulation: ModulationContext | null, clip: Clip, effectId: string): string {
  const curves = modulation?.id ?? 'none'
  let cache = keys.get(sequence)
  if (!cache || cache.media !== media || cache.modulation !== curves) {
    cache = { media, modulation: curves, byEffect: new Map() }
    keys.set(sequence, cache)
  }
  const id = `${clip.id}:${effectId}`
  const cached = cache.byEffect.get(id)
  if (cached) return cached
  const stored = sequence.clips.find((c) => c.id === clip.id) ?? clip
  const index = stored.effects.findIndex((e) => e.id === effectId)
  const effect = stored.effects[index]
  const owner = { ...stored, effects: stored.effects.slice(0, index + 1) }
  const settings = bakeSettings(effect?.params ?? {})
  const fingerprint = (item: MediaItem | undefined) => (item ? { id: item.id, fingerprint: item.fingerprint, colour: item.colour, info: item.info.video } : null)
  const motionTracks = new Set(owner.effects.map((e) => (e.enabled ? String(e.params[effectById(e.effectId)?.params.find((p) => p.type === 'track')?.id ?? ''] ?? '') : '')).filter(Boolean))
  const motionClips = sequence.clips.filter((c) => motionTracks.has(c.trackId))
  let input: Clip[]
  let content: Record<string, unknown>
  if (stored.adjustment) {
    const below = tracksBelow(sequence, stored.trackId)
    input = sequence.clips.filter((c) => below.has(c.trackId) || motionTracks.has(c.trackId))
    content = { tracks: tracksOf(sequence, 'video').map((t) => ({ id: t.id, visible: t.visible, solo: t.solo, below: below.has(t.id) })), masks: sequence.masks }
  } else {
    input = motionClips
    const maskIds = new Set([stored.mask?.id, ...owner.effects.map((e) => e.mask?.id)].filter(Boolean))
    content = { masks: sequence.masks.filter((m) => maskIds.has(m.id)) }
  }
  const used = new Set([owner, ...input].map((c) => c.mediaId))
  const linked = hasLinks([owner, ...input])
  const key = hashText(
    JSON.stringify({
      v: BAKE_VERSION,
      settings: sequence.settings,
      owner,
      input,
      media: media.filter((m) => used.has(m.id)).map(fingerprint),
      motionTracks: [...motionTracks],
      tempo: { grid: sequence.beatGrid, clips: tempoKey(sequence) },
      markers: settings.markers !== 'off' ? sequence.markers : null,
      rack: settings.channel || linked ? sequence.rack : null,
      modulators: linked ? sequence.modulators : null,
      audioSources: linked ? sequence.audioSources : null,
      curves: linked ? curves : null,
      ...content
    })
  )
  cache.byEffect.set(id, key)
  return key
}

/** A baked effect in a layer: the effect (with its bake key in its values) and its ready bake. */
export interface BakedEffect {
  effect: EffectInstance
  bake: ReadyBake
  span: BakeSpan
}

/**
 * The clip as the render plan draws it (`resolved`: its values at this moment): each baked
 * effect with a ready bake stays (its values carry the bake's key, so cached frames know which
 * bake they show) and is listed; one without is swapped for its live look.
 */
export function withBakes(sequence: Sequence, media: readonly MediaItem[], modulation: ModulationContext | null, stored: Clip, resolved: Clip): { clip: Clip; baked: BakedEffect[] } {
  if (!stored.effects.some(isBaked)) return { clip: resolved, baked: [] }
  const baked: BakedEffect[] = []
  const effects = resolved.effects.map((effect) => {
    if (!isBaked(effect)) return effect
    const manifest = effectById(effect.effectId)!
    const key = bakeKey(sequence, media, modulation, stored, effect.id)
    const bake = bakeStore.get(key)
    if (bake) {
      const shown = { ...effect, params: { ...effect.params, bakeKey: key } }
      baked.push({ effect: shown, bake, span: bakeSpan(sequence, stored) })
      return shown
    }
    const live = effectById(manifest.bake!.live)
    if (!live) return { ...effect, enabled: false }
    return { ...effect, effectId: live.id, version: live.version, params: manifest.bake!.liveParams(effect.params), keyframes: {}, modulation: {} }
  })
  return { clip: { ...resolved, effects }, baked }
}

/** The bake's frames as a clip: on the span, from the bake's first frame, placed where the effect's own picture is. */
export function bakeSourceClip(owner: Clip, bake: ReadyBake, span: BakeSpan, frame: Ticks, frameMotion: Clip['motion']): Clip {
  return {
    ...owner,
    id: `bake:${bake.key}`,
    mediaId: bake.item.id,
    name: 'Bake',
    start: span.start,
    duration: span.frames * frame,
    sourceIn: 0,
    speed: 1,
    reverse: false,
    transitionIn: null,
    transitionOut: null,
    effects: [],
    adjustment: false,
    keyframes: {},
    modulation: {},
    mask: null,
    opacity: 100,
    blendMode: 'normal',
    // A clip's bake is the clip's own picture: it sits where the clip does. An adjustment layer's fills the frame.
    motion: owner.adjustment ? frameMotion : owner.motion
  }
}

/**
 * What a bake is made from, as a sequence of its own (rendered over the span like an export):
 * on an adjustment layer, the sequence with that layer's track and every track above it emptied;
 * on a clip, just the clip, upright and unmoved on a frame its own size (without its Motion,
 * opacity, blend mode, mask or transitions), with only the effects above the bake, beside any
 * tracks those effects take motion from. Null when the bake's effect is gone.
 */
export function bakeInputSequence(sequence: Sequence, clip: Clip, effectId: string, sourceSize: { width: number; height: number }): Sequence | null {
  const stored = sequence.clips.find((c) => c.id === clip.id) ?? clip
  const index = stored.effects.findIndex((e) => e.id === effectId)
  if (index < 0) return null
  if (stored.adjustment) {
    const below = tracksBelow(sequence, stored.trackId)
    const videoIds = new Set(tracksOf(sequence, 'video').map((t) => t.id))
    // The bake's own motion source track is read on its own, not drawn into the picture.
    return { ...sequence, clips: sequence.clips.filter((c) => !videoIds.has(c.trackId) || below.has(c.trackId)) }
  }
  const effects = stored.effects.slice(0, index)
  const motionTracks = new Set(effects.map((e) => (e.enabled ? String(e.params[effectById(e.effectId)?.params.find((p) => p.type === 'track')?.id ?? ''] ?? '') : '')).filter(Boolean))
  const { width, height } = sourceSize
  const motion = { positionX: width / 2, positionY: height / 2, scale: 100, scaleWidth: 100, rotation: 0, anchorX: width / 2, anchorY: height / 2 }
  const keyframes = Object.fromEntries(Object.entries(stored.keyframes).filter(([p]) => !['positionX', 'positionY', 'position', 'scale', 'scaleWidth', 'rotation', 'anchorX', 'anchorY', 'anchor', 'opacity'].includes(p)))
  const modulationLinks = Object.fromEntries(Object.entries(stored.modulation).filter(([p]) => !['positionX', 'positionY', 'position', 'scale', 'scaleWidth', 'rotation', 'anchorX', 'anchorY', 'anchor', 'opacity'].includes(p)))
  const own: Clip = { ...stored, effects, motion, opacity: 100, blendMode: 'normal', mask: null, transitionIn: null, transitionOut: null, keyframes, modulation: modulationLinks }
  const tracks = sequence.tracks.map((t) => (t.id === stored.trackId ? { ...t, visible: true, solo: false } : t.kind === 'video' ? { ...t, solo: false } : t))
  return {
    ...sequence,
    settings: { ...sequence.settings, width, height },
    tracks,
    clips: [own, ...sequence.clips.filter((c) => c.kind !== 'video' || motionTracks.has(c.trackId))]
  }
}

/**
 * A bake's motion source as a sequence of its own: the clips on that track as shot (no effects,
 * mask, opacity or blend mode, the track shown even while hidden), alone, on the effect's frame:
 * the sequence's for an adjustment layer; for a clip, a frame the clip's size, fitted.
 */
export function motionSourceSequence(sequence: Sequence, clip: Clip, trackId: string, frame: { width: number; height: number }): Sequence | null {
  if (!sequence.tracks.some((t) => t.id === trackId && t.kind === 'video')) return null
  const stored = sequence.clips.find((c) => c.id === clip.id) ?? clip
  const fit = !stored.adjustment
  const sx = frame.width / sequence.settings.width
  const sy = frame.height / sequence.settings.height
  const k = Math.min(sx, sy)
  // On a clip's frame, the source keeps its place on the sequence's frame, scaled to fit (its Position and Scale keyframes too).
  const place = (keyframes: Clip['keyframes']): Clip['keyframes'] =>
    Object.fromEntries(
      Object.entries(keyframes).map(([param, track]) => [
        param,
        (track ?? []).map((key) =>
          param === 'position' && Array.isArray(key.value) ? { ...key, value: [key.value[0] * sx, key.value[1] * sy] as [number, number] } : param === 'scale' && typeof key.value === 'number' ? { ...key, value: key.value * k } : key
        )
      ])
    )
  const clips = sequence.clips
    .filter((c) => c.trackId === trackId && !c.adjustment)
    .map((c) => ({
      ...c,
      effects: [],
      mask: null,
      opacity: 100,
      blendMode: 'normal' as const,
      motion: fit ? { ...c.motion, positionX: c.motion.positionX * sx, positionY: c.motion.positionY * sy, scale: c.motion.scale * k } : c.motion,
      keyframes: fit ? place(c.keyframes) : c.keyframes
    }))
  const tracks = sequence.tracks.map((t) => (t.kind === 'video' ? { ...t, visible: t.id === trackId, solo: false } : t))
  return { ...sequence, settings: { ...sequence.settings, width: frame.width, height: frame.height }, tracks, clips }
}

/** A clip's span end and start, for code that only has the stored clip. */
export function bakeSpanOf(sequence: Sequence, clip: Clip): BakeSpan {
  return bakeSpan(sequence, sequence.clips.find((c) => c.id === clip.id) ?? clip)
}


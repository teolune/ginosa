import type { MediaItem } from '../project/media'
import type { AudioSource, Clip, Sequence } from '../project/model'
import type { Ticks } from '../time'
import { audibleTracks } from '../timeline/render-plan'
import { clipEnd } from '../timeline/timeline'
import { ANALYSIS_RATE, ANALYSIS_SAMPLE_RATE, ANALYSIS_VERSION } from './analysis'

/**
 * What an analysis source sounds like: which clips it takes in, over what stretch of the
 * sequence, and a key that changes exactly when that sound does (so analysis is redone
 * only then, and found in the cache otherwise).
 */

/** The audio clips a source takes in: a clip; every clip on a track, muted or not; or the mix as heard. */
export function sourceClips(sequence: Sequence, source: AudioSource): Clip[] {
  const audio = sequence.clips.filter((c) => c.kind === 'audio' && c.speed > 0 && !c.reverse)
  if (source.kind === 'clip') return audio.filter((c) => c.id === source.target)
  if (source.kind === 'track') return audio.filter((c) => c.trackId === source.target)
  const audible = audibleTracks(sequence)
  return audio.filter((c) => audible.has(c.trackId))
}

/** Why a source can't be analysed (its clip or track is gone, or it has no sound), or null. */
export function sourceProblem(sequence: Sequence, source: AudioSource): string | null {
  if (source.kind === 'clip' && !sequence.clips.some((c) => c.id === source.target)) return 'Its clip is no longer in the sequence'
  if (source.kind === 'track' && !sequence.tracks.some((t) => t.id === source.target)) return 'Its track is no longer in the sequence'
  if (sourceClips(sequence, source).length === 0) return source.kind === 'clip' ? 'That clip has no sound to analyse' : 'There is no sound there yet'
  return null
}

/** The stretch of sequence the source covers: from its first clip's start to its last clip's end. */
export function sourceRange(clips: Clip[]): { from: Ticks; to: Ticks } {
  return { from: Math.min(...clips.map((c) => c.start)), to: Math.max(...clips.map(clipEnd)) }
}

/** A short stable hash (cyrb53) of a string, as hex. */
export function hashText(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/**
 * The key for a source's sound: every detail that changes what it sounds like (the files,
 * where clips sit, their speed and volume) and nothing else, so renaming the source or
 * editing other tracks doesn't redo its analysis.
 */
export function sourceKey(sequence: Sequence, media: MediaItem[], source: AudioSource): string | null {
  const clips = sourceClips(sequence, source)
  if (clips.length === 0) return null
  const parts = [...clips]
    .sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId))
    .map((c) => {
      const item = media.find((m) => m.id === c.mediaId)
      return [item ? `${item.fingerprint.size}:${item.fingerprint.mtimeMs}:${item.fingerprint.sample}` : c.mediaId, c.start, c.duration, c.sourceIn, c.speed, c.volume, c.keyframes['volume'] ?? null, c.keyframes['speed'] ?? null]
    })
  return hashText(JSON.stringify({ v: ANALYSIS_VERSION, rate: ANALYSIS_RATE, sr: ANALYSIS_SAMPLE_RATE, parts }))
}

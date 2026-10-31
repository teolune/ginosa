import type { MediaItem } from '../project/media'
import type { Clip, Sequence } from '../project/model'
import type { Ticks } from '../time'
import { clipEnd, tracksOf } from './timeline'

/**
 * What plays at a given moment: the video layers to composite (bottom first) and the
 * audio to mix. Pure, so playback, the still preview and export (M5) all agree.
 */

export interface VideoLayer {
  clip: Clip
  item: MediaItem
  /** Time in the media file to show, in ticks. */
  sourceTime: Ticks
}

/** Where in its media a clip is at timeline time `time`. (Speed and reverse arrive in M4 part 2.) */
export function sourceTimeAt(clip: Clip, time: Ticks): Ticks {
  return clip.sourceIn + (time - clip.start)
}

/** Visible video layers at `time`, V1 first. Hidden tracks are skipped; if any are soloed, only those count. */
export function videoLayersAt(sequence: Sequence, media: MediaItem[], time: Ticks): VideoLayer[] {
  const tracks = tracksOf(sequence, 'video')
  const soloed = tracks.some((t) => t.solo)
  const layers: VideoLayer[] = []
  for (const track of tracks) {
    if (!track.visible || (soloed && !track.solo)) continue
    const clip = sequence.clips.find((c) => c.trackId === track.id && c.start <= time && clipEnd(c) > time)
    if (!clip || clip.opacity <= 0) continue
    const item = media.find((m) => m.id === clip.mediaId)
    if (!item) continue
    layers.push({ clip, item, sourceTime: sourceTimeAt(clip, time) })
  }
  return layers
}

export interface AudioSegment {
  clip: Clip
  item: MediaItem
  /** Linear gain from the clip's volume (dB). */
  gain: number
}

export function dbToGain(db: number): number {
  return db <= -96 ? 0 : Math.pow(10, db / 20)
}

/** Whether an audio track is heard: not muted, and soloed if any audio track is. */
export function audibleTracks(sequence: Sequence): Set<string> {
  const tracks = tracksOf(sequence, 'audio')
  const soloed = tracks.some((t) => t.solo)
  return new Set(tracks.filter((t) => !t.muted && (!soloed || t.solo)).map((t) => t.id))
}

/** Audio clips overlapping [from, to) on audible tracks. */
export function audioSegments(sequence: Sequence, media: MediaItem[], from: Ticks, to: Ticks): AudioSegment[] {
  const audible = audibleTracks(sequence)
  const segments: AudioSegment[] = []
  for (const clip of sequence.clips) {
    if (clip.kind !== 'audio' || !audible.has(clip.trackId)) continue
    if (clipEnd(clip) <= from || clip.start >= to) continue
    const item = media.find((m) => m.id === clip.mediaId)
    if (!item || !item.info.audio) continue
    segments.push({ clip, item, gain: dbToGain(clip.volume) })
  }
  return segments.sort((a, b) => a.clip.start - b.clip.start)
}

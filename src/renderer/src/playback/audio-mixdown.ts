import type { MediaItem } from '@engine/project/media'
import type { Sequence } from '@engine/project/model'
import { ticksToSeconds, type Ticks } from '@engine/time'
import { audibleTracks, audioSegments, type AudioSegment } from '@engine/timeline/render-plan'
import { ClipFeeder, type MixTarget } from './audio-engine'

/**
 * The export's sound: the timeline mixed offline with the same scheduling code as
 * playback (clip and track gains, mute and solo, varispeed), so the file sounds like
 * what you heard. Returns interleaved stereo float samples.
 */
export async function renderMixdown(
  sequence: Sequence,
  media: MediaItem[],
  from: Ticks,
  to: Ticks,
  sampleRate: number,
  resolvePath: (item: MediaItem) => string | null
): Promise<Float32Array> {
  const rendered = await renderAudio(sequence, media, from, to, sampleRate, 2, null, resolvePath)
  const left = rendered.getChannelData(0)
  const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left
  const out = new Float32Array(rendered.length * 2)
  for (let i = 0; i < rendered.length; i++) {
    out[i * 2] = left[i]!
    out[i * 2 + 1] = right[i]!
  }
  return out
}

/**
 * A stretch of the timeline mixed offline: the audible tracks, or with `only`, exactly
 * those clips (muted or not), down-mixed to `channels`.
 */
export async function renderAudio(
  sequence: Sequence,
  media: MediaItem[],
  from: Ticks,
  to: Ticks,
  sampleRate: number,
  channels: 1 | 2,
  only: ReadonlySet<string> | null,
  resolvePath: (item: MediaItem) => string | null
): Promise<AudioBuffer> {
  const length = Math.max(1, Math.round(ticksToSeconds(to - from) * sampleRate))
  const ctx = new OfflineAudioContext({ numberOfChannels: channels, length, sampleRate })
  const master = ctx.createGain()
  master.connect(ctx.destination)
  const tracks = new Map<string, GainNode>()
  const audible = audibleTracks(sequence)
  const target: MixTarget = {
    ctx,
    startTime: from,
    ctxTimeOf: (time) => ticksToSeconds(time - from),
    trackGain(trackId) {
      let node = tracks.get(trackId)
      if (!node) {
        node = ctx.createGain()
        node.gain.value = only || audible.has(trackId) ? 1 : 0
        node.connect(master)
        tracks.set(trackId, node)
      }
      return node
    },
    noteScheduled: () => undefined
  }
  const segments: AudioSegment[] = audioSegments(sequence, media, from, to, only)
  const feeders: ClipFeeder[] = []
  for (const segment of segments) {
    const path = resolvePath(segment.item)
    if (!path) throw new Error(`${segment.item.name} isn't available (offline, or its optimised copy isn't ready)`)
    feeders.push(new ClipFeeder(target, segment, path))
  }
  // Everything is scheduled before rendering starts.
  await Promise.all(feeders.map((f) => f.pump(Number.POSITIVE_INFINITY)))
  const failed = feeders.find((f) => f.error)
  if (failed) throw new Error(`Sound from ${failed.segment.item.name}: ${failed.error}`)
  return ctx.startRendering()
}

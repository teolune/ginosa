import type { Sequence } from '@engine/project/model'
import type { MediaItem } from '@engine/project/media'
import { secondsToTicks, ticksToSeconds, type Ticks } from '@engine/time'
import { audibleTracks, audioSegments, type AudioSegment } from '@engine/timeline/render-plan'
import { clipEnd, sourceSpan } from '@engine/timeline/timeline'
import type { WrappedAudioBuffer } from 'mediabunny'
import { openMedia } from './sources'

/** How far ahead audio is decoded and scheduled, in seconds. */
const LOOKAHEAD = 1.2
/** Clips starting this soon get their decoder opened early. */
const PREPARE = 2.5
/** Playback starts this long after Play, so the first sounds are scheduled in time. */
const START_DELAY = 0.12

/** What a ClipFeeder schedules into: the live engine, or the offline export mixdown. */
export interface MixTarget {
  readonly ctx: BaseAudioContext
  /** Timeline time the mix starts at. */
  readonly startTime: Ticks
  /** Context time at which timeline time `time` plays. */
  ctxTimeOf(time: Ticks): number
  trackGain(trackId: string): GainNode
  noteScheduled(at: number, mediaSeconds: number, segment: AudioSegment): void
}

/** Feeds one clip's sound into Web Audio, a little ahead of time (or all at once, offline). */
export class ClipFeeder {
  private iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null = null
  private pending: WrappedAudioBuffer | null = null
  private done = false
  private busy = false
  private readonly gain: GainNode
  readonly sources = new Set<AudioBufferSourceNode>()
  /** Why decoding stopped early, if it did (export fails rather than leaving a silent gap). */
  error: string | null = null

  constructor(
    private readonly engine: MixTarget,
    readonly segment: AudioSegment,
    private readonly path: string
  ) {
    this.gain = engine.ctx.createGain()
    this.gain.gain.value = segment.gain
    this.gain.connect(engine.trackGain(segment.clip.trackId))
  }

  /** Context time at which this clip's media time `seconds` plays. */
  private ctxTimeFor(mediaSeconds: number): number {
    const clip = this.segment.clip
    const timeline = clip.start + (secondsToTicks(mediaSeconds) - clip.sourceIn) / clip.speed
    return this.engine.ctxTimeOf(timeline)
  }

  async pump(until: number): Promise<void> {
    if (this.done || this.busy) return
    this.busy = true
    try {
      const clip = this.segment.clip
      if (!this.iterator) {
        const media = await openMedia(this.path)
        if (!media.audioSink) {
          this.done = true
          return
        }
        // Start where playback starts (or where the clip starts, if later).
        const from = Math.max(clip.start, this.engine.startTime)
        const sourceFrom = ticksToSeconds(clip.sourceIn + (from - clip.start) * clip.speed)
        const sourceTo = ticksToSeconds(clip.sourceIn + sourceSpan(clip))
        this.origin = media.origin
        this.iterator = media.audioSink.buffers(media.origin + Math.max(0, sourceFrom - 0.05), media.origin + sourceTo + 0.05)
      }
      const clipStartCtx = this.engine.ctxTimeOf(Math.max(clip.start, this.engine.startTime))
      const clipEndCtx = this.engine.ctxTimeOf(clipEnd(clip))
      while (!this.done) {
        const buffer = this.pending ?? (await this.next())
        if (!buffer) break
        const when = this.ctxTimeFor(buffer.timestamp - this.origin)
        if (when > until) {
          this.pending = buffer
          break
        }
        this.pending = null
        // At other speeds the sound is played faster or slower, so its pitch changes (varispeed).
        const speed = clip.speed
        const lo = Math.max(when, clipStartCtx, this.engine.ctx.currentTime)
        const hi = Math.min(when + buffer.buffer.duration / speed, clipEndCtx)
        if (hi - lo > 0.0005) {
          const source = this.engine.ctx.createBufferSource()
          source.buffer = buffer.buffer
          source.playbackRate.value = speed
          source.connect(this.gain)
          // Offset and duration are in the buffer's own time.
          source.start(lo, (lo - when) * speed, (hi - lo) * speed)
          this.engine.noteScheduled(lo, buffer.timestamp - this.origin + (lo - when) * speed, this.segment)
          this.sources.add(source)
          source.onended = () => this.sources.delete(source)
        }
        if (when >= clipEndCtx) this.done = true
      }
    } catch (error) {
      this.done = true
      this.error = (error as Error).message
      console.warn('Audio decode stopped:', this.error)
    } finally {
      this.busy = false
    }
  }

  private origin = 0

  private async next(): Promise<WrappedAudioBuffer | null> {
    const result = await this.iterator!.next()
    if (result.done) {
      this.done = true
      return null
    }
    return result.value
  }

  stop(): void {
    this.done = true
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        // already stopped
      }
    }
    this.sources.clear()
    void this.iterator?.return(undefined).catch(() => undefined)
    this.gain.disconnect()
  }
}

export interface ScheduledSound {
  /** Context time it plays. */
  at: number
  /** Media time (seconds) at that moment. */
  mediaSeconds: number
  clipId: string
}

/**
 * The master clock. Sound is scheduled ahead on the AudioContext; the picture asks
 * what time is being heard right now and shows that frame, so they can't drift.
 */
export class AudioEngine implements MixTarget {
  readonly ctx: AudioContext
  private readonly master: GainNode
  private readonly tracks = new Map<string, GainNode>()
  private feeders = new Map<string, ClipFeeder>()
  private timer: number | null = null
  private sequence: Sequence | null = null
  private media: MediaItem[] = []
  private resolvePath: (item: MediaItem) => string | null = () => null
  /** Timeline time playback started from, and the context time it plays at. */
  startTime: Ticks = 0
  private startCtx = 0
  running = false
  /** Recent schedules, for the sync test. */
  readonly log: ScheduledSound[] = []
  logging = false

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
  }

  trackGain(trackId: string): GainNode {
    let node = this.tracks.get(trackId)
    if (!node) {
      node = this.ctx.createGain()
      node.connect(this.master)
      this.tracks.set(trackId, node)
    }
    return node
  }

  ctxTimeOf(time: Ticks): number {
    return this.startCtx + ticksToSeconds(time - this.startTime)
  }

  /** Context time of the sound coming out of the speakers now: the audio clock minus output latency. */
  private audioNow(): number {
    return this.ctx.currentTime - (this.ctx.outputLatency || 0)
  }

  /** The timeline time being heard right now, straight from the audio clock (steps every few ms). */
  heardTime(): Ticks {
    if (!this.running) return this.startTime
    return this.startTime + secondsToTicks(Math.max(0, this.audioNow() - this.startCtx))
  }

  /**
   * The same, smoothed against the system clock so pictures advance evenly: the offset
   * between the two clocks is averaged, and re-locked if they ever disagree by 50 ms.
   */
  private smooth: number | null = null

  smoothedTime(): Ticks {
    if (!this.running) return this.startTime
    const wall = performance.now() / 1000
    const raw = this.audioNow() - wall
    if (this.smooth === null || Math.abs(raw - this.smooth) > 0.05) this.smooth = raw
    else this.smooth += (raw - this.smooth) * 0.02
    return this.startTime + secondsToTicks(Math.max(0, wall + this.smooth - this.startCtx))
  }

  noteScheduled(at: number, mediaSeconds: number, segment: AudioSegment): void {
    if (this.logging) this.log.push({ at, mediaSeconds, clipId: segment.clip.id })
  }

  async start(sequence: Sequence, media: MediaItem[], from: Ticks, resolvePath: (item: MediaItem) => string | null): Promise<void> {
    this.stop()
    if (this.ctx.state !== 'running') await this.ctx.resume()
    this.sequence = sequence
    this.media = media
    this.resolvePath = resolvePath
    this.updateTracks(sequence)
    this.startTime = from
    this.startCtx = this.ctx.currentTime + START_DELAY
    this.smooth = null
    this.running = true
    this.tick()
    this.timer = window.setInterval(() => this.tick(), 100)
  }

  /** Applies mute and solo immediately. */
  updateTracks(sequence: Sequence): void {
    const audible = audibleTracks(sequence)
    for (const track of sequence.tracks.filter((t) => t.kind === 'audio')) {
      this.trackGain(track.id).gain.setTargetAtTime(audible.has(track.id) ? 1 : 0, this.ctx.currentTime, 0.01)
    }
  }

  private tick(): void {
    if (!this.running || !this.sequence) return
    const now = this.heardTime()
    const horizon = now + secondsToTicks(PREPARE)
    for (const segment of audioSegments(this.sequence, this.media, now, horizon)) {
      if (this.feeders.has(segment.clip.id) || clipEnd(segment.clip) <= this.startTime) continue
      const path = this.resolvePath(segment.item)
      if (!path) continue
      this.feeders.set(segment.clip.id, new ClipFeeder(this, segment, path))
    }
    const until = this.ctx.currentTime + LOOKAHEAD
    for (const [id, feeder] of this.feeders) {
      if (clipEnd(feeder.segment.clip) < now - secondsToTicks(1) && feeder.sources.size === 0) {
        feeder.stop()
        this.feeders.delete(id)
      } else void feeder.pump(until)
    }
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    for (const feeder of this.feeders.values()) feeder.stop()
    this.feeders.clear()
  }
}

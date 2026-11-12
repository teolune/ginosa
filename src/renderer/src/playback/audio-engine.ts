import type { Sequence } from '@engine/project/model'
import type { ModulationContext } from '@engine/modulation/types'
import type { MediaItem } from '@engine/project/media'
import { secondsToTicks, ticksToSeconds, type Ticks } from '@engine/time'
import { GAIN_CURVE_STEP_SECONDS, audibleTracks, audioSegments, gainAt, type AudioSegment } from '@engine/timeline/render-plan'
import { speedAt } from '@engine/keyframes/keyframes'
import { clipEnd, sourceSpan, sourceTimeAt, speedRamp, timeForMedia } from '@engine/timeline/timeline'
import type { WrappedAudioBuffer } from 'mediabunny'
import { beatsBetween } from '@engine/audio/beat-grid'
import { useMedia, type MediaUse } from './sources'

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
  /** Modulators' outputs (Volume can be modulated), or null. */
  readonly modulation: ModulationContext | null
}

/** Feeds one clip's sound into Web Audio, a little ahead of time (or all at once, offline). */
export class ClipFeeder {
  private iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null = null
  private pending: WrappedAudioBuffer | null = null
  private done = false
  private busy = false
  /** Its file, held open while it's read. */
  private use: MediaUse | null = null
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
    if (segment.clip.keyframes['volume']?.length || (engine.modulation && segment.clip.modulation['volume']?.length)) this.automateVolume()
    this.gain.connect(engine.trackGain(segment.clip.trackId))
  }

  /**
   * Volume keyframes: the gain follows them as a value curve sampled every millisecond
   * (Web Audio joins the points with straight lines). Live playback and the export
   * mixdown schedule the same curve.
   */
  private automateVolume(fromCtx?: number): void {
    const clip = this.segment.clip
    let from = Math.max(clip.start, this.engine.startTime)
    if (fromCtx !== undefined) from = Math.max(from, this.engine.startTime + secondsToTicks(fromCtx - this.engine.ctxTimeOf(this.engine.startTime)))
    const to = clipEnd(clip)
    if (to <= from) return
    const seconds = ticksToSeconds(to - from)
    // At most 2 million points (over half an hour at 1 ms); longer clips are sampled more coarsely.
    const points = Math.min(2_000_000, Math.max(2, Math.ceil(seconds / GAIN_CURVE_STEP_SECONDS) + 1))
    const curve = new Float32Array(points)
    for (let i = 0; i < points; i++) curve[i] = gainAt(clip, from + ((to - from) * i) / (points - 1), this.engine.modulation)
    if (fromCtx === undefined) this.gain.gain.value = curve[0]!
    this.gain.gain.setValueCurveAtTime(curve, this.engine.ctxTimeOf(from), seconds)
  }

  /**
   * New modulation while playing (a Channel Rack edit, say): a clip whose Volume it moves
   * follows the new curve from context time `at` (what's already playing holds until then).
   */
  remodulate(at: number): void {
    if (!this.segment.clip.modulation['volume']?.length) return
    const gain = this.gain.gain
    try {
      gain.cancelAndHoldAtTime(at)
      this.automateVolume(at + 0.001)
    } catch {
      gain.cancelScheduledValues(0)
      gain.setValueAtTime(gainAt(this.segment.clip, this.engine.startTime + secondsToTicks(at - this.engine.ctxTimeOf(this.engine.startTime)), this.engine.modulation), at)
    }
    this.remodulated++
  }

  /** Times the Volume followed new curves while playing (tests). */
  remodulated = 0

  /** Context time at which this clip's media time `seconds` plays. */
  private ctxTimeFor(mediaSeconds: number): number {
    return this.engine.ctxTimeOf(timeForMedia(this.segment.clip, secondsToTicks(mediaSeconds)))
  }

  /**
   * A speed-ramped clip (its picture's Speed keyframes, decision 41): each decoded piece
   * starts when the ramp reaches it, and its playback rate follows the ramp (sampled every
   * millisecond), so the sound speeds up and slows down with the picture, like tape.
   */
  private scheduleRamped(buffer: WrappedAudioBuffer, ramp: Parameters<typeof speedAt>[0]): void {
    const clip = this.segment.clip
    const mediaStart = buffer.timestamp - this.origin
    const mediaEnd = mediaStart + buffer.buffer.duration
    const from = timeForMedia(clip, secondsToTicks(mediaStart))
    const to = timeForMedia(clip, secondsToTicks(mediaEnd))
    let lo = Math.max(from, clip.start, this.engine.startTime)
    const hi = Math.min(to, clipEnd(clip))
    // Running late (live playback): start from now.
    const late = this.engine.ctx.currentTime - this.engine.ctxTimeOf(lo)
    if (late > 0) lo += secondsToTicks(late)
    if (hi - lo < secondsToTicks(0.0005)) return
    const mediaAt = (time: number) => ticksToSeconds(sourceTimeAt(clip, time, 0))
    const offset = Math.max(0, mediaAt(lo) - mediaStart)
    const length = Math.max(0, mediaAt(hi) - mediaStart - offset)
    const seconds = ticksToSeconds(hi - lo)
    const points = Math.max(2, Math.ceil(seconds / 0.001) + 1)
    const curve = new Float32Array(points)
    for (let i = 0; i < points; i++) curve[i] = speedAt(ramp, lo + ((hi - lo) * i) / (points - 1) - clip.start) / 100
    const source = this.engine.ctx.createBufferSource()
    source.buffer = buffer.buffer
    source.playbackRate.value = curve[0]!
    source.playbackRate.setValueCurveAtTime(curve, this.engine.ctxTimeOf(lo), seconds)
    source.connect(this.gain)
    source.start(this.engine.ctxTimeOf(lo), offset, length)
    this.engine.noteScheduled(this.engine.ctxTimeOf(lo), mediaStart + offset, this.segment)
    this.sources.add(source)
    source.onended = () => this.sources.delete(source)
  }

  async pump(until: number): Promise<void> {
    if (this.done || this.busy) return
    this.busy = true
    try {
      const clip = this.segment.clip
      if (!this.iterator) {
        this.use = await useMedia(this.path)
        const media = this.use.media
        if (this.done) return
        if (!media.audioSink) {
          this.done = true
          return
        }
        // Start where playback starts (or where the clip starts, if later).
        const from = Math.max(clip.start, this.engine.startTime)
        const sourceFrom = ticksToSeconds(sourceTimeAt(clip, from, 0))
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
        const ramp = speedRamp(clip)
        if (ramp) {
          this.scheduleRamped(buffer, ramp)
          if (when >= clipEndCtx) this.done = true
          continue
        }
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
      // Everything read (or stopped): the file can be closed when the limit needs it.
      if (this.done) this.releaseFile()
    }
  }

  private releaseFile(): void {
    this.use?.release()
    this.use = null
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
    if (!this.busy) this.releaseFile()
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
  /** Modulators' outputs at the moment playback started (Volume modulation). */
  modulation: ModulationContext | null = null
  /** Recent schedules, for the sync test. */
  readonly log: ScheduledSound[] = []
  logging = false
  /** Metronome clicks scheduled while logging: context time and the beat's timeline time. */
  readonly clickLog: Array<{ at: number; time: Ticks; bar: boolean }> = []

  /** Metronome (Control Panel): a click on every beat of the grid, a higher one on each bar. */
  private metronomeOn = false
  private clickSounds: { beat: AudioBuffer; bar: AudioBuffer } | null = null
  private clicks = new Set<AudioBufferSourceNode>()
  /** Timeline time clicks are scheduled up to. */
  private clickedTo: Ticks = 0

  get metronome(): boolean {
    return this.metronomeOn
  }

  set metronome(on: boolean) {
    if (on === this.metronomeOn) return
    this.metronomeOn = on
    if (!on) this.stopClicks()
    else if (this.running) {
      this.clickedTo = this.heardTime()
      this.tick()
    }
  }

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
    this.clickedTo = from
    this.running = true
    this.tick()
    this.timer = window.setInterval(() => this.tick(), 100)
  }

  /** An edit while playing that leaves every sound where it was: tracks' mute and solo, and the beat grid (metronome), from now. */
  update(sequence: Sequence): void {
    this.sequence = sequence
    this.updateTracks(sequence)
  }

  /** New modulation curves while playing: clips whose Volume they move follow them from now; clips starting later use them anyway. */
  setModulation(modulation: ModulationContext | null): void {
    const same = modulation === this.modulation || (modulation?.id !== undefined && modulation.id === this.modulation?.id)
    this.modulation = modulation
    if (same || !this.running) return
    const at = this.ctx.currentTime + 0.02
    for (const feeder of this.feeders.values()) feeder.remodulate(at)
  }

  /** What comes out of the speakers, for tests to measure (made on first use). */
  private analyser: AnalyserNode | null = null

  tap(): AnalyserNode {
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 1024
      this.master.connect(this.analyser)
    }
    return this.analyser
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
    if (this.metronomeOn) this.scheduleClicks(until)
  }

  /** Schedules the clicks for beats up to context time `until` (the same lookahead as the sound). */
  private scheduleClicks(until: number): void {
    const grid = this.sequence?.beatGrid
    if (!grid) return
    const to = this.startTime + secondsToTicks(until - this.startCtx)
    if (to < this.clickedTo) return
    const sounds = (this.clickSounds ??= metronomeClicks(this.ctx))
    for (const beat of beatsBetween(grid, Math.max(0, this.clickedTo), to)) {
      const at = this.ctxTimeOf(beat.time)
      if (at < this.ctx.currentTime) continue
      const node = this.ctx.createBufferSource()
      node.buffer = beat.bar ? sounds.bar : sounds.beat
      node.connect(this.master)
      node.onended = () => this.clicks.delete(node)
      node.start(at)
      this.clicks.add(node)
      if (this.logging) this.clickLog.push({ at, time: beat.time, bar: beat.bar })
    }
    this.clickedTo = to + 1
  }

  private stopClicks(): void {
    for (const node of this.clicks) {
      try {
        node.stop()
      } catch {
        // Already finished.
      }
    }
    this.clicks.clear()
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    for (const feeder of this.feeders.values()) feeder.stop()
    this.feeders.clear()
    this.stopClicks()
  }
}

/** The metronome's two clicks: short decaying sine blips, 1 kHz on beats and 1.6 kHz on bars. */
export function metronomeClicks(ctx: BaseAudioContext): { beat: AudioBuffer; bar: AudioBuffer } {
  const make = (hz: number, gain: number): AudioBuffer => {
    const length = Math.round(ctx.sampleRate * 0.04)
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < length; i++) {
      const t = i / ctx.sampleRate
      data[i] = Math.sin(2 * Math.PI * hz * t) * Math.exp(-t * 90) * gain
    }
    return buffer
  }
  return { beat: make(1000, 0.35), bar: make(1600, 0.5) }
}

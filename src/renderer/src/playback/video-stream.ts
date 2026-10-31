import type { VideoSample } from 'mediabunny'
import type { OpenedMedia } from './sources'

/** What the player reads frames from while playing one clip. */
export interface FrameSource {
  /** The frame to show at `seconds` (media time), or null if nothing has been decoded yet. */
  frameAt(seconds: number): VideoSample | null
  ready(timeoutMs: number): Promise<void>
  close(): void
  late: number
}

/**
 * Sequential decoding of one clip during playback: a few frames are decoded ahead,
 * and each display tick takes the newest frame due at the current time.
 */
export class VideoStream implements FrameSource {
  private readonly iterator: AsyncGenerator<VideoSample, void, unknown>
  private queue: VideoSample[] = []
  private current: VideoSample | null = null
  private pumping = false
  private ended = false
  private closed = false
  /** How many frames we had to show late because decoding hadn't caught up. */
  late = 0

  constructor(
    private readonly media: OpenedMedia,
    startSeconds: number,
    private readonly ahead = 5
  ) {
    if (!media.videoSink) throw new Error('This file has no decodable video')
    this.iterator = media.videoSink.samples(media.origin + Math.max(0, startSeconds))
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.closed && !this.ended && this.queue.length < this.ahead) {
        const next = await this.iterator.next()
        if (next.done) this.ended = true
        else if (this.closed) next.value.close()
        else this.queue.push(next.value)
      }
    } catch (error) {
      this.ended = true
      console.warn('Video decode stopped:', (error as Error).message)
    } finally {
      this.pumping = false
    }
  }

  /** Resolves once the first frame is decoded (or the clip has none). */
  async ready(timeoutMs: number): Promise<void> {
    const until = performance.now() + timeoutMs
    while (this.queue.length === 0 && !this.ended && !this.closed && performance.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  /** The frame to show at `seconds` (media time), or null if nothing has been decoded yet. */
  frameAt(seconds: number): VideoSample | null {
    const due = this.media.origin + seconds + 1e-6
    while (this.queue.length > 0 && this.queue[0]!.timestamp <= due) {
      this.current?.close()
      this.current = this.queue.shift()!
    }
    if (this.current && this.queue.length === 0 && !this.ended && this.current.timestamp + this.current.duration < due) this.late++
    void this.pump()
    return this.current
  }

  close(): void {
    this.closed = true
    void this.iterator.return(undefined).catch(() => undefined)
    for (const sample of this.queue) sample.close()
    this.queue = []
    this.current?.close()
    this.current = null
  }
}

/** A frame hold: one frame, decoded once. */
export class HoldStream implements FrameSource {
  private sample: VideoSample | null = null
  private closed = false
  private readonly loading: Promise<void>
  late = 0

  constructor(media: OpenedMedia, seconds: number) {
    if (!media.videoSink) throw new Error('This file has no decodable video')
    this.loading = media.videoSink
      .getSample(media.origin + Math.max(0, seconds) + 1e-6)
      .then((sample) => {
        if (this.closed) sample?.close()
        else this.sample = sample
      })
      .catch((error: Error) => console.warn('Frame hold decode failed:', error.message))
  }

  async ready(timeoutMs: number): Promise<void> {
    await Promise.race([this.loading, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
  }

  frameAt(): VideoSample | null {
    return this.sample
  }

  close(): void {
    this.closed = true
    this.sample?.close()
    this.sample = null
  }
}

interface Chunk {
  from: number
  to: number
  samples: VideoSample[]
  done: boolean
}

/**
 * Reverse playback. Video can only be decoded forwards from a keyframe, so this decodes
 * short stretches of media in turn, latest first, and keeps only the frames that will
 * actually be shown (the media times the clip steps through), so memory stays small
 * even at high speeds. The next stretch is decoded while the current one plays.
 */
export class ReverseStream implements FrameSource {
  private chunks: Chunk[] = []
  private current: VideoSample | null = null
  private closed = false
  private decoding = false
  late = 0
  /** Frames kept per stretch; a stretch also covers at least this much media time. */
  private static readonly KEEP = 8
  private static readonly MIN_SECONDS = 0.32

  /**
   * @param startSeconds the first (latest) media time shown
   * @param step media seconds between shown frames
   * @param frameSeconds the media's own frame duration
   */
  constructor(
    private readonly media: OpenedMedia,
    private readonly startSeconds: number,
    private readonly step: number,
    frameSeconds: number
  ) {
    if (!media.videoSink) throw new Error('This file has no decodable video')
    this.span = Math.max(ReverseStream.MIN_SECONDS, Math.min(ReverseStream.KEEP * step, ReverseStream.KEEP * Math.max(step, frameSeconds)))
    void this.decodeNext()
  }

  private readonly span: number

  private lowestFrom(): number {
    return this.chunks.length > 0 ? this.chunks[this.chunks.length - 1]!.from : this.startSeconds + this.step / 2
  }

  /** Decodes the stretch just before the lowest one we have. */
  private async decodeNext(): Promise<void> {
    if (this.decoding || this.closed) return
    const to = this.lowestFrom()
    if (to <= 0) return
    const from = Math.max(0, to - this.span)
    const chunk: Chunk = { from, to, samples: [], done: false }
    this.chunks.push(chunk)
    this.decoding = true
    // The media times this stretch will be asked for, highest first.
    const wanted: number[] = []
    for (let k = Math.ceil((this.startSeconds - to) / this.step - 1e-9); ; k++) {
      const t = this.startSeconds - k * this.step
      if (t < from - 1e-9) break
      if (t < to - 1e-9) wanted.push(t)
    }
    wanted.reverse()
    try {
      const sink = this.media.videoSink!
      let previous: VideoSample | null = null
      let index = 0
      const keep = (sample: VideoSample | null) => {
        if (sample && chunk.samples[chunk.samples.length - 1] !== sample) chunk.samples.push(sample)
      }
      // Start a frame early so the frame showing at `from` is included.
      for await (const sample of sink.samples(this.media.origin + Math.max(0, from - this.step), this.media.origin + to)) {
        if (this.closed) {
          sample.close()
          break
        }
        const at = sample.timestamp - this.media.origin
        while (index < wanted.length && at > wanted[index]! + 1e-6) {
          keep(previous)
          index++
        }
        if (previous && !chunk.samples.includes(previous)) previous.close()
        previous = sample
      }
      while (index < wanted.length) {
        keep(previous)
        index++
      }
      if (previous && !chunk.samples.includes(previous)) previous.close()
    } catch (error) {
      console.warn('Reverse decode stopped:', (error as Error).message)
    } finally {
      chunk.done = true
      this.decoding = false
      if (this.closed) this.releaseChunk(chunk)
    }
  }

  async ready(timeoutMs: number): Promise<void> {
    const until = performance.now() + timeoutMs
    while (!this.closed && !(this.chunks[0]?.done ?? false) && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  frameAt(seconds: number): VideoSample | null {
    const due = seconds + 1e-6
    const chunk = this.chunks.find((c) => c.done && c.from - 1e-6 <= seconds && seconds < c.to + 1e-6)
    let found: VideoSample | null = null
    if (chunk) {
      for (const sample of chunk.samples) {
        if (sample.timestamp - this.media.origin <= due) found = sample
        else break
      }
    }
    if (found && found !== this.current) {
      if (this.current && !this.chunks.some((c) => c.samples.includes(this.current!))) this.current.close()
      this.current = found
    } else if (!found && this.current) this.late++
    // Let go of stretches already played, and start the next one in time.
    for (const old of this.chunks.filter((c) => c.done && c.from > seconds + this.step)) {
      if (old.samples.includes(this.current!)) continue
      this.releaseChunk(old)
      this.chunks.splice(this.chunks.indexOf(old), 1)
    }
    const lowest = this.chunks[this.chunks.length - 1]
    if (lowest && seconds - lowest.from < this.span) void this.decodeNext()
    return this.current
  }

  private releaseChunk(chunk: Chunk): void {
    for (const sample of chunk.samples) if (sample !== this.current) sample.close()
    chunk.samples = []
  }

  close(): void {
    this.closed = true
    for (const chunk of this.chunks) if (chunk.done) this.releaseChunk(chunk)
    this.chunks = []
    // releaseChunk leaves the frame on screen alone; it goes now.
    this.current?.close()
    this.current = null
  }
}

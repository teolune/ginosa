import type { VideoSample } from 'mediabunny'
import type { OpenedMedia } from './sources'

/**
 * Sequential decoding of one clip during playback: a few frames are decoded ahead,
 * and each display tick takes the newest frame due at the current time.
 */
export class VideoStream {
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

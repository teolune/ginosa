import type { MediaItem } from '@engine/project/media'
import type { Clip, Sequence } from '@engine/project/model'
import type { ModulationContext } from '@engine/modulation/types'
import { ticksToSeconds, type Ticks } from '@engine/time'
import { videoLayersAt } from '@engine/timeline/render-plan'
import { stateLayers } from '@engine/timeline/temporal'
import type { VideoSample } from 'mediabunny'
import type { Compositor, CompositeStep } from './compositor'
import type { LayerBuilder } from './layers'
import { openMedia, openStill, type OpenedMedia } from './sources'

/** Further ahead than this, a new decode from the nearest keyframe is quicker than decoding on. */
const JUMP_SECONDS = 2

/** For the performance tests: decodes started again from a keyframe, and frames decoded. */
export const exactStats = { restarts: 0, decoded: 0 }

/**
 * Frames for one clip, exactly, with no deadline. Forward clips decode in order;
 * reversed clips and holds fetch each frame they need.
 */
export class ExactFrames {
  private iterator: AsyncGenerator<VideoSample, void, unknown> | null = null
  private current: VideoSample | null = null
  private peek: VideoSample | null | undefined = undefined
  private held: { seconds: number; sample: VideoSample } | null = null
  private lastSeconds = -Infinity

  constructor(
    private readonly media: OpenedMedia,
    private readonly clip: Clip
  ) {}

  async frameAt(seconds: number): Promise<VideoSample | null> {
    const sink = this.media.videoSink
    if (!sink) return null
    const due = this.media.origin + seconds + 1e-6
    if (this.clip.speed === 0 || this.clip.reverse) {
      if (this.held && Math.abs(this.held.seconds - seconds) < 1e-9) return this.held.sample
      const sample = await sink.getSample(due)
      this.held?.sample.close()
      this.held = sample ? { seconds, sample } : null
      return sample
    }
    // Going backwards (a new catch-up from an earlier point), or jumping well ahead (a paused
    // frame far on): start decoding again from there, rather than through everything between.
    if (seconds < this.lastSeconds - 1e-9 || seconds > this.lastSeconds + JUMP_SECONDS) this.restart()
    this.lastSeconds = seconds
    if (!this.iterator) {
      this.iterator = sink.samples(this.media.origin + Math.max(0, seconds))
      this.peek = undefined
    }
    if (this.peek === undefined) this.peek = (await this.iterator.next()).value ?? null
    while (this.peek && this.peek.timestamp <= due) {
      this.current?.close()
      this.current = this.peek
      this.peek = (await this.iterator.next()).value ?? null
      exactStats.decoded++
    }
    // The first frame of the clip can sit just after the requested time (a stream's first timestamp).
    if (!this.current && this.peek) {
      this.current = this.peek
      this.peek = (await this.iterator.next()).value ?? null
    }
    return this.current
  }

  private restart(): void {
    if (this.iterator) exactStats.restarts++
    void this.iterator?.return(undefined).catch(() => undefined)
    this.iterator = null
    this.current?.close()
    this.current = null
    if (this.peek) this.peek.close()
    this.peek = undefined
  }

  close(): void {
    this.restart()
    this.held?.sample.close()
    this.held = null
  }
}

/**
 * Renders frames exactly (every layer's picture decoded, nothing dropped), in time order:
 * export, a stateful effect catching up before a still, and preview renders (M9).
 */
export class ExactRenderer {
  private sources = new Map<string, ExactFrames>()
  /** Where the time goes (the performance test reads it): planning, waiting for decoded frames, recording the GPU work. */
  stats = { frames: 0, planMs: 0, decodeMs: 0, renderMs: 0 }

  constructor(
    private readonly compositor: Compositor,
    private readonly layers: LayerBuilder,
    private readonly resolvePath: (item: MediaItem) => string | null
  ) {}

  /**
   * The composite at `time` (output pixels per sequence pixel: `scale`). The texture is the
   * compositor's: use it before the next render. `stateOnly`: the frame is rendered only to move
   * stateful effects on (catching up, unseen), so what doesn't feed their state is skipped.
   */
  async render(sequence: Sequence, media: MediaItem[], time: Ticks, modulation: ModulationContext | null, scale: number, stateOnly = false): Promise<GPUTexture> {
    const started = performance.now()
    const whole = videoLayersAt(sequence, media, time, modulation)
    const plan = stateOnly ? stateLayers(whole) : whole
    this.stats.planMs += performance.now() - started
    const composite: CompositeStep[] = []
    const videoFrames: VideoFrame[] = []
    try {
      for (const layer of plan) {
        if (!layer.item) {
          composite.push(this.layers.adjustment(layer))
          continue
        }
        const file = this.resolvePath(layer.item)
        if (!file) throw new Error(`${layer.item.name} isn't available`)
        if (layer.item.kind === 'image') {
          const texture = this.layers.loadedStill(file) ?? this.layers.stillTexture(file, await openStill(file))
          const built = this.layers.build(layer, { kind: 'image', texture }, sequence)
          if (built) composite.push(built)
          continue
        }
        let source = this.sources.get(layer.clip.id)
        if (!source) {
          source = new ExactFrames(await openMedia(file), layer.clip)
          this.sources.set(layer.clip.id, source)
        }
        const waited = performance.now()
        const sample = await source.frameAt(ticksToSeconds(layer.sourceTime))
        this.stats.decodeMs += performance.now() - waited
        if (!sample) throw new Error(`${layer.item.name}: no picture at ${ticksToSeconds(layer.sourceTime).toFixed(2)} s`)
        const videoFrame = sample.toVideoFrame()
        videoFrames.push(videoFrame)
        const built = this.layers.build(layer, { kind: 'video', frame: videoFrame }, sequence)
        if (built) composite.push(built)
      }
      // Clips no longer playing are let go of.
      const present = new Set(whole.map((l) => l.clip.id))
      for (const [clipId, source] of this.sources) {
        if (!present.has(clipId)) {
          source.close()
          this.sources.delete(clipId)
        }
      }
      const recording = performance.now()
      const result = this.compositor.render(composite, scale)
      this.stats.renderMs += performance.now() - recording
      this.stats.frames++
      return result
    } finally {
      videoFrames.forEach((f) => f.close())
    }
  }

  close(): void {
    for (const source of this.sources.values()) source.close()
    this.sources.clear()
  }
}

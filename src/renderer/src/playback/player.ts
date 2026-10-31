import type { MediaItem } from '@engine/project/media'
import type { Sequence } from '@engine/project/model'
import { frameRateOf } from '@engine/project/model'
import { frameRateValue, secondsToTicks, ticksPerFrame, ticksToSeconds, type Ticks } from '@engine/time'
import { inverseMotion, sourceSize } from '@engine/timeline/motion'
import { videoLayersAt, type VideoLayer } from '@engine/timeline/render-plan'
import { sequenceEnd } from '@engine/timeline/timeline'
import type { VideoSample } from 'mediabunny'
import { getGpu } from '../gpu/shared'
import { mediaController } from '../state/media-controller'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { AudioEngine } from './audio-engine'
import { Compositor, type CompositeLayer } from './compositor'
import { openMedia, openStill } from './sources'
import { VideoStream } from './video-stream'

export type PlaybackResolution = 1 | 0.5 | 0.25

export interface PlaybackStats {
  /** Frames presented per second, measured. */
  fps: number
  /** Frames where a layer's picture wasn't ready in time. */
  dropped: number
  /** Average time to composite and present a frame, ms. */
  renderMs: number
  /** How far the shown picture trails the sound, ms (positive = picture late). */
  lagMs: number
}

/** One presented frame, recorded for the sync test. */
export interface PresentedFrame {
  /** performance.now() when the frame was handed to the GPU. */
  at: number
  /** Timeline time the picture shows. */
  timeline: Ticks
  /** Timeline time the sound was at. */
  heard: Ticks
}

/**
 * Timeline playback: Web Audio is the master clock; every display refresh the
 * player asks which time is being heard and composites the frames for it. Paused,
 * it renders the frame under the playhead with the same compositor.
 */
class Player extends Observable {
  playing = false
  /** 1 = normal; 2, 4, 8 fast forward; negative = reverse (J). Sound plays at 1× only. */
  rate = 1
  resolution: PlaybackResolution = 1
  showStats = false
  stats: PlaybackStats = { fps: 0, dropped: 0, renderMs: 0, lagMs: 0 }
  message: string | null = null

  audio: AudioEngine | null = null
  private compositor: Compositor | null = null
  private device: GPUDevice | null = null
  private canvas: HTMLCanvasElement | null = null
  private context: GPUCanvasContext | null = null
  private format: GPUTextureFormat = 'bgra8unorm'
  private streams = new Map<string, VideoStream>()
  private stillTextures = new Map<string, GPUTexture>()
  private frameHandle = 0
  private wallStart = 0
  private startTime: Ticks = 0
  private lastShownFrame = -1
  private presentedCount = 0
  private statsWindowStart = 0
  private renderTotal = 0
  private stillRender: { busy: boolean; again: boolean } = { busy: false, again: false }
  private sequenceAtStart: Sequence | null = null
  recording: PresentedFrame[] | null = null
  /** Why frames were counted as dropped (for diagnosis). */
  debug = { skipped: 0, missing: {} as Record<string, number> }
  /** Test hook: called with each composited frame during playback. */
  probe: ((result: GPUTexture, timeline: Ticks) => void) | null = null

  constructor() {
    super()
    projectController.subscribe(() => this.onProjectChange())
    timelineController.subscribe(() => this.onTimelineChange())
  }

  // ---- Screen ----------------------------------------------------------------------

  async attach(canvas: HTMLCanvasElement): Promise<void> {
    const gpu = await getGpu()
    this.device = gpu.device
    this.compositor ??= new Compositor(gpu.device)
    this.canvas = canvas
    this.context = canvas.getContext('webgpu')
    this.format = navigator.gpu.getPreferredCanvasFormat()
    this.context?.configure({ device: gpu.device, format: this.format, alphaMode: 'opaque' })
    this.requestStill()
  }

  detach(canvas: HTMLCanvasElement): void {
    if (this.canvas !== canvas) return
    this.stop()
    this.canvas = null
    this.context = null
  }

  setResolution(resolution: PlaybackResolution): void {
    this.resolution = resolution
    this.notify()
    this.requestStill()
  }

  toggleStats(): void {
    this.showStats = !this.showStats
    this.notify()
  }

  private sizeFor(sequence: Sequence): { width: number; height: number; scale: number } {
    const scale = this.resolution
    return { width: Math.max(2, Math.round(sequence.settings.width * scale)), height: Math.max(2, Math.round(sequence.settings.height * scale)), scale }
  }

  private prepareTarget(sequence: Sequence): number {
    const { width, height, scale } = this.sizeFor(sequence)
    this.compositor!.resize(width, height)
    if (this.canvas && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width
      this.canvas.height = height
    }
    return scale
  }

  // ---- Layers ----------------------------------------------------------------------

  private path(item: MediaItem): string | null {
    return mediaController.playablePath(item)
  }

  private stillTexture(path: string, bitmap: ImageBitmap): GPUTexture {
    let texture = this.stillTextures.get(path)
    if (!texture) {
      texture = this.compositor!.imageTexture(bitmap)
      this.stillTextures.set(path, texture)
    }
    return texture
  }

  private compositeLayer(layer: VideoLayer, source: CompositeLayer['source'], sequence: Sequence): CompositeLayer | null {
    const inverse = inverseMotion(layer.clip.motion)
    if (!inverse) return null
    const size = sourceSize(layer.item, sequence.settings)
    const rotation = Math.round(((layer.item.info.video?.rotation ?? 0) % 360) / 90)
    return { source, inverse, width: size.width, height: size.height, rotation: (rotation + 4) % 4, opacity: layer.clip.opacity / 100, blend: layer.clip.blendMode }
  }

  // ---- Still frame (paused) --------------------------------------------------------

  /** Renders the frame under the playhead. Requests made while busy collapse into one. */
  requestStill(): void {
    if (this.playing) return
    if (this.stillRender.busy) {
      this.stillRender.again = true
      return
    }
    this.stillRender.busy = true
    void this.renderStill().finally(() => {
      this.stillRender.busy = false
      if (this.stillRender.again) {
        this.stillRender.again = false
        this.requestStill()
      }
    })
  }

  private async renderStill(duringPlayback = false): Promise<void> {
    const project = projectController.project
    if (!project || !this.compositor || !this.context) return
    const sequence = timelineController.sequence ?? project.sequence
    const time = timelineController.playhead
    const layers = videoLayersAt(sequence, project.media, time)
    const samples: VideoSample[] = []
    const prepared: Array<{ layer: VideoLayer; source: CompositeLayer['source'] | null }> = []
    let message: string | null = null
    for (const layer of layers) {
      const path = this.path(layer.item)
      if (!path) {
        message = mediaController.get(layer.item.id).status === 'offline' ? `${layer.item.name} is offline` : `${layer.item.name}: optimised copy in progress`
        continue
      }
      try {
        if (layer.item.kind === 'image') {
          prepared.push({ layer, source: { kind: 'image', texture: this.stillTexture(path, await openStill(path)) } })
        } else {
          const media = await openMedia(path)
          const sample = media.videoSink ? await media.videoSink.getSample(media.origin + ticksToSeconds(layer.sourceTime) + 1e-6) : null
          if (sample) samples.push(sample)
          prepared.push({ layer, source: sample ? { kind: 'video', frame: sample.toVideoFrame() } : null })
        }
      } catch (error) {
        message = `${layer.item.name}: ${(error as Error).message}`
      }
    }
    if (this.playing && !duringPlayback) {
      for (const p of prepared) if (p.source?.kind === 'video') p.source.frame.close()
      samples.forEach((s) => s.close())
      return
    }
    const scale = this.prepareTarget(sequence)
    const composite = prepared.flatMap((p) => {
      const layer = p.source ? this.compositeLayer(p.layer, p.source, sequence) : null
      return layer ? [layer] : []
    })
    const result = this.compositor.render(composite, scale)
    this.compositor.present(result, this.context, this.format)
    for (const p of prepared) if (p.source?.kind === 'video') p.source.frame.close()
    samples.forEach((s) => s.close())
    if (message !== this.message) {
      this.message = message
      this.notify()
    }
  }

  private onTimelineChange(): void {
    if (!this.playing) this.requestStill()
  }

  private onProjectChange(): void {
    const project = projectController.project
    if (!project) {
      this.stop()
      return
    }
    if (this.playing && this.sequenceAtStart && project.sequence !== this.sequenceAtStart) {
      // The edit changed while playing: carry on from here with the new edit.
      const time = this.currentTime()
      if (project.sequence.tracks !== this.sequenceAtStart.tracks && project.sequence.clips === this.sequenceAtStart.clips) {
        this.audio?.updateTracks(project.sequence)
        this.sequenceAtStart = project.sequence
      } else void this.play(this.rate, time)
      return
    }
    this.requestStill()
  }

  // ---- Playback --------------------------------------------------------------------

  /** Last clock reading, so the picture never steps backwards when the audio clock's estimate wobbles. */
  private lastClock: Ticks = 0

  private currentTime(): Ticks {
    let time: Ticks
    if (this.rate === 1 && this.audio?.running) time = this.audio.smoothedTime()
    else time = this.startTime + secondsToTicks(((performance.now() - this.wallStart) / 1000) * this.rate)
    if (this.rate > 0) time = Math.max(time, this.lastClock)
    else if (this.rate < 0) time = Math.min(time, this.lastClock)
    this.lastClock = time
    return time
  }

  async play(rate = 1, from: Ticks = timelineController.playhead): Promise<void> {
    const project = projectController.project
    if (!project || !this.compositor) return
    this.stopStreams()
    this.audio?.stop()
    const end = sequenceEnd(project.sequence)
    if (rate > 0 && from >= end - ticksPerFrame(frameRateOf(project.sequence.settings))) from = 0
    this.playing = true
    this.rate = rate
    this.startTime = from
    this.lastClock = from
    this.wallStart = performance.now()
    this.sequenceAtStart = project.sequence
    this.stats = { fps: 0, dropped: 0, renderMs: 0, lagMs: 0 }
    this.debug = { skipped: 0, missing: {} }
    this.presentedCount = 0
    this.renderTotal = 0
    this.statsWindowStart = performance.now()
    this.lastShownFrame = -1
    // Start decoding the first frames before the clock starts, so playback doesn't begin with a drop.
    if (rate > 0) {
      const starting: Array<Promise<void>> = []
      for (const layer of videoLayersAt(project.sequence, project.media, from)) {
        const path = layer.item.kind === 'image' ? null : this.path(layer.item)
        if (!path) continue
        const media = await openMedia(path).catch(() => null)
        if (!media?.videoSink) continue
        const stream = new VideoStream(media, ticksToSeconds(layer.sourceTime))
        this.streams.set(layer.clip.id, stream)
        starting.push(stream.ready(600))
      }
      await Promise.all(starting)
      if (!this.playing) return
    }
    if (rate === 1) {
      this.audio ??= new AudioEngine()
      await this.audio.start(project.sequence, project.media, from, (item) => this.path(item))
    }
    this.notify()
    cancelAnimationFrame(this.frameHandle)
    this.frameHandle = requestAnimationFrame(() => this.tick())
  }

  stop(): void {
    if (!this.playing) return
    const time = this.currentTime()
    this.playing = false
    cancelAnimationFrame(this.frameHandle)
    this.audio?.stop()
    this.stopStreams()
    this.notify()
    timelineController.setPlayhead(Math.max(0, time))
    this.requestStill()
  }

  toggle(): void {
    if (this.playing) this.stop()
    else void this.play(1)
  }

  /** L: play, then faster each press. J: reverse, faster each press. K: stop. */
  shuttle(direction: 1 | -1 | 0): void {
    if (direction === 0) return this.stop()
    let rate: number = direction
    if (this.playing && Math.sign(this.rate) === direction) rate = Math.min(8, Math.abs(this.rate) * 2) * direction
    void this.play(rate, this.playing ? this.currentTime() : timelineController.playhead)
  }

  private stopStreams(): void {
    for (const stream of this.streams.values()) stream.close()
    this.streams.clear()
  }

  private tick(): void {
    if (!this.playing) return
    const project = projectController.project
    if (!project || !this.compositor || !this.context) return
    const sequence = project.sequence
    const rate = frameRateOf(sequence.settings)
    const frame = ticksPerFrame(rate)
    const end = sequenceEnd(sequence)
    let time = this.currentTime()
    if ((this.rate > 0 && time >= end) || (this.rate < 0 && time <= 0)) {
      timelineController.setPlayhead(this.rate > 0 ? end : 0)
      this.stop()
      return
    }
    time = Math.max(0, time)
    const frameIndex = Math.floor(time / frame)
    this.frameHandle = requestAnimationFrame(() => this.tick())
    if (frameIndex === this.lastShownFrame) return
    const skipped = this.lastShownFrame >= 0 ? Math.max(0, (frameIndex - this.lastShownFrame) * Math.sign(this.rate) - 1) : 0
    if (Math.abs(this.rate) === 1 && skipped > 0) {
      this.stats.dropped += skipped
      this.debug.skipped += skipped
    }
    this.lastShownFrame = frameIndex
    const shown = frameIndex * frame

    const started = performance.now()
    const layers = videoLayersAt(sequence, project.media, shown)
    const wanted = new Set(layers.map((l) => l.clip.id))
    // Open decoders a moment early for clips about to start.
    if (this.rate > 0) {
      const soon = shown + secondsToTicks(0.6 * this.rate)
      for (const upcoming of videoLayersAt(sequence, project.media, soon)) wanted.add(upcoming.clip.id)
    }
    for (const [id, stream] of this.streams) {
      if (!wanted.has(id)) {
        stream.close()
        this.streams.delete(id)
      }
    }
    if (this.rate > 0) {
      for (const layer of videoLayersAt(sequence, project.media, shown + secondsToTicks(0.6 * this.rate))) this.ensureStream(layer, Math.max(layer.clip.start, shown))
    }

    const composite: CompositeLayer[] = []
    const frames: VideoFrame[] = []
    let missing = false
    for (const layer of layers) {
      const path = this.path(layer.item)
      if (!path) continue
      if (layer.item.kind === 'image') {
        const texture = this.stillTextures.get(path)
        if (texture) {
          const c = this.compositeLayer(layer, { kind: 'image', texture }, sequence)
          if (c) composite.push(c)
        } else void openStill(path).then((bitmap) => this.stillTexture(path, bitmap))
        continue
      }
      if (this.rate < 0) continue // reverse shows the still-render path below
      const stream = this.ensureStream(layer, shown)
      const sample = stream?.frameAt(ticksToSeconds(layer.sourceTime)) ?? null
      if (!sample) {
        missing = true
        this.debug.missing[layer.item.name] = (this.debug.missing[layer.item.name] ?? 0) + 1
        continue
      }
      const videoFrame = sample.toVideoFrame()
      frames.push(videoFrame)
      const c = this.compositeLayer(layer, { kind: 'video', frame: videoFrame }, sequence)
      if (c) composite.push(c)
    }
    if (this.rate < 0) {
      // Reverse: decode each frame directly (slower; frames are skipped as needed).
      timelineController.setPlayhead(shown, true)
      this.renderStillWhilePlaying()
      return
    }
    if (missing && Math.abs(this.rate) === 1) this.stats.dropped++
    const scale = this.prepareTarget(sequence)
    const result = this.compositor.render(composite, scale)
    this.compositor.present(result, this.context, this.format)
    frames.forEach((f) => f.close())
    this.probe?.(result, shown)

    const heard = this.rate === 1 && this.audio ? this.audio.heardTime() : shown
    this.recording?.push({ at: performance.now(), timeline: shown, heard })
    this.renderTotal += performance.now() - started
    this.presentedCount++
    const elapsed = performance.now() - this.statsWindowStart
    if (elapsed >= 500) {
      this.stats = {
        fps: (this.presentedCount * 1000) / elapsed,
        dropped: this.stats.dropped,
        renderMs: this.renderTotal / this.presentedCount,
        lagMs: ticksToSeconds(heard - shown) * 1000 - (1000 / frameRateValue(rate)) / 2
      }
      this.presentedCount = 0
      this.renderTotal = 0
      this.statsWindowStart = performance.now()
      this.notify()
    }
    timelineController.setPlayhead(shown, true)
  }

  private reverseBusy = false

  private renderStillWhilePlaying(): void {
    if (this.reverseBusy) return
    this.reverseBusy = true
    void this.renderStill(true).finally(() => {
      this.reverseBusy = false
    })
  }

  private ensureStream(layer: VideoLayer, at: Ticks): VideoStream | null {
    if (layer.item.kind === 'image') return null
    const existing = this.streams.get(layer.clip.id)
    if (existing) return existing
    const path = this.path(layer.item)
    if (!path) return null
    const startSeconds = ticksToSeconds(layer.clip.sourceIn + Math.max(0, at - layer.clip.start))
    // Open asynchronously; the slot is filled once the file is ready.
    const placeholder = { frameAt: () => null, close: () => undefined, late: 0 } as unknown as VideoStream
    this.streams.set(layer.clip.id, placeholder)
    void openMedia(path)
      .then((media) => {
        if (this.streams.get(layer.clip.id) !== placeholder) return
        this.streams.set(layer.clip.id, new VideoStream(media, startSeconds))
      })
      .catch((error: Error) => {
        this.message = `${layer.item.name}: ${error.message}`
        this.notify()
      })
    return placeholder
  }
}

export const player = new Player()
timelineController.transport = player

import { FORMATS, type ExportSettings } from '@engine/export/export-settings'
import type { MediaItem } from '@engine/project/media'
import { frameRateOf, type Clip, type Project } from '@engine/project/model'
import { ticksPerFrame, ticksToSeconds, type Ticks } from '@engine/time'
import { audioSegments, videoLayersAt } from '@engine/timeline/render-plan'
import { sequenceEnd } from '@engine/timeline/timeline'
import type { ExportResult } from '@shared/ipc'
import type { VideoSample } from 'mediabunny'
import { getGpu } from '../gpu/shared'
import { mediaController } from '../state/media-controller'
import { Observable } from '../state/observable'
import { renderMixdown } from './audio-mixdown'
import { Compositor, type CompositeLayer } from './compositor'
import { LayerBuilder } from './layers'
import { openMedia, openStill, type OpenedMedia } from './sources'
import { YuvConverter } from './yuv'

export type ExportState =
  | { kind: 'idle' }
  | { kind: 'running'; stage: 'checking' | 'sound' | 'frames' | 'finishing'; frame: number; frames: number; fps: number; started: number; output: string }
  | { kind: 'done'; result: ExportResult; seconds: number; fps: number }
  | { kind: 'failed'; error: string; output: string }
  | { kind: 'cancelled' }

/**
 * Frames for one clip, exactly, with no deadline. Forward clips decode in order;
 * reversed clips and holds fetch each frame they need.
 */
class ExactFrames {
  private iterator: AsyncGenerator<VideoSample, void, unknown> | null = null
  private current: VideoSample | null = null
  private peek: VideoSample | null | undefined = undefined
  private held: { seconds: number; sample: VideoSample } | null = null

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
    if (!this.iterator) {
      this.iterator = sink.samples(this.media.origin + Math.max(0, seconds))
      this.peek = undefined
    }
    if (this.peek === undefined) this.peek = (await this.iterator.next()).value ?? null
    while (this.peek && this.peek.timestamp <= due) {
      this.current?.close()
      this.current = this.peek
      this.peek = (await this.iterator.next()).value ?? null
    }
    // The first frame of the clip can sit just after the requested time (a stream's first timestamp).
    if (!this.current && this.peek) {
      this.current = this.peek
      this.peek = (await this.iterator.next()).value ?? null
    }
    return this.current
  }

  close(): void {
    void this.iterator?.return(undefined).catch(() => undefined)
    this.current?.close()
    if (this.peek) this.peek.close()
    this.held?.sample.close()
  }
}

class Exporter extends Observable {
  state: ExportState = { kind: 'idle' }
  private cancelRequested = false
  private jobId: string | null = null

  get running(): boolean {
    return this.state.kind === 'running'
  }

  private set(state: ExportState): void {
    this.state = state
    this.notify()
  }

  cancel(): void {
    if (this.running) this.cancelRequested = true
  }

  /** Exports the whole sequence of `project` (a snapshot: edits made meanwhile don't change it). */
  async run(project: Project, settings: ExportSettings, output: string): Promise<ExportResult | null> {
    if (this.running) throw new Error('An export is already running')
    this.cancelRequested = false
    const started = performance.now()
    const sequence = project.sequence
    const media = project.media
    const rate = frameRateOf(sequence.settings)
    const frame = ticksPerFrame(rate)
    const end = sequenceEnd(sequence)
    const frames = Math.ceil(end / frame)
    const { width, height } = sequence.settings
    const progress = (stage: 'checking' | 'sound' | 'frames' | 'finishing', done = 0) => {
      const seconds = (performance.now() - started) / 1000
      this.set({ kind: 'running', stage, frame: done, frames, fps: stage === 'frames' && seconds > 0 ? done / seconds : 0, started, output })
    }
    progress('checking')
    const sources = new Map<string, ExactFrames>()
    let compositor: Compositor | null = null
    let yuv: YuvConverter | null = null
    try {
      if (frames === 0) throw new Error('The timeline is empty')
      // Everything the export needs must be playable now.
      const used = new Set(sequence.clips.map((c) => c.mediaId))
      const items = media.filter((m) => used.has(m.id))
      for (const item of items) {
        if (!mediaController.playablePath(item)) throw new Error(`${item.name} isn't available: ${mediaController.get(item.id).status === 'offline' ? 'it is offline' : 'its optimised copy is still being made'}`)
      }
      const path = (item: MediaItem) => mediaController.playablePath(item)
      const { device } = await getGpu()
      compositor = new Compositor(device)
      compositor.resize(width, height)
      const layers = new LayerBuilder(compositor)
      for (const item of items) if (item.colour.lut) await layers.loadLut(item.colour.lut.file)

      progress('sound')
      const sampleRate = sequence.settings.sampleRate
      const samples = audioSegments(sequence, media, 0, end).length > 0 ? await renderMixdown(sequence, media, 0, end, sampleRate, path) : new Float32Array(Math.round(ticksToSeconds(end) * sampleRate) * 2)
      this.checkCancelled()
      const id = await window.ginosa.export.begin({ settings, width, height, rate, audioFrames: samples.length / 2, sampleRate, output })
      this.jobId = id
      const chunk = 1 << 20 // samples per message
      for (let at = 0; at < samples.length; at += chunk) {
        const piece = samples.slice(at, Math.min(samples.length, at + chunk))
        await window.ginosa.export.audio(id, new Uint8Array(piece.buffer))
      }
      await window.ginosa.export.startVideo(id)

      yuv = new YuvConverter(device, FORMATS[settings.format].pixelFormat, width, height)
      let lastNotify = 0
      for (let index = 0; index < frames; index++) {
        this.checkCancelled()
        const time: Ticks = index * frame
        const plan = videoLayersAt(sequence, media, time)
        const composite: CompositeLayer[] = []
        const videoFrames: VideoFrame[] = []
        for (const layer of plan) {
          const file = path(layer.item)!
          if (layer.item.kind === 'image') {
            const texture = layers.loadedStill(file) ?? layers.stillTexture(file, await openStill(file))
            const built = layers.build(layer, { kind: 'image', texture }, sequence)
            if (built) composite.push(built)
            continue
          }
          let source = sources.get(layer.clip.id)
          if (!source) {
            source = new ExactFrames(await openMedia(file), layer.clip)
            sources.set(layer.clip.id, source)
          }
          const sample = await source.frameAt(ticksToSeconds(layer.sourceTime))
          if (!sample) throw new Error(`${layer.item.name}: no picture at ${ticksToSeconds(layer.sourceTime).toFixed(2)} s`)
          const videoFrame = sample.toVideoFrame()
          videoFrames.push(videoFrame)
          const built = layers.build(layer, { kind: 'video', frame: videoFrame }, sequence)
          if (built) composite.push(built)
        }
        // Clips that have finished won't come back (time only moves forward).
        const present = new Set(plan.map((l) => l.clip.id))
        for (const [clipId, source] of sources) {
          if (!present.has(clipId)) {
            source.close()
            sources.delete(clipId)
          }
        }
        const result = compositor.render(composite, 1)
        const bytes = await yuv.convert(result, index)
        videoFrames.forEach((f) => f.close())
        await window.ginosa.export.frame(id, bytes)
        if (performance.now() - lastNotify > 100 || index === frames - 1) {
          lastNotify = performance.now()
          progress('frames', index + 1)
        }
      }
      progress('finishing', frames)
      const result = await window.ginosa.export.finish(id)
      this.jobId = null
      const seconds = (performance.now() - started) / 1000
      this.set({ kind: 'done', result, seconds, fps: frames / seconds })
      return result
    } catch (error) {
      if (this.jobId) await window.ginosa.export.cancel(this.jobId).catch(() => undefined)
      this.jobId = null
      if (error instanceof CancelledError) {
        this.set({ kind: 'cancelled' })
        return null
      }
      this.set({ kind: 'failed', error: (error as Error).message, output })
      return null
    } finally {
      for (const source of sources.values()) source.close()
      yuv?.destroy()
      compositor?.destroy()
    }
  }

  private checkCancelled(): void {
    if (this.cancelRequested) throw new CancelledError()
  }
}

class CancelledError extends Error {}

export const exporter = new Exporter()

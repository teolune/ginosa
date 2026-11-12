import { FORMATS, type ExportSettings } from '@engine/export/export-settings'
import { lookLutFiles } from '@engine/colour/look-lut'
import type { MediaItem } from '@engine/project/media'
import { frameRateOf, type Project } from '@engine/project/model'
import { ticksPerFrame, ticksToSeconds, type Ticks } from '@engine/time'
import { audioSegments } from '@engine/timeline/render-plan'
import { sequenceEnd } from '@engine/timeline/timeline'
import type { ExportResult } from '@shared/ipc'
import { getGpu } from '../gpu/shared'
import { mediaController } from '../state/media-controller'
import { Observable } from '../state/observable'
import { renderMixdown } from './audio-mixdown'
import { modulationController } from '../audio/modulation-controller'
import type { ModulationContext } from '@engine/modulation/types'
import { Compositor } from './compositor'
import { LayerBuilder } from './layers'
import { ExactRenderer } from './exact-render'
import { TemporalStore } from './temporal'
import { YuvConverter } from './yuv'

export type ExportState =
  | { kind: 'idle' }
  | { kind: 'running'; stage: 'checking' | 'sound' | 'frames' | 'finishing'; frame: number; frames: number; fps: number; started: number; output: string }
  | { kind: 'done'; result: ExportResult; seconds: number; fps: number }
  | { kind: 'failed'; error: string; output: string }
  | { kind: 'cancelled' }

class Exporter extends Observable {
  state: ExportState = { kind: 'idle' }
  private cancelRequested = false
  /** The modulation the last export rendered with (tests compare playback against it). */
  lastModulation: ModulationContext | null = null
  private jobId: string | null = null
  /** Most video memory the last export's stateful effects held, and in how many states (tests). */
  memory = { peakStateBytes: 0, peakStates: 0 }

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
    this.memory = { peakStateBytes: 0, peakStates: 0 }
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
    let renderer: ExactRenderer | null = null
    let temporal: TemporalStore | null = null
    let compositor: Compositor | null = null
    let yuv: YuvConverter | null = null
    let layers: LayerBuilder | null = null
    try {
      if (frames === 0) throw new Error('The timeline is empty')
      // Everything the export needs must be playable now.
      const used = new Set(sequence.clips.filter((c) => !c.adjustment).map((c) => c.mediaId))
      const items = media.filter((m) => used.has(m.id))
      for (const item of items) {
        if (!mediaController.playablePath(item)) throw new Error(`${item.name} isn't available: ${mediaController.get(item.id).status === 'offline' ? 'it is offline' : 'its optimised copy is still being made'}`)
      }
      const path = (item: MediaItem) => mediaController.playablePath(item)
      const { device } = await getGpu()
      compositor = new Compositor(device)
      compositor.resize(width, height)
      // Stateful effects run from their first frame, in order, so they're always exact here, and
      // each needs only the frame before: no checkpoints (they'd fill the 2 GB budget for nothing).
      temporal = new TemporalStore(device, Infinity)
      layers = new LayerBuilder(compositor, undefined, undefined, temporal)
      renderer = new ExactRenderer(compositor, layers, path)
      for (const item of items) if (item.colour.lut) await layers.loadLut(item.colour.lut.file)
      for (const file of lookLutFiles(sequence)) await layers.loadLookLut(file)

      progress('sound')
      const sampleRate = sequence.settings.sampleRate
      // Modulation from curves worked out once for this exact project, after its audio is analysed.
      const modulation = await modulationController.snapshot(project)
      this.lastModulation = modulation
      const samples = audioSegments(sequence, media, 0, end).length > 0 ? await renderMixdown(sequence, media, 0, end, sampleRate, path, modulation) : new Float32Array(Math.round(ticksToSeconds(end) * sampleRate) * 2)
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
        const result = await renderer.render(sequence, media, time, this.lastModulation, 1)
        const bytes = await yuv.convert(result, index)
        this.memory.peakStateBytes = Math.max(this.memory.peakStateBytes, temporal.bytes())
        this.memory.peakStates = Math.max(this.memory.peakStates, temporal.states())
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
      renderer?.close()
      temporal?.clear()
      layers?.destroy()
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

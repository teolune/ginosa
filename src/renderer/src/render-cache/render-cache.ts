import { hashText } from '@engine/audio/sources'
import { lookLutFiles } from '@engine/colour/look-lut'
import { FrameKeyJob } from '@engine/render/frame-keys'
import type { MediaItem } from '@engine/project/media'
import type { Sequence } from '@engine/project/model'
import type { ModulationContext } from '@engine/modulation/types'
import { videoLayersAt } from '@engine/timeline/render-plan'
import { checkpointEvery } from '@engine/timeline/temporal'
import { frameTicks } from '@engine/timeline/timeline'
import { markedRange } from '@engine/timeline/sequence-marks'
import { modulationController } from '../audio/modulation-controller'
import { getGpu } from '../gpu/shared'
import { readTexture } from '../gpu/readback'
import blendSource from '../playback/blend.wgsl?raw'
import compositeSource from '../playback/composite.wgsl?raw'
import maskSource from '../playback/mask.wgsl?raw'
import { Compositor } from '../playback/compositor'
import { effectShaderSource } from '../playback/effect-shader'
import { ExactRenderer } from '../playback/exact-render'
import { LayerBuilder } from '../playback/layers'
import { TemporalStore } from '../playback/temporal'
import { mediaController } from '../state/media-controller'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'

/**
 * The render cache (M9): preview renders on disk, one JPEG per frame, named by the frame's
 * key (everything that decides how it looks; frame-keys.ts), so an edit invalidates exactly
 * the frames it changes. Enter renders the frames with effects that aren't cached yet;
 * playback and the paused frame show cached frames instead of rendering them. The render
 * bar shows each frame: nothing (plain), yellow (effects, rendered live: may drop) or
 * green (cached).
 */

/** JPEG quality of preview files: 8-bit, about 0.4 MB a 1080p frame. */
export const PREVIEW_QUALITY = 0.92

/** Everything the compositor's own code adds to a frame's look: a change to it invalidates every preview. */
export const RENDERER_VERSION = hashText([blendSource, compositeSource, maskSource, effectShaderSource.toString(), `jpeg ${PREVIEW_QUALITY}`].join('\n'))

/** What a set of keys was worked out for: exactly this sequence, media and modulation. */
interface Basis {
  sequence: Sequence
  media: MediaItem[]
  modulation: string
}

export type RenderStatus = 0 | 1 | 2

export interface RenderProgress {
  done: number
  total: number
  /** Frames rendered unseen first, for stateful effects to catch up. */
  catchingUp: number
  started: number
}

class RenderCacheController extends Observable {
  private projectId: string | null = null
  /** Keys with a preview on disk (this project). */
  cached = new Set<string>()
  private job: { basis: Basis; job: FrameKeyJob } | null = null
  /** The latest complete keys, and what they're for. */
  private ready: { basis: Basis; keys: string[]; effects: Uint8Array } | null = null
  /** Per frame: 0 plain, 1 effects (yellow), 2 cached (green). */
  status: Uint8Array | null = null
  rendering: RenderProgress | null = null
  /** The last render: frames written, their size, frames caught up first, how long, its error if any. */
  last: { frames: number; bytes: number; catchUp: number; ms: number; error: string | null } | null = null
  private cancelRequested = false
  private timer: number | null = null

  constructor() {
    super()
    const schedule = () => this.schedule()
    projectController.subscribe(schedule)
    modulationController.subscribe(schedule)
  }

  private basisNow(): Basis | null {
    const project = projectController.project
    if (!project) return null
    return { sequence: project.sequence, media: project.media, modulation: modulationController.context.id ?? 'none' }
  }

  private same(a: Basis | null | undefined, b: Basis | null | undefined): boolean {
    return !!a && !!b && a.sequence === b.sequence && a.media === b.media && a.modulation === b.modulation
  }

  private schedule(): void {
    const project = projectController.project
    if ((project?.id ?? null) !== this.projectId) {
      this.projectId = project?.id ?? null
      this.cached = new Set()
      this.ready = null
      this.status = null
      if (project) void window.ginosa.renders.list(project.id).then((keys) => {
        if (projectController.project?.id !== project.id) return
        for (const key of keys) this.cached.add(key)
        this.updateStatus()
      }, () => undefined)
    }
    // Once edits pause (not during a drag: every frame's key is worked out again after each change).
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.start()
    }, 300)
  }

  /** Starts working out keys for the project as it is now (sliced, so the interface stays quick). */
  private start(): void {
    const basis = this.basisNow()
    if (!basis || this.same(basis, this.ready?.basis) || this.same(basis, this.job?.basis)) return
    const job = { basis, job: new FrameKeyJob(basis.sequence, basis.media, modulationController.context, RENDERER_VERSION) }
    this.job = job
    const slice = () => {
      if (this.job !== job) return
      if (!job.job.step(240)) {
        window.setTimeout(slice, 0)
        return
      }
      this.job = null
      this.ready = { basis, keys: job.job.keys, effects: job.job.effects }
      this.updateStatus()
    }
    slice()
  }

  private updateStatus(): void {
    const ready = this.ready
    if (!ready) return
    const status = new Uint8Array(ready.keys.length)
    for (let j = 0; j < status.length; j++) status[j] = this.cached.has(ready.keys[j]!) ? 2 : ready.effects[j]! ? 1 : 0
    this.status = status
    this.notify()
  }

  /** Waits until the keys match the project as it is now. */
  async settle(): Promise<void> {
    for (;;) {
      if (this.same(this.basisNow(), this.ready?.basis)) return
      if (this.timer === null && !this.job) this.start()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /** The key of frame `index`, if the keys were worked out for exactly this sequence, media and modulation. */
  keyFor(sequence: Sequence, media: MediaItem[], modulation: ModulationContext | null, index: number): string | null {
    const ready = this.ready
    if (!ready || ready.basis.sequence !== sequence || ready.basis.media !== media || ready.basis.modulation !== (modulation?.id ?? 'none')) return null
    return ready.keys[index] ?? null
  }

  /** A cached frame's picture, or null. */
  async bitmap(key: string): Promise<ImageBitmap | null> {
    const projectId = this.projectId
    if (!projectId || !this.cached.has(key)) return null
    const data = await window.ginosa.renders.read(projectId, key)
    if (!data) {
      // Gone from disk (cleared, or let go of for the size limit).
      this.cached.delete(key)
      this.updateStatus()
      return null
    }
    return createImageBitmap(new Blob([data], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  }

  cancel(): void {
    if (this.rendering) this.cancelRequested = true
  }

  /** Previews deleted elsewhere (the size limit): no longer cached. */
  forget(evicted: ReadonlyArray<{ projectId: string; key: string }>): void {
    for (const e of evicted) if (e.projectId === this.projectId) this.cached.delete(e.key)
    this.updateStatus()
  }

  /** The cache was cleared: read what's on disk again. */
  reload(): void {
    const projectId = this.projectId
    this.cached = new Set()
    this.updateStatus()
    if (projectId) void window.ginosa.renders.list(projectId).then((keys) => {
      if (this.projectId !== projectId) return
      for (const key of keys) this.cached.add(key)
      this.updateStatus()
    }, () => undefined)
  }

  /**
   * Enter: renders every frame with effects that isn't cached, between In and Out if
   * either is set, otherwise within the selected clips' span (or the whole sequence), in
   * order. Stateful effects catch up from their reset or a checkpoint first, unseen.
   * Returns how many frames were written.
   */
  async renderSection(clipIds: readonly string[] = [...timelineController.selection], span: { from: number; to: number } | null = null): Promise<number> {
    if (this.rendering) return 0
    const project = projectController.project
    if (!project) return 0
    await this.settle()
    const ready = this.ready!
    const sequence = ready.basis.sequence
    const media = ready.basis.media
    const modulation = modulationController.context
    const frame = frameTicks(sequence)
    span ??= markedRange(sequence)
    const selected = sequence.clips.filter((c) => clipIds.includes(c.id))
    const from = span ? Math.floor(span.from / frame) : selected.length ? Math.floor(Math.min(...selected.map((c) => c.start)) / frame) : 0
    const to = span ? Math.ceil(span.to / frame) : selected.length ? Math.ceil(Math.max(...selected.map((c) => c.start + c.duration)) / frame) : ready.keys.length
    const todo: number[] = []
    for (let j = Math.max(0, from); j < Math.min(to, ready.keys.length); j++) if (ready.effects[j] && !this.cached.has(ready.keys[j]!)) todo.push(j)
    if (todo.length === 0) {
      projectController.showMessage(ready.effects.some((e) => e) ? 'Everything with effects there is already rendered.' : 'Nothing there needs rendering: no frame has effects.')
      return 0
    }
    const used = new Set(sequence.clips.filter((c) => !c.adjustment).map((c) => c.mediaId))
    for (const item of media.filter((m) => used.has(m.id))) {
      if (!mediaController.playablePath(item)) {
        projectController.showMessage(`Can't render: ${item.name} isn't available`)
        return 0
      }
    }
    const { device } = await getGpu()
    const { width, height } = sequence.settings
    const compositor = new Compositor(device)
    compositor.resize(width, height)
    const temporal = new TemporalStore(device, checkpointEvery(sequence))
    const layers = new LayerBuilder(compositor, undefined, undefined, temporal)
    const renderer = new ExactRenderer(compositor, layers, (item) => mediaController.playablePath(item))
    const target = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    this.cancelRequested = false
    this.rendering = { done: 0, total: todo.length, catchingUp: 0, started: performance.now() }
    this.notify()
    let written = 0
    let bytes = 0
    let error: string | null = null
    let lastNotify = 0
    try {
      for (const item of media) if (item.colour.lut && used.has(item.id)) await layers.loadLut(item.colour.lut.file)
      for (const file of lookLutFiles(sequence)) await layers.loadLookLut(file)
      let previous = -2
      for (const j of todo) {
        if (this.cancelRequested) break
        if (j !== previous + 1) {
          // A new stretch: stateful effects catch up to its first frame, unseen.
          const start = temporal.catchUpFrom(videoLayersAt(sequence, media, j * frame, modulation), frame)
          if (start !== null) {
            for (let t = start; t < j * frame - frame / 2; t += frame) {
              if (this.cancelRequested) break
              await renderer.render(sequence, media, t, modulation, 1, true)
              this.rendering.catchingUp++
            }
          }
        }
        previous = j
        const result = await renderer.render(sequence, media, j * frame, modulation, 1)
        compositor.copy(result, target)
        const pixels = await readTexture(device, target)
        ctx.putImageData(new ImageData(pixels.rgba, width, height), 0, 0)
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: PREVIEW_QUALITY })
        const key = ready.keys[j]!
        const data = await blob.arrayBuffer()
        bytes += data.byteLength
        const evicted = await window.ginosa.renders.write(project.id, key, data)
        this.cached.add(key)
        for (const e of evicted) if (e.projectId === project.id) this.cached.delete(e.key)
        written++
        this.rendering.done = written
        if (performance.now() - lastNotify > 150) {
          lastNotify = performance.now()
          this.updateStatus()
        }
      }
    } catch (e) {
      error = (e as Error).message
      projectController.showMessage(`Rendering stopped: ${error}`)
    } finally {
      renderer.close()
      temporal.clear()
      target.destroy()
      compositor.destroy()
    }
    this.last = { frames: written, bytes, catchUp: this.rendering.catchingUp, ms: performance.now() - this.rendering.started, error }
    this.rendering = null
    this.updateStatus()
    return written
  }
}

export const renderCache = new RenderCacheController()
timelineController.previews = renderCache

import type { ModulationContext } from '@engine/modulation/types'
import { modulationController } from '../audio/modulation-controller'
import type { MediaItem } from '@engine/project/media'
import type { Sequence } from '@engine/project/model'
import { frameRateOf } from '@engine/project/model'
import { frameRateValue, secondsToTicks, ticksPerFrame, ticksToSeconds, type Ticks } from '@engine/time'
import { sourceTimeAt, videoLayersAt, visibleFrom, type VideoLayer } from '@engine/timeline/render-plan'
import { mediaLength, sequenceEnd } from '@engine/timeline/timeline'
import type { VideoSample } from 'mediabunny'
import { getGpu } from '../gpu/shared'
import { mediaController } from '../state/media-controller'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { AudioEngine } from './audio-engine'
import { Compositor, warmEffectPipelines, type CompositeLayer, type CompositeStep } from './compositor'
import { EFFECTS } from '../../../effects/registry'
import { LayerBuilder } from './layers'
import { openMedia, openStill, type OpenedMedia } from './sources'
import { HoldStream, ReverseStream, VideoStream, type FrameSource } from './video-stream'
import { TemporalStore } from './temporal'
import { ExactFrames, ExactRenderer } from './exact-render'
import { checkpointEvery } from '@engine/timeline/temporal'
import { renderCache } from '../render-cache/render-cache'

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
  /** Frames shown from the render cache (M9) since playback started. */
  cached: number
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
 * Where a player's picture comes from: the Program monitor plays the timeline; the
 * Source Monitor plays one media file as a sequence of its own (source-sequence.ts).
 */
export interface PlayerHost {
  /** What to play, or null. `preview` includes a timeline drag in progress (for the paused frame). */
  scene(preview: boolean): { sequence: Sequence; media: MediaItem[] } | null
  /** Where the paused frame is. */
  readonly playhead: Ticks
  setPlayhead(time: Ticks): void
  /** Called whenever the scene or the playhead changes. */
  subscribe(listener: () => void): () => void
  /** Modulators' outputs for this scene (the Program monitor's timeline), or null. */
  modulation?(): ModulationContext | null
}

/** Catching up more than this many frames shows a preview first (see renderStill). */
const PREVIEW_AFTER_FRAMES = 3
/** How long edits and scrubbing must pause before the exact frame is worked out (ms). */
const EXACT_AFTER_MS = 250
/** Catching up, the GPU is let finish every this many frames (about 30 ms of work with a heavy stack). */
const CATCH_UP_BATCH = 3

/**
 * Timeline playback: Web Audio is the master clock; every display refresh the
 * player asks which time is being heard and composites the frames for it. Paused,
 * it renders the frame under the playhead with the same compositor.
 */
export class Player extends Observable {
  /** Every player, so starting one stops the others (as Premiere's two monitors do). */
  private static all = new Set<Player>()
  private static warming = false
  /** The background compile of every effect's shaders, once done (the performance test reads it). */
  static warmed: { pipelines: number; ms: number } | null = null

  playing = false
  /** 1 = normal; 2, 4, 8 fast forward; negative = reverse (J). Sound plays at 1× only. */
  rate = 1
  resolution: PlaybackResolution = 1
  showStats = false
  stats: PlaybackStats = { fps: 0, dropped: 0, renderMs: 0, lagMs: 0, cached: 0 }
  message: string | null = null

  audio: AudioEngine | null = null
  /** Where the last Play started: Stop goes back there, and a second Stop to the start (Control Panel). */
  playOrigin: Ticks | null = null
  private originPending = false
  /** Metronome clicks on the beat grid while playing (Control Panel). */
  metronome = false
  private compositor: Compositor | null = null
  private device: GPUDevice | null = null
  private canvas: HTMLCanvasElement | null = null
  private context: GPUCanvasContext | null = null
  private format: GPUTextureFormat = 'bgra8unorm'
  private streams = new Map<string, FrameSource>()
  private layers: LayerBuilder | null = null
  /** Stateful effects' state between frames, and the renderer that catches it up after a jump. */
  temporal: TemporalStore | null = null
  /** Renders the frames before a paused frame, exactly (public for the performance test's numbers). */
  catchUp: ExactRenderer | null = null
  /**
   * Decoders for paused frames, one per clip (and file, speed and direction): stepping or
   * scrubbing forward decodes on from the frame before instead of seeking from the last
   * keyframe each time (long-GOP footage such as iPhone HEVC has one every second or so).
   */
  private stillFrames = new Map<string, ExactFrames>()
  private sequenceId: string | null = null
  /** The last catch-up before a still: how many frames it rendered, and how long it took. */
  lastCatchUp: { frames: number; ms: number } | null = null
  private frameHandle = 0
  private wallStart = 0
  private startTime: Ticks = 0
  private lastShownFrame = -1
  private presentedCount = 0
  private statsWindowStart = 0
  private renderTotal = 0
  private stillRender: { busy: boolean; again: boolean } = { busy: false, again: false }
  /** The paused frame after an edit or a jump is first a preview; the exact one follows when things pause. */
  private exactTimer: ReturnType<typeof setTimeout> | null = null
  private exactNext = false
  /** Whether the paused frame showing is a preview (stateful effects not yet caught up exactly). */
  approximate = false
  /** What the paused frame was last asked for: a change that alters none of it (a selection, a tool) doesn't redraw it. */
  private shownScene: { sequence: Sequence; media: unknown; playhead: Ticks; modulation: unknown } | null = null
  private sequenceAtStart: Sequence | null = null
  recording: PresentedFrame[] | null = null
  /** The last paused-frame composite (for tests that read pixels back). */
  lastStill: GPUTexture | null = null
  /** Paused frames rendered so far, and when the last was shown (the performance tests read them). */
  stillCount = 0
  lastStillAt = 0
  /** Whether it came from the render cache. */
  lastStillCached = false
  /** Cached previews decoded ahead of playback, by frame number. */
  private previews = new Map<number, { key: string; bitmap: ImageBitmap | null | undefined }>()
  /** Why frames were counted as dropped (for diagnosis). */
  debug = { skipped: 0, missing: {} as Record<string, number> }
  /** Test hook: called with each composited frame during playback. */
  probe: ((result: GPUTexture, timeline: Ticks) => void) | null = null

  constructor(private readonly host: PlayerHost) {
    super()
    Player.all.add(this)
    host.subscribe(() => this.onSceneChange())
  }

  // ---- Screen ----------------------------------------------------------------------

  async attach(canvas: HTMLCanvasElement): Promise<void> {
    const gpu = await getGpu()
    this.device = gpu.device
    if (!this.compositor) {
      this.compositor = new Compositor(gpu.device)
      this.temporal = new TemporalStore(gpu.device)
      this.layers = new LayerBuilder(
        this.compositor,
        () => this.requestStill(),
        (message) => {
          this.message = message
          this.notify()
        },
        this.temporal
      )
      this.catchUp = new ExactRenderer(this.compositor, this.layers, (item) => this.path(item))
      // Every effect's shaders compiled in the background once the first frame is up, so adding one is instant.
      if (!Player.warming) {
        Player.warming = true
        setTimeout(() => {
          const started = performance.now()
          void warmEffectPipelines(gpu.device, EFFECTS).then((count) => (Player.warmed = { pipelines: count, ms: Math.round(performance.now() - started) }))
        }, 1000)
      }
    }
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
    if (this.temporal) {
      // Another sequence (or project): its states are no use here.
      if (this.sequenceId !== sequence.id) this.temporal.clear()
      this.sequenceId = sequence.id
      this.temporal.scale = scale
      this.temporal.checkpointEvery = checkpointEvery(sequence)
    }
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

  /**
   * Stateful effects need their exact state from the frame before `time`: if it isn't
   * kept, the frames from the nearest checkpoint (or their reset) are rendered first,
   * unseen. Returns false if a newer request came in meanwhile (what was rendered so far
   * is kept, so the next try starts from there).
   */
  private async catchUpTo(sequence: Sequence, media: MediaItem[], time: Ticks, layers: VideoLayer[], interruptible: boolean): Promise<boolean> {
    if (!this.temporal || !this.catchUp) return true
    const frame = ticksPerFrame(frameRateOf(sequence.settings))
    const scale = this.prepareTarget(sequence)
    this.temporal.mode = 'exact'
    const from = this.temporal.catchUpFrom(layers, frame)
    if (from === null || from >= time) {
      this.lastCatchUp = { frames: 0, ms: 0 }
      return true
    }
    const total = Math.round((time - from) / frame)
    const started = performance.now()
    const modulation = this.host.modulation?.() ?? null
    let done = 0
    let lastNote = 0
    try {
      for (let t = from; t < time - frame / 2; t += frame) {
        if (interruptible && this.stillRender.again) return false
        await this.catchUp.render(sequence, media, t, modulation, scale, true)
        done++
        // A few frames at a time on the GPU, so the interface's own frames get drawn in between.
        if (interruptible && done % CATCH_UP_BATCH === 0) await this.device?.queue.onSubmittedWorkDone()
        if (total > 10 && performance.now() - lastNote > 250) {
          lastNote = performance.now()
          this.message = `Stateful effects: catching up ${done} of ${total} frames…`
          this.notify()
        }
      }
    } catch (error) {
      this.message = `Couldn't catch up: ${(error as Error).message}`
      this.notify()
      return true
    }
    // Timed to the end of the GPU work, not just its recording.
    await this.device?.queue.onSubmittedWorkDone()
    this.lastCatchUp = { frames: done, ms: performance.now() - started }
    if (total > 10) {
      this.message = null
      this.notify()
    }
    return true
  }

  /** Resolves once the paused frame has been rendered exactly (and nothing more is waiting). */
  async settled(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    while (this.stillRender.busy || this.stillRender.again || this.exactTimer !== null) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  /** The exact paused frame, once edits and scrubbing have paused for a moment. */
  private scheduleExact(): void {
    if (this.exactTimer !== null) clearTimeout(this.exactTimer)
    this.exactTimer = setTimeout(() => {
      this.exactTimer = null
      if (this.playing) return
      this.exactNext = true
      this.requestStill()
    }, EXACT_AFTER_MS)
  }

  private async renderStill(duringPlayback = false): Promise<void> {
    this.stillCount++
    const project = this.host.scene(true)
    if (!project || !this.compositor || !this.context) return
    const sequence = project.sequence
    const time = this.host.playhead
    const layers = videoLayersAt(sequence, project.media, time, this.host.modulation?.() ?? null)
    // A cached preview of this frame (M9) is shown as it is.
    const key = renderCache.keyFor(sequence, project.media, this.host.modulation?.() ?? null, Math.floor(time / ticksPerFrame(frameRateOf(sequence.settings)) + 1e-6))
    if (key && renderCache.cached.has(key)) {
      const bitmap = await renderCache.bitmap(key)
      if (bitmap) {
        if (this.playing && !duringPlayback) return bitmap.close()
        this.prepareTarget(sequence)
        const texture = this.compositor.previewTexture(bitmap)
        bitmap.close()
        this.compositor.present(texture, this.context, this.format)
        this.lastStill = texture
        this.lastStillCached = true
        return
      }
    }
    this.lastStillCached = false
    // Stateful effects need the exact state from the frame before. When that means catching up
    // more than a few frames (after an edit beneath them, or a jump), the frame is shown at once
    // from the nearest state there is (a preview), and exactly once you pause for a moment.
    let preview = false
    const exact = this.exactNext || duringPlayback
    this.exactNext = false
    if (layers.some((l) => l.temporal) && this.temporal) {
      const frame = ticksPerFrame(frameRateOf(sequence.settings))
      const from = this.temporal.catchUpFrom(layers, frame)
      if (!exact && from !== null && (time - from) / frame > PREVIEW_AFTER_FRAMES) {
        preview = true
        this.scheduleExact()
      } else if (!(await this.catchUpTo(sequence, project.media, time, layers, !duringPlayback))) return
    }
    const used = new Set<string>()
    const prepared: Array<{ layer: VideoLayer; source: CompositeLayer['source'] | null }> = []
    let message: string | null = null
    for (const layer of layers) {
      if (!layer.item) {
        prepared.push({ layer, source: null })
        continue
      }
      const path = this.path(layer.item)
      if (!path) {
        message = mediaController.get(layer.item.id).status === 'offline' ? `${layer.item.name} is offline` : `${layer.item.name}: optimised copy in progress`
        continue
      }
      try {
        if (layer.item.kind === 'image') {
          prepared.push({ layer, source: { kind: 'image', texture: this.layers!.stillTexture(path, await openStill(path)) } })
        } else {
          const key = `${layer.clip.id}:${path}:${layer.clip.speed === 0}:${layer.clip.reverse}`
          let frames = this.stillFrames.get(key)
          if (!frames) {
            frames = new ExactFrames(await openMedia(path), layer.clip)
            this.stillFrames.set(key, frames)
          }
          used.add(key)
          // The decoder keeps its sample; only the frame made from it is closed after drawing.
          const sample = await frames.frameAt(ticksToSeconds(layer.sourceTime))
          prepared.push({ layer, source: sample ? { kind: 'video', frame: sample.toVideoFrame() } : null })
        }
      } catch (error) {
        message = `${layer.item.name}: ${(error as Error).message}`
      }
    }
    if (this.playing && !duringPlayback) {
      for (const p of prepared) if (p.source?.kind === 'video') p.source.frame.close()
      return
    }
    const scale = this.prepareTarget(sequence)
    if (this.temporal) this.temporal.mode = preview ? 'preview' : 'exact'
    this.approximate = preview
    const composite = prepared.flatMap((p): CompositeStep[] => {
      if (!p.layer.item) return [this.layers!.adjustment(p.layer)]
      const layer = p.source ? this.layers!.build(p.layer, p.source, sequence) : null
      return layer ? [layer] : []
    })
    const result = this.compositor.render(composite, scale)
    this.compositor.present(result, this.context, this.format)
    this.lastStill = result
    this.lastStillAt = performance.now()
    for (const p of prepared) if (p.source?.kind === 'video') p.source.frame.close()
    // Decoders for clips no longer under the playhead are let go of.
    for (const [key, frames] of this.stillFrames) {
      if (used.has(key)) continue
      frames.close()
      this.stillFrames.delete(key)
    }
    if (message !== this.message) {
      this.message = message
      this.notify()
    }
  }

  private onSceneChange(): void {
    const project = this.host.scene(false)
    if (!project) {
      this.stop()
      return
    }
    if (this.playing) {
      if (!this.sequenceAtStart || project.sequence === this.sequenceAtStart) return
      // The edit changed while playing: carry on from here with the new edit.
      const time = this.currentTime()
      if (project.sequence.tracks !== this.sequenceAtStart.tracks && project.sequence.clips === this.sequenceAtStart.clips) {
        this.audio?.updateTracks(project.sequence)
        this.sequenceAtStart = project.sequence
      } else void this.play(this.rate, time)
      return
    }
    // Nothing in the picture changed (a selection, the tool, a window): it isn't drawn again.
    const preview = this.host.scene(true)
    const scene = { sequence: preview?.sequence ?? project.sequence, media: project.media, playhead: this.host.playhead, modulation: this.host.modulation?.() ?? null }
    const last = this.shownScene
    if (last && last.sequence === scene.sequence && last.media === scene.media && last.playhead === scene.playhead && last.modulation === scene.modulation) return
    this.shownScene = scene
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

  async play(rate = 1, from: Ticks = this.host.playhead): Promise<void> {
    const project = this.host.scene(false)
    if (!project || !this.compositor) {
      this.originPending = false
      return
    }
    for (const other of Player.all) if (other !== this) other.stop()
    this.stopStreams()
    this.audio?.stop()
    const end = sequenceEnd(project.sequence)
    if (rate > 0 && from >= end - ticksPerFrame(frameRateOf(project.sequence.settings))) from = 0
    if (this.originPending) {
      this.playOrigin = from
      this.originPending = false
    }
    this.playing = true
    this.rate = rate
    this.startTime = from
    this.lastClock = from
    this.wallStart = performance.now()
    this.sequenceAtStart = project.sequence
    this.stats = { fps: 0, dropped: 0, renderMs: 0, lagMs: 0, cached: 0 }
    this.debug = { skipped: 0, missing: {} }
    this.presentedCount = 0
    this.renderTotal = 0
    this.statsWindowStart = performance.now()
    this.lastShownFrame = -1
    // Stateful effects start from their exact state at the first frame.
    const first = videoLayersAt(project.sequence, project.media, from, this.host.modulation?.() ?? null)
    if (rate > 0 && first.some((l) => l.temporal)) {
      await this.catchUpTo(project.sequence, project.media, Math.floor(from / ticksPerFrame(frameRateOf(project.sequence.settings))) * ticksPerFrame(frameRateOf(project.sequence.settings)), first, false)
      if (!this.playing) return
    }
    if (this.temporal) this.temporal.mode = 'live'
    // Start decoding the first frames before the clock starts, so playback doesn't begin with a drop.
    if (rate > 0) {
      const starting: Array<Promise<void>> = []
      for (const layer of videoLayersAt(project.sequence, project.media, from, this.host.modulation?.() ?? null)) {
        const path = !layer.item || layer.item.kind === 'image' ? null : this.path(layer.item)
        if (!path) continue
        const media = await openMedia(path).catch(() => null)
        if (!media?.videoSink) continue
        const stream = this.openStream(media, layer, from, project.sequence)
        this.streams.set(layer.clip.id, stream)
        starting.push(stream.ready(600))
      }
      await Promise.all(starting)
      if (!this.playing) return
    }
    if (rate === 1) {
      this.audio ??= new AudioEngine()
      this.audio.modulation = this.host.modulation?.() ?? null
      this.audio.metronome = this.metronome
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
    if (this.temporal) this.temporal.mode = 'exact'
    cancelAnimationFrame(this.frameHandle)
    this.audio?.stop()
    this.stopStreams()
    this.notify()
    this.host.setPlayhead(Math.max(0, time))
    this.requestStill()
  }

  /** Play/Pause: pausing leaves the playhead where it is; playing again starts from there. */
  toggle(): void {
    if (this.playing) this.stop()
    else {
      this.originPending = true
      void this.play(1)
    }
  }

  /**
   * Stop (Control Panel): back to where Play started. Pressed again, or with nowhere to go
   * back to, it goes to the start.
   */
  stopAndReturn(): void {
    const origin = this.playOrigin
    const wasPlaying = this.playing
    this.stop()
    if (origin !== null && (wasPlaying || this.host.playhead !== origin)) this.host.setPlayhead(origin)
    else this.host.setPlayhead(0)
    this.notify()
  }

  setMetronome(on: boolean): void {
    this.metronome = on
    if (this.audio) this.audio.metronome = on
    this.notify()
  }

  /** L: play, then faster each press. J: reverse, faster each press. K: stop. */
  shuttle(direction: 1 | -1 | 0): void {
    if (direction === 0) return this.stop()
    let rate: number = direction
    if (this.playing && Math.sign(this.rate) === direction) rate = Math.min(8, Math.abs(this.rate) * 2) * direction
    void this.play(rate, this.playing ? this.currentTime() : this.host.playhead)
  }

  private stopStreams(): void {
    for (const stream of this.streams.values()) stream.close()
    this.streams.clear()
    for (const entry of this.previews.values()) entry.bitmap?.close()
    this.previews.clear()
  }

  private tick(): void {
    if (!this.playing) return
    const project = this.host.scene(false)
    if (!project || !this.compositor || !this.context) return
    const sequence = project.sequence
    const rate = frameRateOf(sequence.settings)
    const frame = ticksPerFrame(rate)
    const end = sequenceEnd(sequence)
    let time = this.currentTime()
    if ((this.rate > 0 && time >= end) || (this.rate < 0 && time <= 0)) {
      this.host.setPlayhead(this.rate > 0 ? end : 0)
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
    const layers = videoLayersAt(sequence, project.media, shown, this.host.modulation?.() ?? null)
    const wanted = new Set(layers.map((l) => l.clip.id))
    // Open decoders a moment early for clips about to start.
    if (this.rate > 0) {
      const soon = shown + secondsToTicks(0.6 * this.rate)
      for (const upcoming of videoLayersAt(sequence, project.media, soon, this.host.modulation?.() ?? null)) wanted.add(upcoming.clip.id)
    }
    for (const [id, stream] of this.streams) {
      if (!wanted.has(id)) {
        stream.close()
        this.streams.delete(id)
      }
    }
    if (this.rate > 0) {
      for (const layer of videoLayersAt(sequence, project.media, shown + secondsToTicks(0.6 * this.rate), this.host.modulation?.() ?? null)) this.ensureStream(layer, Math.max(visibleFrom(sequence, layer.clip), shown), sequence)
    }

    // A cached preview of this frame (M9), decoded ahead, is shown instead of rendering it.
    const modulation = this.host.modulation?.() ?? null
    const key = this.rate > 0 ? renderCache.keyFor(sequence, project.media, modulation, frameIndex) : null
    const ahead = key ? this.previews.get(frameIndex) : undefined
    const preview = ahead && ahead.key === key && ahead.bitmap ? ahead.bitmap : null
    if (this.rate > 0) this.prefetchPreviews(sequence, project.media, modulation, frameIndex)

    const composite: CompositeStep[] = []
    const frames: VideoFrame[] = []
    let missing = false
    for (const layer of layers) {
      if (preview) {
        // Decoders still keep up, so playback carries on smoothly past the cached stretch.
        if (layer.item && layer.item.kind !== 'image') this.ensureStream(layer, shown, sequence)?.frameAt(ticksToSeconds(layer.sourceTime))
        continue
      }
      if (!layer.item) {
        composite.push(this.layers!.adjustment(layer))
        continue
      }
      const item = layer.item
      const path = this.path(item)
      if (!path) continue
      if (item.kind === 'image') {
        const texture = this.layers!.loadedStill(path)
        if (texture) {
          const c = this.layers!.build(layer, { kind: 'image', texture }, sequence)
          if (c) composite.push(c)
        } else void openStill(path).then((bitmap) => this.layers!.stillTexture(path, bitmap))
        continue
      }
      if (this.rate < 0) continue // reverse shows the still-render path below
      const stream = this.ensureStream(layer, shown, sequence)
      const sample = stream?.frameAt(ticksToSeconds(layer.sourceTime)) ?? null
      if (!sample) {
        missing = true
        this.debug.missing[item.name] = (this.debug.missing[item.name] ?? 0) + 1
        continue
      }
      const videoFrame = sample.toVideoFrame()
      frames.push(videoFrame)
      const c = this.layers!.build(layer, { kind: 'video', frame: videoFrame }, sequence)
      if (c) composite.push(c)
    }
    if (this.rate < 0) {
      // Reverse: decode each frame directly (slower; frames are skipped as needed).
      this.host.setPlayhead(shown)
      this.renderStillWhilePlaying()
      return
    }
    if (missing && Math.abs(this.rate) === 1) this.stats.dropped++
    const scale = this.prepareTarget(sequence)
    let result: GPUTexture
    if (preview) {
      result = this.compositor.previewTexture(preview)
      this.stats.cached++
    } else result = this.compositor.render(composite, scale)
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
        lagMs: ticksToSeconds(heard - shown) * 1000 - (1000 / frameRateValue(rate)) / 2,
        cached: this.stats.cached
      }
      this.presentedCount = 0
      this.renderTotal = 0
      this.statsWindowStart = performance.now()
      this.notify()
    }
    this.host.setPlayhead(shown)
  }

  private reverseBusy = false

  /** Decodes the next second's cached previews ahead of the playhead; lets go of passed ones. */
  private prefetchPreviews(sequence: Sequence, media: MediaItem[], modulation: ModulationContext | null, frameIndex: number): void {
    for (const [j, entry] of this.previews) {
      if (j < frameIndex || j > frameIndex + 30) {
        entry.bitmap?.close()
        this.previews.delete(j)
      }
    }
    for (let j = frameIndex; j < frameIndex + 12; j++) {
      if (this.previews.has(j)) continue
      const key = renderCache.keyFor(sequence, media, modulation, j)
      if (!key || !renderCache.cached.has(key)) continue
      const entry: { key: string; bitmap: ImageBitmap | null | undefined } = { key, bitmap: undefined }
      this.previews.set(j, entry)
      void renderCache.bitmap(key).then(
        (bitmap) => {
          if (this.previews.get(j) === entry) entry.bitmap = bitmap
          else bitmap?.close()
        },
        () => (entry.bitmap = null)
      )
    }
  }

  private renderStillWhilePlaying(): void {
    if (this.reverseBusy) return
    this.reverseBusy = true
    void this.renderStill(true).finally(() => {
      this.reverseBusy = false
    })
  }

  /** Forwards, reversed or a frame hold, from the clip's media time at timeline time `at`. */
  private openStream(media: OpenedMedia, layer: VideoLayer, at: Ticks, sequence: Sequence): FrameSource {
    const clip = layer.clip
    const start = ticksToSeconds(sourceTimeAt(clip, at, ticksPerFrame(frameRateOf(sequence.settings)), layer.item ? mediaLength(layer.item) : null))
    if (clip.speed === 0) return new HoldStream(media, start)
    if (clip.reverse) {
      const step = ticksToSeconds(ticksPerFrame(frameRateOf(sequence.settings))) * clip.speed
      const rate = layer.item?.info.video?.frameRate
      const frameSeconds = rate && rate.num > 0 ? rate.den / rate.num : 1 / 30
      return new ReverseStream(media, start, step, frameSeconds)
    }
    return new VideoStream(media, start)
  }

  private ensureStream(layer: VideoLayer, at: Ticks, sequence: Sequence): FrameSource | null {
    const item = layer.item
    if (!item || item.kind === 'image') return null
    const existing = this.streams.get(layer.clip.id)
    if (existing) return existing
    const path = this.path(item)
    if (!path) return null
    // Open asynchronously; the slot is filled once the file is ready.
    const placeholder: FrameSource = { frameAt: () => null, ready: async () => undefined, close: () => undefined, late: 0 }
    this.streams.set(layer.clip.id, placeholder)
    void openMedia(path)
      .then((media) => {
        if (this.streams.get(layer.clip.id) !== placeholder) return
        this.streams.set(layer.clip.id, this.openStream(media, layer, at, sequence))
      })
      .catch((error: Error) => {
        this.message = `${item.name}: ${error.message}`
        this.notify()
      })
    return placeholder
  }
}

/** The Program monitor: plays the timeline. */
export const player = new Player({
  scene: (preview) => {
    const project = projectController.project
    return project ? { sequence: (preview ? timelineController.sequence : null) ?? project.sequence, media: project.media } : null
  },
  get playhead() {
    return timelineController.playhead
  },
  setPlayhead: (time) => timelineController.setPlayhead(time),
  modulation: () => modulationController.context,
  subscribe: (listener) => {
    const a = projectController.subscribe(listener)
    const b = timelineController.subscribe(listener)
    // Analysis finishing changes what modulated values show.
    const c = modulationController.subscribe(listener)
    return () => {
      a()
      b()
      c()
    }
  }
})
timelineController.transport = player

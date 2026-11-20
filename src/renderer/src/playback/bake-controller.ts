import { lookLutFiles } from '@engine/colour/look-lut'
import { BAKE_VERSION, bakeMoments, bakeSettings, bakeSize, bakeSpan, planBake } from '@engine/datamosh/bake-plan'
import { bakeInputSequence, bakeKey, bakeStore, isBaked, motionSourceSequence, type ReadyBake } from '@engine/datamosh/bakes'
import { STILL_VECTORS, vectorsChange, type VectorFrame } from '@engine/datamosh/vectors'
import { resolveClip } from '@engine/keyframes/properties'
import { DEFAULT_COLOUR, type MediaItem } from '@engine/project/media'
import { frameRateOf, type Clip, type Project } from '@engine/project/model'
import { ticksPerFrame } from '@engine/time'
import { sourceSize } from '@engine/timeline/motion'
import { videoLayersAt } from '@engine/timeline/render-plan'
import { tracksOf } from '@engine/timeline/timeline'
import type { BakeFile, BakeProgress } from '@shared/ipc'
import { getGpu } from '../gpu/shared'
import { modulationController } from '../audio/modulation-controller'
import { mediaController } from '../state/media-controller'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { Compositor } from './compositor'
import { ExactRenderer } from './exact-render'
import { LayerBuilder } from './layers'
import { TemporalStore } from './temporal'
import { YuvConverter } from './yuv'

/**
 * Datamosh Bake (M15, decision 133) in the interface: which bakes the project needs, making the
 * ones that aren't ready yet (one at a time, in the background), and the ready ones the render
 * plan draws. A bake is wanted for every switched-on Datamosh Bake; its key (bakeKey) covers
 * everything it depends on, so after an edit that changes a key, the effect shows its live look
 * at once, and the new bake starts once edits have paused for 0.7 s. Bakes stay on disk in the
 * project's cache, so going back (undo) finds the earlier one ready.
 */

export type BakeState =
  | { kind: 'ready'; frames: number }
  | { kind: 'waiting' }
  | { kind: 'baking'; stage: 'rendering' | 'breaking' | 'vectors' | 'decoding'; fraction: number }
  | { kind: 'failed'; error: string }
  | { kind: 'unavailable'; detail: string }

/** A bake the project needs: whose it is and its key. */
interface Wanted {
  key: string
  clipId: string
  effectId: string
  /** The track's place (V1 = 0), so bakes beneath are made first. */
  order: number
}

const QUIET_MS = 700

/** The bake file as a media item the players can open (never in the project's media). */
export function bakeItem(file: BakeFile): MediaItem {
  return {
    id: `bake:${file.key}`,
    name: 'Bake',
    kind: 'video',
    path: file.path,
    fingerprint: { size: file.size, mtimeMs: 0, sample: file.key },
    info: file.info,
    binId: null,
    importedAt: '',
    marks: { in: null, out: null },
    colour: DEFAULT_COLOUR
  }
}

class CancelledBake extends Error {}

class BakeController extends Observable {
  private projectId: string | null = null
  private timer: number | null = null
  private running: { key: string; id: string | null; cancelled: boolean } | null = null
  private progress = new Map<string, BakeState>()
  private failed = new Map<string, string>()
  private available: { ready: boolean; detail: string | null } | null = null
  private waiters: Array<() => void> = []
  /** Bakes made since the app started, and what ffedit said making the last (tests). */
  made = 0
  notes = new Map<string, string[]>()
  /** Turned off by tests that bake by hand. */
  automatic = true

  constructor() {
    super()
    const schedule = () => this.schedule()
    projectController.subscribe(schedule)
    modulationController.subscribe(schedule)
    window.ginosa.bake.onProgress((p: BakeProgress) => {
      const running = this.running
      if (running && running.id === p.id) {
        this.progress.set(running.key, { kind: 'baking', stage: p.stage, fraction: 0.7 + 0.3 * p.fraction })
        this.notify()
      }
    })
  }

  /** What a Datamosh Bake is doing now, for Effect Controls. */
  stateOf(clip: Clip, effectId: string): BakeState {
    const project = projectController.project
    if (!project) return { kind: 'waiting' }
    const key = bakeKey(project.sequence, project.media, modulationController.context, clip, effectId)
    const ready = bakeStore.get(key)
    if (ready) return { kind: 'ready', frames: ready.frames }
    const failure = this.failed.get(key)
    if (failure) return { kind: 'failed', error: failure }
    const progress = this.progress.get(key)
    if (progress) return progress
    if (this.available && !this.available.ready) return { kind: 'unavailable', detail: this.available.detail ?? 'FFglitch isn’t set up' }
    return { kind: 'waiting' }
  }

  /** Whether FFglitch is set up (asked once, and again after a setup). */
  async status(): Promise<{ ready: boolean; detail: string | null }> {
    this.available ??= await window.ginosa.bake.status()
    return this.available
  }

  /** Asks whether FFglitch is set up, and tells listeners. */
  async refreshStatus(): Promise<void> {
    await this.status()
    this.notify()
  }

  /** Runs FFglitch's setup (the same script as npm run ffglitch-setup); resolves with its exit code. */
  async setUp(onLine: (line: string) => void = () => undefined): Promise<number> {
    const stop = window.ginosa.bake.onSetupLine(onLine)
    try {
      const code = await window.ginosa.bake.setUp()
      this.available = null
      await this.status()
      this.failed.clear()
      this.notify()
      this.schedule()
      return code
    } finally {
      stop()
    }
  }

  /** Bakes again after a failure. */
  retry(clip: Clip, effectId: string): void {
    const project = projectController.project
    if (!project) return
    this.failed.delete(bakeKey(project.sequence, project.media, modulationController.context, clip, effectId))
    this.notify()
    this.schedule(0)
  }

  /** Every bake the project needs, beneath first. */
  private wanted(project: Project): Wanted[] {
    const sequence = project.sequence
    const order = new Map(tracksOf(sequence, 'video').map((t, i) => [t.id, i]))
    const out: Wanted[] = []
    for (const clip of sequence.clips) {
      if (clip.kind !== 'video') continue
      for (const effect of clip.effects) {
        if (!isBaked(effect)) continue
        out.push({ key: bakeKey(sequence, project.media, modulationController.context, clip, effect.id), clipId: clip.id, effectId: effect.id, order: order.get(clip.trackId) ?? 0 })
      }
    }
    return out.sort((a, b) => a.order - b.order)
  }

  /** The bakes in a bake's picture: on the tracks beneath an adjustment layer, or above it on its clip. */
  private inputBakes(project: Project, w: Wanted, wanted: readonly Wanted[]): Wanted[] {
    const clip = project.sequence.clips.find((c) => c.id === w.clipId)
    if (!clip) return []
    if (clip.adjustment) return wanted.filter((o) => o.order < w.order)
    const index = clip.effects.findIndex((e) => e.id === w.effectId)
    const above = new Set(clip.effects.slice(0, Math.max(0, index)).map((e) => e.id))
    return wanted.filter((o) => o.clipId === clip.id && above.has(o.effectId))
  }

  private schedule(delay = QUIET_MS): void {
    const project = projectController.project
    if ((project?.id ?? null) !== this.projectId) this.openProject(project)
    if (this.timer !== null) window.clearTimeout(this.timer)
    // A running bake nobody wants any more stops now.
    if (this.running && project && !this.wanted(project).some((w) => w.key === this.running!.key)) this.cancelRunning()
    this.notify()
    if (!this.automatic) return
    this.timer = window.setTimeout(() => {
      this.timer = null
      void this.next()
    }, delay)
  }

  private openProject(project: Project | null): void {
    this.cancelRunning()
    bakeStore.clear()
    this.progress.clear()
    this.failed.clear()
    this.projectId = project?.id ?? null
    if (!project) return
    void window.ginosa.bake.list(project.id).then((files) => {
      if (this.projectId !== project.id) return
      for (const file of files) bakeStore.set({ key: file.key, path: file.path, item: bakeItem(file), frames: file.frames })
      this.notify()
    }, () => undefined)
  }

  /** Lists the project's bakes again (the Cache window deleted them): those gone are made again. */
  reload(): void {
    const project = projectController.project
    this.projectId = null
    this.openProject(project)
    this.schedule()
  }

  private cancelRunning(): void {
    const running = this.running
    if (!running) return
    running.cancelled = true
    if (running.id) void window.ginosa.bake.cancel(running.id).catch(() => undefined)
    this.progress.delete(running.key)
  }

  /** Starts the next bake the project needs, if none is running. */
  private async next(): Promise<void> {
    const project = projectController.project
    if (!project || this.running) return
    const wanted = this.wanted(project)
    // A bake whose picture holds another bake (beneath it, or above it on the clip) waits for that one.
    const blocked = (w: Wanted) => this.inputBakes(project, w, wanted).some((d) => !bakeStore.get(d.key))
    for (const w of wanted) {
      const failedBeneath = this.inputBakes(project, w, wanted).find((d) => this.failed.has(d.key))
      if (failedBeneath && !this.failed.has(w.key)) this.failed.set(w.key, 'A Datamosh Bake in its picture didn’t bake')
    }
    const todo = wanted.filter((w) => !bakeStore.get(w.key) && !this.failed.has(w.key) && !blocked(w))
    if (todo.length === 0) {
      this.notify()
      this.waiters.splice(0).forEach((w) => w())
      return
    }
    const status = await this.status()
    if (!status.ready) {
      this.notify()
      this.waiters.splice(0).forEach((w) => w())
      return
    }
    await this.bake(project, todo[0]!).catch(() => undefined)
    this.schedule(0)
  }

  /** Bakes everything the project needs (export waits for this); rejects when a bake can't be made. */
  async ensureAll(project: Project): Promise<void> {
    for (;;) {
      const todo = this.wanted(project).filter((w) => !bakeStore.get(w.key))
      if (todo.length === 0) return
      const status = await this.status()
      if (!status.ready) throw new Error(`Datamosh Bake: ${status.detail ?? 'FFglitch isn’t set up'}`)
      const failure = todo.map((w) => this.failed.get(w.key)).find(Boolean)
      if (failure) throw new Error(`Datamosh Bake failed: ${failure}`)
      if (projectController.project !== project) {
        // A snapshot (export) of an older state: bake it directly.
        if (this.running) await new Promise<void>((resolve) => this.waiters.push(resolve))
        await this.bake(project, todo[0]!)
        continue
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        this.schedule(0)
      })
    }
  }

  /** Makes one bake: renders the span's frames into the main process, which does the rest. */
  async bake(project: Project, wanted: Wanted): Promise<ReadyBake> {
    const running = { key: wanted.key, id: null as string | null, cancelled: false }
    this.running = running
    const check = () => {
      if (running.cancelled) throw new CancelledBake()
    }
    const set = (state: BakeState) => {
      if (running.cancelled) return
      this.progress.set(wanted.key, state)
      this.notify()
    }
    set({ kind: 'baking', stage: 'rendering', fraction: 0 })
    const parts: Array<{ destroy(): void } | { close(): void }> = []
    try {
      const sequence = project.sequence
      const clip = sequence.clips.find((c) => c.id === wanted.clipId)
      const effect = clip?.effects.find((e) => e.id === wanted.effectId)
      if (!clip || !effect) throw new Error('The effect is gone')
      const modulation = await modulationController.snapshot(project)
      check()
      const item = clip.adjustment ? undefined : project.media.find((m) => m.id === clip.mediaId)
      const inputSize = clip.adjustment ? { width: sequence.settings.width, height: sequence.settings.height } : sourceSize(item, sequence.settings)
      const settings = bakeSettings(effect.params, sequence.beatGrid?.beatsPerBar ?? 4)
      const size = bakeSize(inputSize, settings.blockSize)
      const span = bakeSpan(sequence, clip)
      if (span.frames === 0) throw new Error('The effect’s clip has no frames')
      const plan = planBake(span.frames, bakeMoments(sequence, clip, settings, span), settings)
      const input = bakeInputSequence(sequence, clip, effect.id, inputSize)
      if (!input) throw new Error('The effect is gone')
      const motion = settings.motionSource ? motionSourceSequence(sequence, clip, settings.motionSource, inputSize) : null
      const frame = ticksPerFrame(frameRateOf(sequence.settings))
      // Each frame's vector values, after keyframes and links.
      const index = clip.effects.findIndex((e) => e.id === effect.id)
      const values: VectorFrame[] = []
      for (let i = 0; i < span.frames; i++) {
        const p = resolveClip(clip, span.start + i * frame, modulation).effects[index]?.params ?? effect.params
        const n = (id: keyof VectorFrame, param: string) => (typeof p[param] === 'number' ? (p[param] as number) : STILL_VECTORS[id])
        values.push({ px: n('px', 'pushX'), py: n('py', 'pushY'), scale: n('scale', 'scale'), rotate: n('rotate', 'rotate'), swirl: n('swirl', 'swirl'), fluid: n('fluid', 'fluid'), wrong: n('wrong', 'wrongGuesses') })
      }
      const id = await window.ginosa.bake.begin({
        projectId: project.id,
        key: wanted.key,
        width: size.width,
        height: size.height,
        output: inputSize,
        rate: frameRateOf(sequence.settings),
        frames: span.frames,
        keyframes: plan.keyframes,
        order: plan.order,
        quantiser: settings.quantiser,
        vectors: vectorsChange(values, motion !== null) ? values : null,
        unit: (2 * size.height) / 1080,
        seed: settings.seed * 7919 + BAKE_VERSION,
        motion: motion !== null
      })
      running.id = id
      if (running.cancelled) {
        await window.ginosa.bake.cancel(id).catch(() => undefined)
        throw new CancelledBake()
      }
      const { device } = await getGpu()
      const renderers = [{ sequence: input, which: 'picture' as const }, ...(motion ? [{ sequence: motion, which: 'motion' as const }] : [])].map(({ sequence: s, which }) => {
        const compositor = new Compositor(device)
        compositor.resize(size.width, size.height)
        // Stateful effects beneath run from their first frame, as in an export.
        const temporal = new TemporalStore(device, Infinity)
        const layers = new LayerBuilder(compositor, undefined, undefined, temporal)
        const renderer = new ExactRenderer(compositor, layers, (m) => mediaController.playablePath(m))
        const yuv = new YuvConverter(device, 'nv12', size.width, size.height)
        parts.push(renderer, { destroy: () => temporal.clear() }, layers, yuv, compositor)
        return { sequence: s, which, layers, renderer, yuv }
      })
      for (const r of renderers) {
        for (const m of project.media) if (m.colour.lut) await r.layers.loadLut(m.colour.lut.file)
        for (const file of lookLutFiles(r.sequence)) await r.layers.loadLookLut(file)
      }
      // A stateful effect beneath that started before the span runs from its start, unseen.
      const resets = videoLayersAt(input, project.media, span.start, modulation).flatMap((l) => (l.temporal ? [l.temporal.resetAt] : []))
      const warm = Math.round(Math.min(span.start, ...resets) / frame)
      for (let f = warm; f < span.first; f++) {
        check()
        await renderers[0]!.renderer.render(input, project.media, f * frame, modulation, size.width / inputSize.width, true)
      }
      for (let i = 0; i < span.frames; i++) {
        check()
        const time = span.start + i * frame
        for (const r of renderers) {
          const texture = await r.renderer.render(r.sequence, project.media, time, modulation, size.width / inputSize.width)
          const bytes = await r.yuv.convert(texture, i)
          check()
          await window.ginosa.bake.frame(id, r.which, bytes)
        }
        if (i % 8 === 0) set({ kind: 'baking', stage: 'rendering', fraction: (0.7 * i) / span.frames })
      }
      check()
      const file = await window.ginosa.bake.finish(id)
      check()
      const bake: ReadyBake = { key: file.key, path: file.path, item: bakeItem(file), frames: file.frames }
      bakeStore.set(bake)
      this.made++
      this.notes.set(file.key, file.notes ?? [])
      this.progress.delete(wanted.key)
      this.notify()
      return bake
    } catch (error) {
      this.progress.delete(wanted.key)
      if (!(error instanceof CancelledBake) && !running.cancelled) {
        this.failed.set(wanted.key, (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
        this.notify()
      }
      throw error
    } finally {
      for (const part of parts.reverse()) 'destroy' in part ? part.destroy() : part.close()
      if (this.running === running) this.running = null
    }
  }

  /** Waits until nothing is baking or waiting to (tests). */
  async idle(timeoutMs = 120_000): Promise<void> {
    const started = performance.now()
    while (performance.now() - started < timeoutMs) {
      const project = projectController.project
      const todo = project ? this.wanted(project).filter((w) => !bakeStore.get(w.key) && !this.failed.has(w.key)) : []
      if (!this.running && this.timer === null && (todo.length === 0 || (this.available && !this.available.ready))) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('Baking didn’t finish in time')
  }
}

export const bakeController = new BakeController()


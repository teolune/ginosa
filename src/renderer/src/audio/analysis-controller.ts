import { ANALYSIS_SAMPLE_RATE, unpackAnalysis, unpackBand, type AudioAnalysis, type BandAnalysis } from '@engine/audio/analysis'
import { hashText, sourceClips, sourceKey, sourceProblem, sourceRange } from '@engine/audio/sources'
import type { AudioSource, Project } from '@engine/project/model'
import { secondsToTicks, type Ticks } from '@engine/time'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { renderAudio } from '../playback/audio-mixdown'
import { mediaController } from '../state/media-controller'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import type { AnalysisWorkerMessage, AnalysisWorkerRequest } from './analysis.worker'

/**
 * Keeps every analysis source analysed (M8). When a source's sound changes (its key), the
 * result is looked up in memory, then in the project's cache, and only then worked out:
 * the source is mixed offline (the same mixer as playback and export) and analysed in a
 * worker. One source at a time; results are kept on disk so reopening is instant.
 */

export type AnalysisStatus =
  | { kind: 'empty'; reason: string }
  | { kind: 'queued' }
  | { kind: 'mixing' }
  | { kind: 'analysing'; done: number }
  | { kind: 'ready' }
  | { kind: 'failed'; error: string }

export interface SourceState {
  key: string | null
  status: AnalysisStatus
  /** The analysis and the sequence time its first frame is at. */
  result: AudioAnalysis | null
  start: Ticks
}

const DEBOUNCE_MS = 600

class AnalysisController extends Observable {
  private states = new Map<string, SourceState>()
  private memory = new Map<string, AudioAnalysis>()
  /** Custom bands (a modulator's own range), by band key. */
  private bands = new Map<string, BandAnalysis>()
  private queue: string[] = []
  private busy = false
  private timer: number | null = null
  private projectId: string | null = null
  /** A source whose detected tempo should become the beat grid once it's analysed. */
  pendingTempo: string | null = null

  constructor() {
    super()
    projectController.subscribe(() => this.schedule())
  }

  state(sourceId: string): SourceState {
    return this.states.get(sourceId) ?? { key: null, status: { kind: 'queued' }, result: null, start: 0 }
  }

  /** Analyses of every ready source, by id (for modulation and the windows). */
  ready(sourceId: string): { result: AudioAnalysis; start: Ticks } | null {
    const s = this.states.get(sourceId)
    return s?.result && s.status.kind === 'ready' ? { result: s.result, start: s.start } : null
  }

  /** The key a custom band of a source is kept under. */
  private bandKey(key: string, low: number, high: number): string {
    return hashText(`${key}:${low}:${high}`)
  }

  /** A custom band (Hz range) of a source, once worked out (modulators ask for it; it's analysed alongside). */
  band(sourceId: string, low: number, high: number): BandAnalysis | null {
    const state = this.states.get(sourceId)
    return state?.key ? (this.bands.get(this.bandKey(state.key, low, high)) ?? null) : null
  }

  /** The custom bands modulators want from each source. */
  private wantedBands(project: Project): Map<string, Array<{ low: number; high: number }>> {
    const wanted = new Map<string, Array<{ low: number; high: number }>>()
    for (const m of project.sequence.modulators) {
      if (m.source.kind !== 'audio' || typeof m.source.band === 'string') continue
      const list = wanted.get(m.source.sourceId) ?? []
      if (!list.some((b) => b.low === (m.source as { band: { low: number } }).band.low && b.high === (m.source as { band: { high: number } }).band.high)) list.push({ ...m.source.band })
      wanted.set(m.source.sourceId, list)
    }
    return wanted
  }

  private missingBands(project: Project, sourceId: string, key: string): Array<{ low: number; high: number }> {
    return (this.wantedBands(project).get(sourceId) ?? []).filter((b) => !this.bands.has(this.bandKey(key, b.low, b.high)))
  }

  private schedule(): void {
    const project = projectController.project
    if ((project?.id ?? null) !== this.projectId) {
      this.projectId = project?.id ?? null
      this.states.clear()
      this.queue = []
      this.pendingTempo = null
    }
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.refresh()
    }, DEBOUNCE_MS)
  }

  /** Waits until every source is analysed (export and tests use this). */
  async settle(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
      this.refresh()
    }
    while (this.busy || this.queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 50))
  }

  private refresh(): void {
    const project = projectController.project
    if (!project) return
    const live = new Set(project.sequence.audioSources.map((s) => s.id))
    for (const id of [...this.states.keys()]) if (!live.has(id)) this.states.delete(id)
    for (const source of project.sequence.audioSources) {
      const problem = sourceProblem(project.sequence, source)
      const key = problem ? null : sourceKey(project.sequence, project.media, source)
      const current = this.states.get(source.id)
      if (current && current.key === key && (key === null || current.status.kind !== 'failed')) {
        // Same sound, but a modulator may want a new custom band of it.
        if (key && current.status.kind === 'ready' && this.missingBands(project, source.id, key).length > 0 && !this.queue.includes(source.id)) this.queue.push(source.id)
        continue
      }
      if (!key) {
        this.states.set(source.id, { key: null, status: { kind: 'empty', reason: problem ?? 'Nothing to analyse' }, result: null, start: 0 })
        continue
      }
      const start = sourceRange(sourceClips(project.sequence, source)).from
      const remembered = this.memory.get(key)
      if (remembered) {
        this.states.set(source.id, { key, status: { kind: 'ready' }, result: remembered, start })
        this.applyPendingTempo(source.id)
        if (this.missingBands(project, source.id, key).length > 0 && !this.queue.includes(source.id)) this.queue.push(source.id)
        continue
      }
      this.states.set(source.id, { key, status: { kind: 'queued' }, result: current?.result ?? null, start })
      if (!this.queue.includes(source.id)) this.queue.push(source.id)
    }
    this.notify()
    void this.work()
  }

  private async work(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!
        const project = projectController.project
        const source = project?.sequence.audioSources.find((s) => s.id === id)
        const state = this.states.get(id)
        if (!project || !source || !state?.key) continue
        await this.analyse(project, source, state.key)
      }
    } finally {
      this.busy = false
    }
  }

  private set(id: string, key: string, status: AnalysisStatus, result: AudioAnalysis | null = this.states.get(id)?.result ?? null): void {
    const state = this.states.get(id)
    if (!state || state.key !== key) return
    this.states.set(id, { ...state, status, result })
    this.notify()
  }

  private async analyse(project: Project, source: AudioSource, key: string): Promise<void> {
    try {
      // The main analysis: memory, then the cache on disk, then worked out.
      let result = this.memory.get(key) ?? null
      if (!result) {
        const cached = await window.ginosa.analysis.read(project.id, key)
        result = cached ? unpackAnalysis(cached) : null
        if (result) this.memory.set(key, result)
      }
      // Custom bands the modulators want: from disk where they've been worked out before.
      let bands = this.missingBands(project, source.id, key)
      for (const b of bands) {
        const cached = await window.ginosa.analysis.read(project.id, this.bandKey(key, b.low, b.high))
        const band = cached ? unpackBand(cached) : null
        if (band) this.bands.set(this.bandKey(key, b.low, b.high), band)
      }
      bands = this.missingBands(project, source.id, key)
      if (result && bands.length === 0) {
        this.set(source.id, key, { kind: 'ready' }, result)
        this.applyPendingTempo(source.id)
        return
      }
      this.set(source.id, key, { kind: 'mixing' })
      const clips = sourceClips(project.sequence, source)
      const { from, to } = sourceRange(clips)
      const rendered = await renderAudio(project.sequence, project.media, from, to, ANALYSIS_SAMPLE_RATE, 1, new Set(clips.map((c) => c.id)), (item) => mediaController.playablePath(item))
      const pcm = new Float32Array(rendered.getChannelData(0))
      this.set(source.id, key, { kind: 'analysing', done: 0 })
      const reply = await runWorker({ pcm, full: !result, bands }, (done) => this.set(source.id, key, { kind: 'analysing', done }))
      if (reply.data) {
        result = unpackAnalysis(reply.data.slice(0))
        if (!result) throw new Error('the analysis came back damaged')
        this.memory.set(key, result)
        await window.ginosa.analysis.write(project.id, key, reply.data).catch(() => undefined)
      }
      for (const [i, data] of reply.bands.entries()) {
        const b = bands[i]!
        const band = unpackBand(data.slice(0))
        if (!band) continue
        this.bands.set(this.bandKey(key, b.low, b.high), band)
        await window.ginosa.analysis.write(project.id, this.bandKey(key, b.low, b.high), data).catch(() => undefined)
      }
      this.set(source.id, key, { kind: 'ready' }, result)
      this.applyPendingTempo(source.id)
    } catch (error) {
      this.set(source.id, key, { kind: 'failed', error: (error as Error).message })
    }
  }

  /** Use a source's detected tempo for the beat grid, now or as soon as it's analysed. */
  useDetectedTempo(sourceId: string): boolean {
    this.pendingTempo = sourceId
    return this.applyPendingTempo(sourceId)
  }

  private applyPendingTempo(sourceId: string): boolean {
    if (this.pendingTempo !== sourceId) return false
    const ready = this.ready(sourceId)
    if (!ready) return false
    this.pendingTempo = null
    const tempo = ready.result.tempo
    if (!tempo) {
      projectController.showMessage('No steady beat was found in that source (it needs at least 4 seconds of music). Type the BPM or tap it instead.')
      return false
    }
    return projectController.dispatch(
      setBeatGrid({ bpm: tempo.bpm, downbeat: ready.start + secondsToTicks(tempo.downbeat), beatsPerBar: tempo.beatsPerBar, sourceId }, 'Detect Tempo')
    )
  }
}

export function runWorker(request: AnalysisWorkerRequest, progress: (done: number) => void): Promise<{ data: ArrayBuffer | null; bands: ArrayBuffer[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<AnalysisWorkerMessage>) => {
      const message = event.data
      if (message.kind === 'progress') progress(message.done)
      else {
        worker.terminate()
        if (message.kind === 'done') resolve({ data: message.data, bands: message.bands })
        else reject(new Error(message.error))
      }
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || 'the analysis worker stopped'))
    }
    worker.postMessage(request, [request.pcm.buffer])
  })
}

export const analysisController = new AnalysisController()

import { ANALYSIS_RATE, ANALYSIS_SAMPLE_RATE, strongHits, unpackBand } from '@engine/audio/analysis'
import { beatAt } from '@engine/audio/beat-grid'
import { hashText } from '@engine/audio/sources'
import type { Clip } from '@engine/project/model'
import { secondsToTicks } from '@engine/time'
import { addAudioSource } from '@engine/timeline/audio-edits'
import { DETECT_LISTEN, sectionsFromHits } from '@engine/timeline/rack'
import { addRackRows, replaceRackSections, STARTER_ROWS, stepsFromHits } from '@engine/timeline/rack-edits'
import { clipEnd, sourceSpan, timeForMedia } from '@engine/timeline/timeline'
import { analysisController, runWorker } from '../audio/analysis-controller'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { fillFromBands, songSteps } from './autofill'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The Channel Rack's Automatic Detection (decision 108). The song is the clip (or clips) on
 * A1. With stem separation set up, the song is split into drums, bass, vocals and the rest
 * first and each channel listens to its own stem; without it, to frequency bands of A1's
 * whole sound (and the message says so). Hits snap to the nearest 16th on the beat grid, and
 * the song is split into sections where the pattern changes.
 */
class Detector extends Observable {
  busy = false
  status = ''
  /** How the last detection listened (for the report and tests). */
  last: { method: 'stems' | 'bands'; hits: Record<string, number> } | null = null

  private set(busy: boolean, status: string): void {
    this.busy = busy
    this.status = status
    this.notify()
  }

  async run(): Promise<boolean> {
    const project = projectController.project
    if (!project || this.busy) return false
    const sequence = project.sequence
    const a1 = sequence.tracks.find((t) => t.kind === 'audio')
    const songClips = a1 ? sequence.clips.filter((c) => c.trackId === a1.id && c.kind === 'audio') : []
    if (!a1 || songClips.length === 0) {
      projectController.showMessage('Drop the song on A1 first: Automatic Detection reads the song there.')
      return false
    }
    if (!sequence.beatGrid) {
      projectController.showMessage('Set the tempo first: the Control Panel’s sparkles find it in the song, or type it on the knob.')
      return false
    }
    this.set(true, 'Listening to the song on A1…')
    try {
      const missing = STARTER_ROWS.filter((s) => !sequence.rack.rows.some((r) => r.detect === s.detect))
      if (missing.length) projectController.dispatch(addRackRows(missing))
      const stems = await window.ginosa.stems.status()
      if (stems.ready) return await this.fromStems(project.id, songClips)
      const done = await this.fromBands(a1.id)
      if (done) {
        projectController.showMessage(
          `${this.summary('frequency bands of the whole song')} For a cleaner pattern, set up stem separation once (npm run stems-setup in Terminal): then the drums and bass are separated from the song first.`
        )
      }
      return done
    } catch (error) {
      projectController.showMessage(`Detection stopped: ${(error as Error).message}`)
      return false
    } finally {
      this.set(false, '')
    }
  }

  /** What detection did, for the message: which channels, from what, in how many sections. */
  private summary(from: string): string {
    const rack = projectController.project!.sequence.rack
    const names = rack.rows.filter((r) => r.detect).map((r) => r.name)
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? 'the channels')
    const sections = `${rack.sections.length} section${rack.sections.length === 1 ? '' : 's'}`
    return `Filled ${list} from ${from} on A1, in ${sections} (Undo brings back what was there).`
  }

  /** Separates each song file on A1 (once; kept in the cache), then finds each channel's hits in its stem. */
  private async fromStems(projectId: string, clips: Clip[]): Promise<boolean> {
    const project = projectController.project!
    const grid = project.sequence.beatGrid!
    const rows = project.sequence.rack.rows.filter((r) => r.detect)
    const hits = new Map<string, number[]>(rows.map((r) => [r.id, []]))
    const off = window.ginosa.stems.onProgress((line) => {
      const percent = /(\d{1,3})%/.exec(line)?.[1]
      if (percent) this.set(true, `Separating the song into drums, bass and vocals… ${percent}%`)
    })
    try {
      for (const clip of clips) {
        const item = project.media.find((m) => m.id === clip.mediaId)
        if (!item) continue
        this.set(true, 'Separating the song into drums, bass and vocals…')
        const key = hashText(JSON.stringify(['stems', 'htdemucs', item.fingerprint]))
        const paths = await window.ginosa.stems.separate(projectId, item.path, key)
        for (const stem of ['drums', 'bass'] as const) {
          const wanted = rows.filter((r) => DETECT_LISTEN[r.detect!].stem === stem)
          if (wanted.length === 0) continue
          this.set(true, `Finding ${wanted.map((r) => r.name.toLowerCase()).join(', ')} in the ${stem}…`)
          const pcm = new Float32Array(await window.ginosa.stems.pcm(paths[stem], ANALYSIS_SAMPLE_RATE))
          const bands = wanted.map((r) => ({ low: DETECT_LISTEN[r.detect!].low, high: DETECT_LISTEN[r.detect!].high }))
          const reply = await runWorker({ pcm, full: false, bands }, () => undefined)
          wanted.forEach((row, i) => {
            const band = unpackBand(reply.bands[i]!.slice(0))
            if (!band) return
            const from = clip.sourceIn
            const to = clip.sourceIn + sourceSpan(clip)
            for (const frame of strongHits(band, DETECT_LISTEN[row.detect!].gate)) {
              const media = secondsToTicks(frame / ANALYSIS_RATE)
              if (media < from || media >= to) continue
              const time = timeForMedia(clip, media)
              if (time >= clip.start && time < clipEnd(clip)) hits.get(row.id)!.push(time)
            }
          })
        }
      }
    } finally {
      off()
    }
    const sequence = projectController.project!.sequence
    const [from, to] = songSteps(sequence)
    const steps: Record<string, number[]> = {}
    for (const row of rows) steps[row.id] = stepsFromHits(hits.get(row.id)!, (t) => beatAt(grid, t), from, to)
    this.last = { method: 'stems', hits: Object.fromEntries(Object.entries(steps).map(([id, s]) => [id, s.length])) }
    if (!projectController.dispatch(replaceRackSections(sectionsFromHits(steps, grid, to), 'Detect Pattern'))) return false
    projectController.showMessage(this.summary('the drums and bass separated from the song'))
    return true
  }

  /** Without stems: each channel takes its band's hits from A1's sound (M8's analysis). */
  private async fromBands(a1: string): Promise<boolean> {
    let source = projectController.project!.sequence.audioSources.find((s) => s.kind === 'track' && s.target === a1)
    if (!source) {
      const command = addAudioSource('track', a1, 'Song (A1)')
      if (!projectController.dispatch(command)) return false
      source = projectController.project!.sequence.audioSources.find((s) => s.id === command.sourceId)!
    }
    const id = source.id
    for (let waited = 0; ; waited += 200) {
      const status = analysisController.state(id).status
      if (analysisController.ready(id)) break
      if (status.kind === 'failed' || status.kind === 'empty' || waited > 180_000) {
        throw new Error(`couldn’t analyse the song on A1 (${status.kind === 'failed' ? status.error : status.kind === 'empty' ? status.reason : 'it took too long'})`)
      }
      this.set(true, status.kind === 'analysing' ? `Listening to the song on A1… ${Math.round(status.done * 100)}%` : 'Listening to the song on A1…')
      await wait(200)
    }
    const steps = fillFromBands(id)
    if (!steps) return false
    this.last = { method: 'bands', hits: Object.fromEntries(Object.entries(steps).map(([rowId, s]) => [rowId, s.length])) }
    return true
  }
}

export const detector = new Detector()


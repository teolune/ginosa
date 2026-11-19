import { ANALYSIS_RATE, ANALYSIS_SAMPLE_RATE, strongHits, unpackBand } from '@engine/audio/analysis'
import { beatAt } from '@engine/audio/beat-grid'
import { hashText } from '@engine/audio/sources'
import type { Clip, RackDetect } from '@engine/project/model'
import { ticksToSeconds } from '@engine/time'
import { addAudioSource } from '@engine/timeline/audio-edits'
import { DETECT_LISTEN, sectionsFromHits } from '@engine/timeline/rack'
import { addRackRows, replaceRackSections, STARTER_ROWS, stepsFromHits } from '@engine/timeline/rack-edits'
import { mediaTimesOnTimeline } from '@engine/timeline/timeline'
import type { StemSeparator } from '@shared/ipc'
import { analysisController, runWorker } from '../audio/analysis-controller'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { fillFromBands, songSteps } from './autofill'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The Channel Rack's Automatic Detection (decision 108). The song is the clip (or clips) on
 * A1. With stem separation set up, the song is split into drums, bass, vocals and the rest
 * first; the drum transcriber (W4.3, when set up) then finds the kick, snare and hi-hat hits
 * in the drums stem, and otherwise each channel listens to its band of its stem. Without
 * separation, the channels listen to frequency bands of A1's whole sound (and the message
 * says so). Hits snap to the nearest 16th on the beat grid, and the song is split into 8-bar
 * sections.
 */
class Detector extends Observable {
  busy = false
  status = ''
  /**
   * How the last detection listened (for the report and tests): cubes per channel, and each kind
   * of channel's hits in seconds on the timeline, before snapping (the detection bench scores them).
   */
  last: {
    method: 'stems' | 'bands'
    separator: StemSeparator | null
    drums: 'transcriber' | 'bands' | null
    bass: 'notes' | 'bands' | null
    hits: Record<string, number>
    times: Partial<Record<RackDetect, number[]>>
  } | null = null

  /** Hits by row id (ticks) as seconds by kind of channel. */
  private timesByKind(times: Map<string, number[]> | Record<string, number[]>): Partial<Record<RackDetect, number[]>> {
    const rows = projectController.project!.sequence.rack.rows
    const entries = times instanceof Map ? [...times] : Object.entries(times)
    const out: Partial<Record<RackDetect, number[]>> = {}
    for (const [rowId, ticks] of entries) {
      const kind = rows.find((r) => r.id === rowId)?.detect
      if (kind) out[kind] = ticks.map(ticksToSeconds).sort((a, b) => a - b)
    }
    return out
  }

  private set(busy: boolean, status: string): void {
    this.busy = busy
    this.status = status
    this.notify()
  }

  /**
   * `method` forces how it listens, `separator` which separator makes the stems and `drums` how
   * the drum channels listen to the drums stem (the detection bench); by default stems from the
   * best separator set up, with the drum transcriber when it's set up, else bands.
   */
  async run(options: { method?: 'stems' | 'bands'; separator?: StemSeparator; drums?: 'transcriber' | 'bands'; bass?: 'notes' | 'bands' } = {}): Promise<boolean> {
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
      const status = await window.ginosa.stems.status()
      const stems = options.method ? options.method === 'stems' : status.ready
      if (stems)
        return await this.fromStems(project.id, songClips, {
          separator: options.separator ?? status.separators[0] ?? 'htdemucs',
          drums: options.drums ?? (status.transcriber ? 'transcriber' : 'bands'),
          bass: options.bass ?? (status.bass ? 'notes' : 'bands'),
          suggestSetup: (!status.transcriber || !status.bass) && !options.drums && !options.bass
        })
      const done = await this.fromBands(a1.id)
      if (done && !options.method) {
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

  /**
   * Separates each song file on A1 (once; kept in the cache), then finds each channel's hits: the
   * drum channels' from the drum transcriber (`drums`), or each channel's in its band of its stem.
   */
  private async fromStems(projectId: string, clips: Clip[], how: { separator: StemSeparator; drums: 'transcriber' | 'bands'; bass: 'notes' | 'bands'; suggestSetup: boolean }): Promise<boolean> {
    const { separator, drums, bass } = how
    const project = projectController.project!
    const grid = project.sequence.beatGrid!
    const rows = project.sequence.rack.rows.filter((r) => r.detect)
    const hits = new Map<string, number[]>(rows.map((r) => [r.id, []]))
    const transcribed = (row: (typeof rows)[number]) => (drums === 'transcriber' && DETECT_LISTEN[row.detect!].stem === 'drums') || (bass === 'notes' && row.detect === 'bass')
    let phase = 'Separating the song into drums, bass and vocals…'
    const off = window.ginosa.stems.onProgress((line) => {
      const percent = /(\d{1,3})%/.exec(line)?.[1]
      if (percent) this.set(true, `${phase} ${percent}%`)
    })
    try {
      for (const clip of clips) {
        const item = project.media.find((m) => m.id === clip.mediaId)
        if (!item) continue
        phase = 'Separating the song into drums, bass and vocals…'
        this.set(true, phase)
        const key = hashText(JSON.stringify(['stems', separator, item.fingerprint]))
        const paths = await window.ginosa.stems.separate(projectId, item.path, key, separator)
        // A song sampled below 32 kHz has nothing above 16 kHz and often nothing above 8: ADTOF then
        // hears no hi-hats at all (BabySlakh's 16 kHz songs), so its hi-hats come from their band.
        const narrow = (item.info.audio?.sampleRate ?? 48_000) < 32_000
        const byModel = (r: (typeof rows)[number]) => transcribed(r) && !(narrow && r.detect === 'hihat')
        const drumRows = rows.filter((r) => byModel(r) && r.detect !== 'bass')
        if (drumRows.length) {
          phase = 'Transcribing the drums hit by hit…'
          this.set(true, phase)
          const found = await window.ginosa.stems.drumHits(projectId, key)
          for (const row of drumRows) hits.get(row.id)!.push(...mediaTimesOnTimeline(clip, found[row.detect as 'kick' | 'clap' | 'hihat'] ?? []))
        }
        const bassRows = rows.filter((r) => byModel(r) && r.detect === 'bass')
        if (bassRows.length) {
          phase = 'Hearing the bass note by note…'
          this.set(true, phase)
          const found = await window.ginosa.stems.bassHits(projectId, key)
          for (const row of bassRows) hits.get(row.id)!.push(...mediaTimesOnTimeline(clip, found.bass))
        }
        for (const stem of ['drums', 'bass'] as const) {
          const wanted = rows.filter((r) => DETECT_LISTEN[r.detect!].stem === stem && !byModel(r))
          if (wanted.length === 0) continue
          this.set(true, `Finding ${wanted.map((r) => r.name.toLowerCase()).join(', ')} in the ${stem}…`)
          const pcm = new Float32Array(await window.ginosa.stems.pcm(paths[stem], ANALYSIS_SAMPLE_RATE))
          const bands = wanted.map((r) => ({ low: DETECT_LISTEN[r.detect!].low, high: DETECT_LISTEN[r.detect!].high }))
          const reply = await runWorker({ pcm, full: false, bands }, () => undefined)
          wanted.forEach((row, i) => {
            const band = unpackBand(reply.bands[i]!.slice(0))
            if (!band) return
            hits.get(row.id)!.push(...mediaTimesOnTimeline(clip, strongHits(band, DETECT_LISTEN[row.detect!].gate).map((frame) => frame / ANALYSIS_RATE)))
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
    this.last = { method: 'stems', separator, drums, bass, hits: Object.fromEntries(Object.entries(steps).map(([id, s]) => [id, s.length])), times: this.timesByKind(hits) }
    if (!projectController.dispatch(replaceRackSections(sectionsFromHits(steps, grid, to), 'Detect Pattern'))) return false
    const heard = `the drums${drums === 'transcriber' ? ' (hit by hit)' : ''} and bass${bass === 'notes' ? ' (note by note)' : ''} separated from the song`
    projectController.showMessage(how.suggestSetup ? `${this.summary(heard)} For hit-by-hit drums and bass notes, set up detection again in the Cache window.` : this.summary(heard))
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
    const filled = fillFromBands(id)
    if (!filled) return false
    this.last = { method: 'bands', separator: null, drums: null, bass: null, hits: Object.fromEntries(Object.entries(filled.steps).map(([rowId, s]) => [rowId, s.length])), times: this.timesByKind(filled.times) }
    return true
  }
}

export const detector = new Detector()


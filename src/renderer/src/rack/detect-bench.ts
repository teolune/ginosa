import { combineScores, roundScore, scoreHits, type HitScore } from '@engine/audio/hit-score'
import type { RackDetect } from '@engine/project/model'
import { secondsToTicks, ticksToSeconds } from '@engine/time'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { deleteClips, placeMedia } from '@engine/timeline/edits'
import type { BenchKey, StemSeparator } from '@shared/ipc'
import { analysisController } from '../audio/analysis-controller'
import { detectTempo } from '../control-panel/actions'
import { mediaController } from '../state/media-controller'
import { projectController } from '../state/project-controller'
import { detector } from './detect'

/**
 * The detection bench (W4.1): Detect on songs whose hits are known, scored channel by channel
 * (F-measure within ±30 ms, engine/audio/hit-score). The songs: the generated test drums, and
 * the answer keys in media/bench/keys (the STAR Drums preview, your songs from Reference
 * Materials). Each runs with bands of the whole song and, when stem separation is set up, with
 * each separator's stems (bands of the stems), and with the best separator's stems and the drum
 * transcriber (W4.3) when that's set up. Songs without answers are run and counted only.
 */

const KINDS: RackDetect[] = ['kick', 'clap', 'hihat', 'bass']
const TARGETS: Record<RackDetect, number> = { kick: 0.95, clap: 0.9, hihat: 0.85, bass: 0.9 }
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(test: () => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (test()) return true
    await pause(100)
  }
  return test()
}

function run(command: Parameters<typeof projectController.dispatch>[0]): void {
  if (!projectController.dispatch(command)) throw new Error(`${command.label} failed: ${projectController.lastError}`)
}

/** media/test/beat_128bpm.wav (scripts/make-test-media.sh): 128 BPM from 0.4 s, a kick on every beat, a snare on 2 and 4, hi-hats on 8ths, 30 s. */
async function generatedDrums(): Promise<BenchKey | null> {
  const audio = (await window.ginosa.snapshot.testMedia()).find((f) => /beat_128bpm\.wav$/.test(f))
  if (!audio) return null
  const beat = 60 / 128
  const beats = Array.from({ length: 64 }, (_, i) => 0.4 + i * beat)
  return {
    name: 'Generated drums, 128 BPM',
    source: 'scripts/make-test-media.sh',
    audio,
    bpm: 128,
    downbeat: 0.4,
    grid: null,
    hits: { kick: beats, clap: beats.filter((_, i) => i % 2 === 1), hihat: Array.from({ length: 127 }, (_, i) => 0.4 + (i * beat) / 2) }
  }
}

/** A grid as the bench reports it (seconds), and against the true grid when the key has one. */
function gridReport(truth: BenchKey['grid']): Record<string, unknown> | null {
  const grid = projectController.project!.sequence.beatGrid
  if (!grid) return null
  const out: Record<string, unknown> = { bpm: Math.round(grid.bpm * 1000) / 1000, downbeat: Math.round(ticksToSeconds(grid.downbeat) * 10000) / 10000 }
  if (truth) {
    const beat = 60 / truth.bpm
    const beats = (ticksToSeconds(grid.downbeat) - truth.downbeat) / beat
    out['tempoRight'] = Math.abs(grid.bpm - truth.bpm) / truth.bpm < 0.005
    // Bar 1 against the true bar lines: how many beats off (0 = on a bar line), and how far from the nearest beat.
    out['barOffBeats'] = ((Math.round(beats) % 4) + 4) % 4
    out['beatOffMs'] = Math.round((beats - Math.round(beats)) * beat * 1000)
  }
  return out
}

/** The Control Panel's tempo detection by `method`, from no grid; the grid it set. */
async function detectGrid(method: 'beats' | 'analysis', truth: BenchKey['grid']): Promise<Record<string, unknown> | null> {
  if (projectController.project!.sequence.beatGrid) run(setBeatGrid(null))
  detectTempo({ method })
  if (!(await until(() => projectController.project!.sequence.beatGrid !== null, 120_000))) return null
  return gridReport(truth)
}

/** One song on A1 (everything else cleared), with its tempo. */
async function setUp(key: BenchKey): Promise<{ seconds: number; tempo: Record<string, unknown> }> {
  const clips = projectController.project!.sequence.clips.map((c) => c.id)
  if (clips.length) run(deleteClips(clips))
  let item = projectController.project!.media.find((m) => m.path === key.audio)
  if (!item) {
    await mediaController.importPaths([key.audio], null)
    await until(() => projectController.project!.media.some((m) => m.path === key.audio && m.info.durationSeconds > 0), 30_000)
    item = projectController.project!.media.find((m) => m.path === key.audio)
  }
  if (!item) throw new Error(`couldn't import ${key.audio}`)
  const seconds = item.info.durationSeconds
  const a1 = projectController.project!.sequence.tracks.find((t) => t.kind === 'audio')!.id
  run(placeMedia({ mediaId: item.id, sourceIn: 0, sourceOut: secondsToTicks(seconds), at: 0, videoTrackId: null, audioTrackId: a1, mode: 'overwrite' }))
  const tempo: Record<string, unknown> = {}
  if (key.bpm) run(setBeatGrid({ bpm: key.bpm, downbeat: secondsToTicks(key.downbeat ?? 0), beatsPerBar: 4, sourceId: null }))
  else {
    // Both of the Control Panel's ways (W4.5), Beat This! last so Detect uses its grid when it's set up.
    tempo['analysis'] = await detectGrid('analysis', key.grid)
    if ((await window.ginosa.stems.status()).beats) tempo['beat-this'] = await detectGrid('beats', key.grid)
    if (!projectController.project!.sequence.beatGrid) throw new Error(`no tempo found in ${key.name}`)
  }
  await analysisController.settle()
  return { seconds, tempo }
}

export async function detectBench(): Promise<Record<string, unknown>> {
  const keys = [await generatedDrums(), ...(await window.ginosa.snapshot.benchKeys())].filter((k): k is BenchKey => k !== null)
  // Bands, then each separator set up (W4.2: BS-RoFormer-SW and htdemucs), then the best with the drum transcriber (W4.3).
  const status = await window.ginosa.stems.status()
  const runs: Array<{ label: string; method: 'bands' | 'stems'; separator?: StemSeparator; drums?: 'transcriber' | 'bands'; bass?: 'notes' | 'bands' }> = [
    { label: 'bands', method: 'bands' },
    ...status.separators.map((separator) => ({ label: separator, method: 'stems' as const, separator, drums: 'bands' as const, bass: 'bands' as const })),
    // The best separator with the drum transcriber (W4.3) and the bass ear (W4.4), as Detect runs by default.
    ...(status.transcriber && status.separators[0]
      ? [{ label: `${status.separators[0]}+transcriber`, method: 'stems' as const, separator: status.separators[0], drums: 'transcriber' as const, bass: status.bass ? ('notes' as const) : ('bands' as const) }]
      : [])
  ]
  const methods = runs.map((r) => r.label)
  const songs: Array<Record<string, unknown>> = []
  const all: Record<string, Partial<Record<RackDetect, HitScore[]>>> = Object.fromEntries(methods.map((m) => [m, {}]))
  for (const key of keys) {
    const song: Record<string, unknown> = { name: key.name, source: key.source }
    try {
      const { seconds, tempo } = await setUp(key)
      song['seconds'] = Math.round(seconds * 10) / 10
      song['tempo'] = tempo
      if (key.grid) song['trueGrid'] = key.grid
      if (key.answers) song['yourAnswers'] = key.answers
      const grid = projectController.project!.sequence.beatGrid
      song['bpm'] = Math.round((grid?.bpm ?? 0) * 1000) / 1000
      song['downbeat'] = grid ? Math.round(ticksToSeconds(grid.downbeat) * 10000) / 10000 : null
      for (const { label: method, ...how } of runs) {
        const started = performance.now()
        const done = await detector.run(how)
        const times = detector.last?.times ?? {}
        const result: Record<string, unknown> = { done, ms: Math.round(performance.now() - started) }
        if (!done) result['error'] = projectController.lastError
        for (const kind of KINDS) {
          const found = times[kind] ?? []
          const truth = key.hits?.[kind]
          if (!truth) {
            result[kind] = { found: found.length }
            continue
          }
          const score = scoreHits(found, truth)
          ;(all[method]![kind] ??= []).push(score)
          result[kind] = roundScore(score)
        }
        song[method] = result
      }
    } catch (error) {
      song['error'] = (error as Error).message
    }
    songs.push(song)
  }
  const totals = Object.fromEntries(
    methods.map((method) => [
      method,
      Object.fromEntries(
        KINDS.filter((k) => all[method]![k]?.length).map((kind) => {
          const s = roundScore(combineScores(all[method]![kind]!))
          return [kind, { f: s.f, precision: s.precision, recall: s.recall, meanOffsetMs: s.meanOffsetMs, songs: all[method]![kind]!.length, target: TARGETS[kind], meets: s.f >= TARGETS[kind] }]
        })
      )
    ])
  )
  return { verdict: 'measured', methods, totals, songs }
}

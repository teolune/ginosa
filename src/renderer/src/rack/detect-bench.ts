import { combineScores, roundScore, scoreHits, type HitScore } from '@engine/audio/hit-score'
import type { RackDetect } from '@engine/project/model'
import { secondsToTicks } from '@engine/time'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { deleteClips, placeMedia } from '@engine/timeline/edits'
import type { BenchKey } from '@shared/ipc'
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
 * stems. Songs without answers are run and counted only.
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
    hits: { kick: beats, clap: beats.filter((_, i) => i % 2 === 1), hihat: Array.from({ length: 127 }, (_, i) => 0.4 + (i * beat) / 2) }
  }
}

/** One song on A1 (everything else cleared), with its tempo. */
async function setUp(key: BenchKey): Promise<{ seconds: number }> {
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
  if (key.bpm) run(setBeatGrid({ bpm: key.bpm, downbeat: secondsToTicks(key.downbeat ?? 0), beatsPerBar: 4, sourceId: null }))
  else {
    run(setBeatGrid(null))
    detectTempo()
    if (!(await until(() => projectController.project!.sequence.beatGrid !== null, 120_000))) throw new Error(`no tempo found in ${key.name}`)
  }
  await analysisController.settle()
  return { seconds }
}

export async function detectBench(): Promise<Record<string, unknown>> {
  const keys = [await generatedDrums(), ...(await window.ginosa.snapshot.benchKeys())].filter((k): k is BenchKey => k !== null)
  const methods: Array<'bands' | 'stems'> = (await window.ginosa.stems.status()).ready ? ['bands', 'stems'] : ['bands']
  const songs: Array<Record<string, unknown>> = []
  const all: Record<string, Partial<Record<RackDetect, HitScore[]>>> = Object.fromEntries(methods.map((m) => [m, {}]))
  for (const key of keys) {
    const song: Record<string, unknown> = { name: key.name, source: key.source }
    try {
      const { seconds } = await setUp(key)
      song['seconds'] = Math.round(seconds * 10) / 10
      song['bpm'] = Math.round((projectController.project!.sequence.beatGrid?.bpm ?? 0) * 100) / 100
      for (const method of methods) {
        const started = performance.now()
        const done = await detector.run({ method })
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

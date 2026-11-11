import { secondsToTicks } from '@engine/time'
import { placeMedia } from '@engine/timeline/edits'
import { analysisController } from '../audio/analysis-controller'
import { detectTempo } from '../control-panel/actions'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import { detector } from './detect'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(test: () => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (test()) return true
    await pause(100)
  }
  return test()
}

/**
 * W3's Automatic Detection, end to end, as you'd use it: the 128 BPM test drums (a kick on
 * every beat, a snare on 2 and 4, hi-hats on every 8th) on A1, the tempo from the Control
 * Panel's sparkles, then the Channel Rack's Detect. With stem separation set up the song is
 * separated first; without it the channels listen to bands of the whole song. Either way the
 * kicks must land on the beats, the claps on 2 and 4 and the hi-hats on the 8ths.
 */
export async function rackDetectTest(): Promise<Record<string, unknown>> {
  const reasons: string[] = []
  const check = (ok: boolean, reason: string) => {
    if (!ok) reasons.push(reason)
  }
  const project = projectController.project!
  const a1 = project.sequence.tracks.find((t) => t.kind === 'audio')!.id
  const song = project.media.find((m) => m.name === 'beat_128bpm')
  if (!song) throw new Error('beat_128bpm is missing (npm run test-media)')
  projectController.dispatch(placeMedia({ mediaId: song.id, sourceIn: 0, sourceOut: secondsToTicks(20), at: 0, videoTrackId: null, audioTrackId: a1, mode: 'overwrite' }))
  detectTempo()
  check(await until(() => projectController.project!.sequence.beatGrid !== null, 30_000), 'tempo detection never set a beat grid')
  await analysisController.settle()
  const stems = await window.ginosa.stems.status()
  workspaceController.open('channel-rack')
  workspaceController.focus('channel-rack')
  const started = performance.now()
  const done = await detector.run()
  const seconds = Math.round((performance.now() - started) / 100) / 10
  const message = projectController.lastError
  const sequence = projectController.project!.sequence
  const sections = sequence.rack.sections
  const stepsOf = (name: string) => {
    const row = sequence.rack.rows.find((r) => r.name === name)
    return row ? (sections[0]?.cubes[row.id] ?? []).map((c) => c.step) : []
  }
  const kick = stepsOf('Kick')
  const clap = stepsOf('Clap')
  const hat = stepsOf('Hi-hat')
  check(done, `detection didn't finish: ${message}`)
  check(detector.last?.method === (stems.ready ? 'stems' : 'bands'), `listened by ${detector.last?.method}, expected ${stems.ready ? 'stems' : 'bands'}`)
  check(sections.length >= 1, 'no sections')
  check(kick.length >= 6 && kick.every((s) => s % 4 === 0), `kicks not on the beats: ${kick.join(' ')}`)
  check(clap.length >= 3 && clap.every((s) => s % 8 === 4), `claps not on 2 and 4: ${clap.join(' ')}`)
  check(hat.length >= 12 && hat.every((s) => s % 2 === 0), `hi-hats not on the 8ths: ${hat.join(' ')}`)
  timelineController.zoomToFit()
  timelineController.setPlayhead(secondsToTicks(2.2))
  await pause(800)
  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    method: detector.last?.method ?? null,
    stems: stems.ready ? 'ready' : stems.detail,
    seconds,
    grid: sequence.beatGrid,
    sections: sections.map((s) => s.bars),
    sectionA: Object.fromEntries(sequence.rack.rows.map((r) => [r.name, (sections[0]?.cubes[r.id] ?? []).map((c) => c.step)])),
    hits: detector.last?.hits ?? null,
    message
  }
}

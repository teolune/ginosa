import { secondsToTicks, ticksToSeconds } from '@engine/time'
import { placeMedia } from '@engine/timeline/edits'
import { projectController } from '../state/project-controller'
import { syncController } from './sync-controller'

/**
 * W5.1: syncing takes to the song by their sound, through the app. The song on A1 (40 s that
 * never repeats); takes made from it as a camera on set hears it (a stretch, quieter, muffled,
 * a room echo, pink noise; make-test-media.sh): take_a from 5.2 s, take_b from 13.36 s (more
 * noise), take_early starting 1.5 s before the song, and take_noise with no song in it. Each is
 * placed somewhere else first; Sync to Song by Sound should put each where the song is in it,
 * to the sample (a clip starts on a frame, sourceIn taking up the rest), and leave take_noise.
 */

const EXPECTED: Record<string, number | null> = { take_a: 5.2, take_b: 13.36, take_early: -1.5, take_noise: null }

export async function syncTest() {
  const reasons: string[] = []
  const run = (command: Parameters<typeof projectController.dispatch>[0]) => {
    if (!projectController.dispatch(command)) throw new Error(`${command.label} failed: ${projectController.lastError}`)
  }
  const project = projectController.project!
  const video = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const audio = project.sequence.tracks.filter((t) => t.kind === 'audio').map((t) => t.id)
  const item = (name: string) => {
    const found = projectController.project!.media.find((m) => m.name === name)
    if (!found) throw new Error(`${name} is missing (npm run test-media)`)
    return found
  }
  const song = item('multicam_song')
  run(placeMedia({ mediaId: song.id, sourceIn: 0, sourceOut: secondsToTicks(40), at: 0, videoTrackId: null, audioTrackId: audio[0]!, mode: 'overwrite' }))
  // Somewhere wrong first.
  const firstAt: Record<string, [number, number]> = { take_a: [0, 20], take_b: [1, 0], take_early: [2, 25], take_noise: [0, 42] }
  for (const [name, [track, at]] of Object.entries(firstAt)) {
    const m = item(name)
    run(placeMedia({ mediaId: m.id, sourceIn: 0, sourceOut: secondsToTicks(m.info.durationSeconds), at: secondsToTicks(at), videoTrackId: video[track]!, audioTrackId: null, mode: 'overwrite' }))
  }
  const takes = () => projectController.project!.sequence.clips.filter((c) => c.kind === 'video' && c.name.startsWith('take_'))
  const before = Object.fromEntries(takes().map((c) => [c.name, c.start]))
  const started = performance.now()
  const results = await syncController.syncToSong(takes().map((c) => c.id))
  const ms = Math.round(performance.now() - started)
  const report = takes().map((clip) => {
    const result = results.find((r) => r.clipId === clip.id)
    const expected = EXPECTED[clip.name] ?? null
    // Where the take file's time 0 now sits against the song (A1 at 0 from its start): start − sourceIn.
    const zero = ticksToSeconds(clip.start - clip.sourceIn)
    const errorMs = expected === null ? null : Math.round((zero - expected) * 1e6) / 1e3
    return { name: clip.name, outcome: result?.outcome ?? 'missing', score: Math.round((result?.match?.score ?? 0) * 10) / 10, lead: Math.round((result?.match?.lead ?? 0) * 100) / 100, start: ticksToSeconds(clip.start), sourceIn: Math.round(ticksToSeconds(clip.sourceIn) * 1e4) / 1e4, errorMs, moved: clip.start !== before[clip.name] }
  })
  for (const r of report) {
    const expected = EXPECTED[r.name]
    if (expected === null) {
      if (r.outcome !== 'none' || r.moved) reasons.push(`${r.name}: should be left alone as unheard, was ${r.outcome}${r.moved ? ' and moved' : ''}`)
    } else if (r.outcome !== 'sure' || r.errorMs === null || Math.abs(r.errorMs) > 1) reasons.push(`${r.name}: ${r.outcome}, ${r.errorMs} ms out`)
  }
  if (report.length !== 4) reasons.push(`expected 4 takes, found ${report.length}`)
  const message = syncController.summary(results)
  // One undo step puts them all back.
  projectController.undo()
  const undone = takes().every((c) => c.start === before[c.name])
  if (!undone) reasons.push('undo didn’t put every take back')
  return { verdict: reasons.length ? 'fail' : 'pass', reasons, ms, takes: report, message, undone }
}

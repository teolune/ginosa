import { beatSnapTargets } from '@engine/audio/beat-grid'
import { sourceKey } from '@engine/audio/sources'
import { setTrackFlag } from '@engine/project/commands'
import { secondsToTicks, ticksToSeconds } from '@engine/time'
import { addAudioSource } from '@engine/timeline/audio-edits'
import { placeMedia } from '@engine/timeline/edits'
import { frameTicks } from '@engine/timeline/timeline'
import { projectController } from '../state/project-controller'
import { analysisController } from './analysis-controller'

/**
 * M8 part 1 check: the 128 BPM drum file, on a muted track (a sidechain), is analysed as a
 * track source; its detected tempo becomes the beat grid. Expect 128 BPM with bars
 * starting 0.4 s into the file (it sits at 1 s, so at 1.4 s), and the result in the cache.
 */
export async function analysisTest() {
  const project = projectController.project!
  const item = project.media.find((m) => m.name === 'beat_128bpm')
  if (!item) throw new Error('beat_128bpm is missing (npm run test-media)')
  const a1 = project.sequence.tracks.find((t) => t.kind === 'audio')!.id
  projectController.dispatch(placeMedia({ mediaId: item.id, sourceIn: 0, sourceOut: null, at: secondsToTicks(1), videoTrackId: null, audioTrackId: a1, mode: 'overwrite' }))
  projectController.dispatch(setTrackFlag(a1, 'muted', true))
  const command = addAudioSource('track', a1, 'Drums')
  projectController.dispatch(command)
  analysisController.useDetectedTempo(command.sourceId)
  const started = performance.now()
  await analysisController.settle()
  const seconds = (performance.now() - started) / 1000
  const reasons: string[] = []
  const state = analysisController.state(command.sourceId)
  if (state.status.kind !== 'ready') reasons.push(`analysis ended ${state.status.kind}${state.status.kind === 'failed' ? `: ${state.status.error}` : ''}`)
  const sequence = projectController.project!.sequence
  const grid = sequence.beatGrid
  if (!grid) reasons.push('no beat grid was set')
  const bar = (4 * 60) / 128
  const downbeatError = grid ? ((((ticksToSeconds(grid.downbeat) - 1.4) % bar) + bar * 1.5) % bar) - bar / 2 : NaN
  if (grid && Math.abs(grid.bpm - 128) > 0.02) reasons.push(`tempo ${grid.bpm}, expected 128`)
  if (grid && !(Math.abs(downbeatError) <= 0.006)) reasons.push(`bars start ${(downbeatError * 1000).toFixed(1)} ms from where they should`)
  const key = sourceKey(sequence, projectController.project!.media, sequence.audioSources[0]!)
  const cached = key ? await window.ginosa.analysis.read(projectController.project!.id, key) : null
  if (!cached) reasons.push('the analysis was not saved in the cache')
  const frame = frameTicks(sequence)
  const snapsToBar = grid ? beatSnapTargets(grid, 0, secondsToTicks(10), frame).includes(Math.round(secondsToTicks(1.4 + bar) / frame) * frame) : false
  if (!snapsToBar) reasons.push('the second bar is not a snapping target')
  const result = state.result
  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    seconds: Math.round(seconds * 100) / 100,
    detected: result?.tempo ?? null,
    grid,
    downbeatErrorMs: Math.round(downbeatError * 10000) / 10,
    frames: result?.frames,
    hits: result ? { all: result.hits.length, sub: result.bands.sub.hits.length, high: result.bands.high.hits.length } : null,
    cachedBytes: cached?.byteLength ?? 0
  }
}

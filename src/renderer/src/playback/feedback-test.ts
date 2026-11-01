import type { ExportSettings } from '@engine/export/export-settings'
import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '@engine/time'
import { addAdjustmentLayer, addEffect, setEffectEnabled, setEffectValues } from '@engine/timeline/effect-edits'
import { placeMedia } from '@engine/timeline/edits'
import { setAnimated, setValue } from '@engine/timeline/keyframe-edits'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { readRowBoxes } from './colour-probe'
import { exporter } from './exporter'
import { capturePlayback, comparePlayback } from './playback-capture'
import { player } from './player'

/**
 * M9 "done when", part 2: a Feedback effect (85%, no zoom) on an adjustment layer over a
 * white square sliding right. Each frame should be exactly this frame over the previous
 * output at 85%, so with the effect off (A) and on (B) exported, every frame of B is
 * checked against A and B's frame before. Then: real-time playback against B, jumps
 * around the timeline (each caught up from a checkpoint) against B, and an edit (85% →
 * 60%) that must throw the old state away.
 */

const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const XS = Array.from({ length: 960 }, (_, i) => i * 2)
const ROW_Y = 538
const K = 0.85
const SETTINGS: ExportSettings = { format: 'prores-4444', container: 'mov', bitrateMbps: 40, keyframeSeconds: 1 }

export interface FeedbackTimeline {
  layer: string
  effect: string
}

export function buildFeedbackTimeline(): FeedbackTimeline {
  const run = (command: Parameters<typeof projectController.dispatch>[0]) => {
    if (!projectController.dispatch(command)) throw new Error(`${command.label} failed: ${projectController.lastError}`)
  }
  const project = projectController.project!
  const [v1, v2] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const square = project.media.find((m) => m.name === 'square_1080')
  if (!square) throw new Error('square_1080 is missing (npm run test-media)')
  run(placeMedia({ mediaId: square.id, sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: v1!, audioTrackId: null, mode: 'overwrite' }))
  const clip = projectController.project!.sequence.clips.find((c) => c.kind === 'video')!.id
  run(setAnimated({ clipId: clip, effectId: null, param: 'position' }, true, 0))
  run(setValue({ clipId: clip, effectId: null, param: 'position' }, [560, 540], 0))
  run(setValue({ clipId: clip, effectId: null, param: 'position' }, [1360, 540], s(7.96)))
  run(addAdjustmentLayer({ trackId: v2!, start: 0, duration: s(8) }))
  const layer = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  run(addEffect([layer], 'feedback'))
  const effect = projectController.project!.sequence.clips.find((c) => c.id === layer)!.effects[0]!.id
  run(setEffectValues(layer, effect, { params: { amount: K * 100, zoom: 100, rotation: 0 } }))
  return { layer, effect }
}

async function exportRows(name: string): Promise<number[][][]> {
  const path = (await window.ginosa.snapshot.exportPath(name))!
  const result = await exporter.run(projectController.project!, SETTINGS, path)
  if (!result) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : `export ${exporter.state.kind}`)
  return (await window.ginosa.snapshot.analyseExport(path, XS))!.rows
}

/** Feedback over the row, worked out from the input rows alone: out = in + (out before − in) × k. */
export function feedbackRows(input: number[][][], k: number): number[][][] {
  const out: number[][][] = []
  input.forEach((row, j) => out.push(j === 0 ? row.map((p) => [...p]) : row.map((p, i) => p.map((v, c) => v + (out[j - 1]![i]![c]! - v) * k))))
  return out
}

export async function feedbackTest() {
  const { layer, effect } = buildFeedbackTimeline()
  const reasons: string[] = []
  const toggle = (on: boolean) => projectController.dispatch(setEffectEnabled(layer, effect, on))

  // A: the input (effect off). B: with Feedback.
  toggle(false)
  const a = await exportRows('feedback-off.mov')
  toggle(true)
  const b = await exportRows('feedback.mov')
  const frames = b.length
  if (frames !== 200 || a.length !== 200) reasons.push(`expected 200 frames, found ${a.length} and ${frames}`)
  let recurrence = 0
  let trail = 0
  for (let j = 1; j < frames; j++)
    for (let i = 0; i < XS.length; i++)
      for (let c = 0; c < 3; c++) {
        const want = a[j]![i]![c]! + (b[j - 1]![i]![c]! - a[j]![i]![c]!) * K
        recurrence = Math.max(recurrence, Math.abs(b[j]![i]![c]! - want))
        if (c === 1 && b[j]![i]![c]! - a[j]![i]![c]! > 0.1) trail++
      }
  if (!(recurrence <= 0.004)) reasons.push(`export: frames differ from "this frame over the last at 85%" by up to ${recurrence.toFixed(4)}`)
  if (trail < 1000) reasons.push(`export: only ${trail} samples show a trail`)
  // Frame 0 is the reset: no trail at all.
  const first = Math.max(...b[0]!.flatMap((p, i) => p.map((v, c) => Math.abs(v - a[0]![i]![c]!))))
  if (!(first <= 0.003)) reasons.push(`export: the first frame isn't the input (differs by ${first.toFixed(4)})`)

  // Real-time playback against the export.
  const played = await capturePlayback(XS, ROW_Y, frames, 7.96)
  const playback = comparePlayback(played, b)
  if (playback.compared < frames * 0.9) reasons.push(`playback presented only ${playback.compared} of ${frames} frames`)
  if (!(playback.worst <= 0.006)) reasons.push(`playback and export differ by up to ${playback.worst.toFixed(4)}`)
  const approximate = player.temporal?.stats.approximate ?? 0

  // Jumps (scrubbing), each against the export, with what it took to catch up.
  player.temporal?.clear()
  const jumps: Array<{ at: number; frame: number; caughtUp: number; ms: number; worst: number }> = []
  for (const at of [6, 2.32, 7.52, 0.4, 5.08, 6.04, 6]) {
    const j = Math.round(s(at) / FRAME)
    timelineController.setPlayhead(j * FRAME)
    await player.settled()
    const row = await readRowBoxes(player.lastStill!, XS, ROW_Y)
    const compared = comparePlayback([{ j, row }], b)
    jumps.push({ at, frame: j, caughtUp: player.lastCatchUp?.frames ?? -1, ms: Math.round(player.lastCatchUp?.ms ?? 0), worst: Math.round(compared.worst * 10000) / 10000 })
  }
  const jumpWorst = Math.max(...jumps.map((j) => j.worst))
  if (!(jumpWorst <= 0.006)) reasons.push(`a jump differs from the export by up to ${jumpWorst.toFixed(4)}`)
  // Into a stretch rendered before, a jump replays at most a second (from a checkpoint);
  // a checkpoint's own frame, or the one after the frame just shown, replays nothing.
  const revisits = jumps.filter((j, i) => i > 0 && j.frame <= jumps[0]!.frame)
  const longest = Math.max(...revisits.map((j) => j.caughtUp))
  if (longest > 25) reasons.push(`a jump replayed ${longest} frames (checkpoints every second should cap it at 25)`)
  if (jumps.at(-1)!.caughtUp !== 0 || jumps.at(-2)!.caughtUp !== 0) reasons.push('a kept frame (a checkpoint, or the one after the frame shown) was replayed')

  // An edit throws the state away: at 60% the frame at 4 s must match feedback worked out from the input.
  projectController.dispatch(setEffectValues(layer, effect, { params: { amount: 60 } }))
  const j = 100
  timelineController.setPlayhead(j * FRAME)
  await player.settled()
  const edited = await readRowBoxes(player.lastStill!, XS, ROW_Y)
  const expected = feedbackRows(a, 0.6)[j]!
  const afterEdit = comparePlayback([{ j: 0, row: edited }], [expected])
  if (!(afterEdit.worst <= 0.006)) reasons.push(`after changing Feedback to 60%, 4 s differs from the expected by ${afterEdit.worst.toFixed(4)}`)
  projectController.dispatch(setEffectValues(layer, effect, { params: { amount: K * 100 } }))

  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    export: { frames, worstAgainstRecurrence: Math.round(recurrence * 10000) / 10000, trailSamples: trail, firstFrameVsInput: Math.round(first * 10000) / 10000 },
    playbackVsExport: { framesCompared: playback.compared, points: playback.points, worst: Math.round(playback.worst * 10000) / 10000, approximateFrames: approximate },
    jumps,
    afterEdit: { frame: j, caughtUp: player.lastCatchUp?.frames ?? null, worst: Math.round(afterEdit.worst * 10000) / 10000 },
    stateMemoryMB: Math.round((player.temporal?.bytes() ?? 0) / 1e6)
  }
}

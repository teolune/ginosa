import type { ExportSettings } from '@engine/export/export-settings'
import { setTrackFlag } from '@engine/project/commands'
import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '@engine/time'
import { addAdjustmentLayer, addEffect, setEffectEnabled, setEffectValues } from '@engine/timeline/effect-edits'
import { placeMedia } from '@engine/timeline/edits'
import { setAnimated, setValue } from '@engine/timeline/keyframe-edits'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { readRowBoxes } from './colour-probe'
import { exporter } from './exporter'
import { capturePlayback } from './playback-capture'
import { player } from './player'

/**
 * M14: Datamosh through the whole app, on an adjustment layer over the test pattern (panning
 * 2 px a frame, with its own moving parts):
 *  - the export is deterministic (two exports are identical), starts on the real frame (the
 *    reset), and really moshes (later frames differ from the footage);
 *  - real-time playback and jumps around the timeline (each caught up from a checkpoint) match
 *    the export;
 *  - motion transfer: with Motion Source set to a hidden track holding a white square that
 *    slides right, the export starts on the footage (the hidden square isn't shown), and away
 *    from the square the picture holds frame 0: the footage's own pan no longer moves it.
 *    Playback and jumps match that export too.
 */

const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const FRAMES = 100
const XS = Array.from({ length: 960 }, (_, i) => i * 2)
const ROW_Y = 538
const SETTINGS: ExportSettings = { format: 'prores-4444', container: 'mov', bitrateMbps: 40, keyframeSeconds: 1 }
const round = (v: number) => Math.round(v * 10000) / 10000
const captured = (until: number) => capturePlayback(XS, ROW_Y, FRAMES, until)

/**
 * Preview rows against the file's, like comparePlayback, but only where the preview is flat
 * for 8 px either side (a datamosh is full of hard block edges, and ProRes, like any DCT codec,
 * rings within the 8 × 8 block holding an edge), and leaving out colours the preview holds past
 * 0–1 (the test pattern's saturated cyan): a file can't hold them, and the encoder brings them
 * into range its own way.
 */
function compareInRange(played: Array<{ j: number; row: number[][] }>, file: number[][][]): { compared: number; points: number; worst: number } {
  let worst = 0
  let points = 0
  let compared = 0
  for (const { j, row } of played) {
    const fileRow = file[j]
    if (!fileRow) continue
    compared++
    for (let i = 4; i < row.length - 4; i++) {
      const flat = row.slice(i - 4, i + 5).every((p) => p.every((v, c) => Math.abs(v - row[i]![c]!) < 0.02))
      if (!flat || row[i]!.some((v) => v > 1.0005 || v < -0.0005)) continue
      points++
      worst = Math.max(worst, ...row[i]!.map((v, c) => Math.abs(v - fileRow[i]![c]!)))
    }
  }
  return { compared, points, worst }
}

async function exportRows(name: string): Promise<number[][][]> {
  const path = (await window.ginosa.snapshot.exportPath(name))!
  const result = await exporter.run(projectController.project!, SETTINGS, path)
  if (!result) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : `export ${exporter.state.kind}`)
  return (await window.ginosa.snapshot.analyseExport(path, XS))!.rows
}

/** Largest difference between two frames' rows, over the samples whose x passes `where`. */
function rowDiff(a: number[][], b: number[][], where: (x: number) => boolean = () => true): number {
  let worst = 0
  a.forEach((p, i) => {
    if (where(XS[i]!)) p.forEach((v, c) => (worst = Math.max(worst, Math.abs(v - b[i]![c]!))))
  })
  return worst
}

/** Mean difference between two frames' rows. */
function rowMean(a: number[][], b: number[][]): number {
  let sum = 0
  a.forEach((p, i) => p.forEach((v, c) => (sum += Math.abs(v - b[i]![c]!))))
  return sum / (a.length * 3)
}

/** Jumps to frames (out of order), comparing each with the export. */
async function jumps(file: number[][][], at: number[]) {
  player.temporal?.clear()
  const out: Array<{ frame: number; caughtUp: number; ms: number; worst: number }> = []
  for (const j of at) {
    timelineController.setPlayhead(j * FRAME)
    await player.settled()
    const row = await readRowBoxes(player.lastStill!, XS, ROW_Y)
    out.push({ frame: j, caughtUp: player.lastCatchUp?.frames ?? -1, ms: Math.round(player.lastCatchUp?.ms ?? 0), worst: round(compareInRange([{ j, row }], file).worst) })
  }
  return out
}

export async function datamoshExportTest() {
  const reasons: string[] = []
  const run = (command: Parameters<typeof projectController.dispatch>[0]) => {
    if (!projectController.dispatch(command)) throw new Error(`${command.label} failed: ${projectController.lastError}`)
  }
  const project = projectController.project!
  const [v1, v2, v3] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string, string]
  const footage = project.media.find((m) => m.name === 'testsrc_1080p24_h264')
  const square = project.media.find((m) => m.name === 'square_1080')
  if (!footage || !square) throw new Error('testsrc_1080p24_h264 or square_1080 is missing (npm run test-media)')
  const end = s(FRAMES / 25)

  // V1: the test pattern panning right 2 px a frame. V2: Datamosh (Momentum 50%) over it.
  run(placeMedia({ mediaId: footage.id, sourceIn: 0, sourceOut: end, at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const clip = projectController.project!.sequence.clips.find((c) => c.trackId === v1)!.id
  run(setAnimated({ clipId: clip, effectId: null, param: 'position' }, true, 0))
  run(setValue({ clipId: clip, effectId: null, param: 'position' }, [960, 540], 0))
  run(setValue({ clipId: clip, effectId: null, param: 'position' }, [960 + 2 * (FRAMES - 1), 540], end - FRAME))
  run(addAdjustmentLayer({ trackId: v2, start: 0, duration: end }))
  const layer = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  run(addEffect([layer], 'datamosh'))
  const effect = projectController.project!.sequence.clips.find((c) => c.id === layer)!.effects[0]!.id
  run(setEffectValues(layer, effect, { params: { momentum: 50 } }))

  // The footage alone, then moshed (twice).
  run(setEffectEnabled(layer, effect, false))
  const plain = await exportRows('mosh-off.mov')
  run(setEffectEnabled(layer, effect, true))
  const moshed = await exportRows('mosh.mov')
  const again = await exportRows('mosh-again.mov')
  if (moshed.length !== FRAMES || plain.length !== FRAMES || again.length !== FRAMES) reasons.push(`expected ${FRAMES} frames, found ${plain.length}, ${moshed.length} and ${again.length}`)
  const repeat = Math.max(...moshed.map((row, j) => rowDiff(row, again[j]!)))
  if (repeat !== 0) reasons.push(`two exports differ by up to ${repeat.toFixed(4)} (should be identical)`)
  const firstFrame = rowDiff(moshed[0]!, plain[0]!)
  if (!(firstFrame <= 0.003)) reasons.push(`the first frame isn't the footage (differs by ${firstFrame.toFixed(4)})`)
  const moshAmount = rowMean(moshed[FRAMES - 1]!, plain[FRAMES - 1]!)
  if (!(moshAmount > 0.02)) reasons.push(`the last frame is hardly moshed (mean difference from the footage ${moshAmount.toFixed(4)})`)

  // Real-time playback and jumps against the export.
  const played = await captured((FRAMES - 1) / 25)
  const playback = compareInRange(played, moshed)
  if (playback.compared < FRAMES * 0.9) reasons.push(`playback presented only ${playback.compared} of ${FRAMES} frames`)
  if (!(playback.worst <= 0.006)) reasons.push(`playback and export differ by up to ${playback.worst.toFixed(4)}`)
  const approximate = player.temporal?.stats.approximate ?? 0
  const scrubbed = await jumps(moshed, [80, 23, 99, 51, 6, 80])
  const scrubWorst = Math.max(...scrubbed.map((j) => j.worst))
  if (!(scrubWorst <= 0.006)) reasons.push(`a jump differs from the export by up to ${scrubWorst.toFixed(4)}`)
  const longest = Math.max(...scrubbed.slice(1).map((j) => j.caughtUp))
  if (longest > 25) reasons.push(`a jump replayed ${longest} frames (checkpoints every second should cap it at 25)`)

  // Motion transfer: a white square sliding right 3 px a frame on V3 (hidden) moves the picture instead.
  run(placeMedia({ mediaId: square.id, sourceIn: 0, sourceOut: end, at: 0, videoTrackId: v3, audioTrackId: null, mode: 'overwrite' }))
  const source = projectController.project!.sequence.clips.find((c) => c.trackId === v3)!.id
  run(setAnimated({ clipId: source, effectId: null, param: 'position' }, true, 0))
  run(setValue({ clipId: source, effectId: null, param: 'position' }, [760, 540], 0))
  run(setValue({ clipId: source, effectId: null, param: 'position' }, [760 + 3 * (FRAMES - 1), 540], end - FRAME))
  run(setTrackFlag(v3, 'visible', false))
  run(setEffectValues(layer, effect, { params: { motionSource: v3 } }))
  const transferred = await exportRows('mosh-transfer.mov')
  const transferFirst = rowDiff(transferred[0]!, plain[0]!)
  if (!(transferFirst <= 0.003)) reasons.push(`motion transfer: the first frame isn't the footage (differs by ${transferFirst.toFixed(4)}), so the hidden square shows`)
  // The square covers x 660–1157 over the frames; well away from it nothing moves the picture.
  const away = (x: number) => x < 560 || x > 1260
  const held = rowDiff(transferred[FRAMES - 1]!, plain[0]!, away)
  if (!(held <= 0.006)) reasons.push(`motion transfer: away from the square the last frame isn't frame 0 (differs by ${held.toFixed(4)})`)
  const panned = rowDiff(plain[FRAMES - 1]!, plain[0]!, away)
  if (!(panned > 0.1)) reasons.push(`the footage barely changes over ${FRAMES} frames (${panned.toFixed(3)}), so holding frame 0 proves nothing`)
  // Where the square's edges passed, their motion pushed the picture's (vertical) bars sideways.
  const pushed = rowDiff(transferred[FRAMES - 1]!, plain[0]!, (x) => x >= 700 && x < 1100)
  if (!(pushed > 0.05)) reasons.push(`motion transfer: where the square passed, the picture didn't move (${pushed.toFixed(4)})`)
  const transferPlay = compareInRange(await captured((FRAMES - 1) / 25), transferred)
  if (transferPlay.compared < FRAMES * 0.9) reasons.push(`motion transfer: playback presented only ${transferPlay.compared} of ${FRAMES} frames`)
  if (!(transferPlay.worst <= 0.006)) reasons.push(`motion transfer: playback and export differ by up to ${transferPlay.worst.toFixed(4)}`)
  const transferJumps = await jumps(transferred, [90, 40, 70])
  const transferJumpWorst = Math.max(...transferJumps.map((j) => j.worst))
  if (!(transferJumpWorst <= 0.006)) reasons.push(`motion transfer: a jump differs from the export by up to ${transferJumpWorst.toFixed(4)}`)

  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    export: { frames: moshed.length, repeatDifference: repeat, firstFrameVsFootage: round(firstFrame), lastFrameMeanVsFootage: round(moshAmount) },
    playbackVsExport: { framesCompared: playback.compared, points: playback.points, worst: round(playback.worst), approximateFrames: approximate },
    jumps: scrubbed,
    motionTransfer: { firstFrameVsFootage: round(transferFirst), awayFromSquareVsFrame0: round(held), footagePanAway: round(panned), whereTheSquarePassed: round(pushed), playback: { framesCompared: transferPlay.compared, worst: round(transferPlay.worst) }, jumps: transferJumps },
    stateMemoryMB: Math.round((player.temporal?.bytes() ?? 0) / 1e6)
  }
}

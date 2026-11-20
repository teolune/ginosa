import { bakeKey, bakeStore } from '@engine/datamosh/bakes'
import type { ExportSettings } from '@engine/export/export-settings'
import { setTrackFlag } from '@engine/project/commands'
import { FRAME_RATES, secondsToTicks, ticksPerFrame } from '@engine/time'
import { addAdjustmentLayer, addEffect, setEffectEnabled, setEffectValues } from '@engine/timeline/effect-edits'
import { addMarker, placeMedia } from '@engine/timeline/edits'
import { setAnimated, setValue } from '@engine/timeline/keyframe-edits'
import { addRackRows, setRackCubes } from '@engine/timeline/rack-edits'
import { videoLayersAt } from '@engine/timeline/render-plan'
import { modulationController } from '../audio/modulation-controller'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { bakeController } from './bake-controller'
import { readRowBoxes } from './colour-probe'
import { exporter } from './exporter'
import { capturePlayback } from './playback-capture'
import { player } from './player'

/**
 * M15 "done when": bakes play on the timeline and re-bake on change. Datamosh Bake on an
 * adjustment layer over two shots, the test pattern (panning 2 px a frame) for 2 s, then the
 * frame counter for 2 s:
 *  - FFglitch is there (set up here if it isn't: the same download as npm run ffglitch-setup);
 *  - the live look (Datamosh) shows until the bake is ready, then the bake's frames;
 *  - before the cut the bake is the footage (through the codec); after it, the cut's keyframe is
 *    gone, so the old shot holds on, pushed only by the new one's (almost still) motion and its
 *    changing digits: the melt;
 *  - the export, real-time playback and jumps all show the bake;
 *  - Push X re-bakes (the live look meanwhile), and the picture slides right; undo finds the
 *    first bake ready without baking again;
 *  - every vector tool and every kind of moment together bake, and a clip's own bake (32 px
 *    blocks) is made at the clip's size.
 */

const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const FRAMES = 100
const CUT = 50
const XS = Array.from({ length: 960 }, (_, i) => i * 2)
const ROW_Y = 538
const SETTINGS: ExportSettings = { format: 'prores-4444', container: 'mov', bitrateMbps: 40, keyframeSeconds: 1 }
const round = (v: number) => Math.round(v * 10000) / 10000

async function exportRows(name: string): Promise<number[][][]> {
  const path = (await window.ginosa.snapshot.exportPath(name))!
  const result = await exporter.run(projectController.project!, SETTINGS, path)
  if (!result) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : `export ${exporter.state.kind}`)
  return (await window.ginosa.snapshot.analyseExport(path, XS))!.rows
}

async function fileRows(path: string): Promise<number[][][]> {
  return (await window.ginosa.snapshot.analyseExport(path, XS))?.rows ?? []
}

function rowMean(a: number[][], b: number[][]): number {
  let sum = 0
  a.forEach((p, i) => p.forEach((v, c) => (sum += Math.abs(v - b[i]![c]!))))
  return sum / (a.length * 3)
}

/** Where `b` matches `a` best, moved by whole samples (2 px each): the shift in pixels (+: `b` is further right). */
function bestShift(a: number[][], b: number[][], most = 120): number {
  let best = 0
  let bestError = Infinity
  for (let k = -most; k <= most; k++) {
    let sum = 0
    let n = 0
    for (let i = Math.max(0, -k) + 20; i < Math.min(a.length, a.length - k) - 20; i++) {
      for (let c = 0; c < 3; c++) sum += Math.abs(a[i]![c]! - b[i + k]![c]!)
      n++
    }
    if (n > 200 && sum / n < bestError) {
      bestError = sum / n
      best = k
    }
  }
  return best * 2
}

/** Preview rows against a file's where the preview is flat (a mosh is full of block edges a DCT rings at), as M14's test does. */
function compareFlat(played: Array<{ j: number; row: number[][] }>, file: number[][][]): { compared: number; worst: number; mean: number } {
  let worst = 0
  let sum = 0
  let points = 0
  let compared = 0
  for (const { j, row } of played) {
    const fileRow = file[j]
    if (!fileRow) continue
    compared++
    for (let i = 4; i < row.length - 4; i++) {
      const flat = row.slice(i - 4, i + 5).every((p) => p.every((v, c) => Math.abs(v - row[i]![c]!) < 0.02))
      if (!flat || row[i]!.some((v) => v > 1.0005 || v < -0.0005)) continue
      const d = Math.max(...row[i]!.map((v, c) => Math.abs(v - fileRow[i]![c]!)))
      worst = Math.max(worst, d)
      sum += d
      points++
    }
  }
  return { compared, worst, mean: points ? sum / points : 0 }
}

export async function datamoshBakeTest() {
  const reasons: string[] = []
  const run = (command: Parameters<typeof projectController.dispatch>[0]) => {
    if (!projectController.dispatch(command)) throw new Error(`${command.label} failed: ${projectController.lastError}`)
  }
  bakeController.automatic = true

  // FFglitch: set up here if it isn't yet.
  const setup: string[] = []
  let status = await window.ginosa.bake.status()
  if (!status.ready) {
    const code = await bakeController.setUp((line) => setup.push(line))
    status = await window.ginosa.bake.status()
    if (!status.ready) return { verdict: 'fail', reasons: [`FFglitch didn't set up (exit code ${code})`], setup: setup.slice(-12) }
  }

  const project = projectController.project!
  const [v1, v2, v3] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string, string]
  const pattern = project.media.find((m) => m.name === 'testsrc_1080p24_h264')
  const counter = project.media.find((m) => m.name === 'framecode_h264')
  if (!pattern || !counter) throw new Error('testsrc_1080p24_h264 or framecode_h264 is missing (npm run test-media)')

  // V1: the test pattern panning right 2 px a frame, then the frame counter. V2: Datamosh Bake over both.
  run(placeMedia({ mediaId: pattern.id, sourceIn: 0, sourceOut: s(2), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  run(placeMedia({ mediaId: counter.id, sourceIn: 0, sourceOut: s(2), at: s(2), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const first = projectController.project!.sequence.clips.find((c) => c.trackId === v1 && c.start === 0)!.id
  run(setAnimated({ clipId: first, effectId: null, param: 'position' }, true, 0))
  run(setValue({ clipId: first, effectId: null, param: 'position' }, [960, 540], 0))
  run(setValue({ clipId: first, effectId: null, param: 'position' }, [960 + 2 * (CUT - 1), 540], s(2) - FRAME))
  run(addAdjustmentLayer({ trackId: v2, start: 0, duration: s(4) }))
  const layer = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  const layerClip = () => projectController.project!.sequence.clips.find((c) => c.id === layer)!
  const shownAt = (j: number) => videoLayersAt(projectController.project!.sequence, projectController.project!.media, j * FRAME, modulationController.context).find((l) => l.clip.adjustment)!.clip.effects[0]!
  const keyNow = () => bakeKey(projectController.project!.sequence, projectController.project!.media, modulationController.context, layerClip(), effect)

  // The footage alone (the effect off), for comparing.
  run(addEffect([layer], 'datamosh-bake'))
  const effect = layerClip().effects[0]!.id
  run(setEffectEnabled(layer, effect, false))
  const plain = await exportRows('bake-off.mov')
  run(setEffectEnabled(layer, effect, true))
  const liveFirst = shownAt(10).effectId
  if (liveFirst !== 'datamosh') reasons.push(`before its bake, the effect showed ${liveFirst}, not the live look (datamosh)`)

  const started = performance.now()
  await bakeController.idle()
  const firstBakeSeconds = (performance.now() - started) / 1000
  const state1 = bakeController.stateOf(layerClip(), effect)
  if (state1.kind !== 'ready') return { verdict: 'fail', reasons: [...reasons, `the bake isn't ready: ${JSON.stringify(state1)}`], setup: setup.slice(-6) }
  const key1 = keyNow()
  const bake1 = bakeStore.get(key1)!
  if (shownAt(10).effectId !== 'datamosh-bake') reasons.push(`with the bake ready, the effect shows ${shownAt(10).effectId}`)
  const bakeRows = await fileRows(bake1.path)
  if (bakeRows.length !== FRAMES) reasons.push(`the bake has ${bakeRows.length} frames, not ${FRAMES}`)

  // Before the cut, the footage through the codec; after it, the melt.
  const beforeFrames = [0, 1, 10, 20, 30, CUT - 1]
  const beforeEach = beforeFrames.map((j) => round(rowMean(bakeRows[j]!, plain[j]!)))
  const signed = [0, 1, 2].map((c) => round(bakeRows[1]!.reduce((n, p, i) => n + p[c]! - plain[1]![i]![c]!, 0) / bakeRows[1]!.length))
  const beforeCut = Math.max(...beforeEach)
  // The codec's own loss (4:2:0 colour, quantising: the test pattern is all sharp coloured edges), the same on every frame: no drift.
  if (!(beforeCut < 0.06)) reasons.push(`before the cut the bake isn't the footage (mean difference up to ${beforeCut.toFixed(4)})`)
  const drift = beforeCut - Math.min(...beforeEach)
  if (!(drift < 0.01)) reasons.push(`before the cut the bake drifts from the footage (${beforeEach.join(', ')})`)
  const after = CUT + 5
  // Where the counter's bars didn't change since the cut: a clean cut would show them; the melt keeps the old shot there.
  const still = XS.map((_, i) => plain[CUT]![i]!.every((v, c) => Math.abs(v - plain[after]![i]![c]!) < 0.02))
  const masked = (a: number[][], b: number[][]) => {
    let sum = 0
    let n = 0
    a.forEach((p, i) => {
      if (!still[i]) return
      p.forEach((v, c) => (sum += Math.abs(v - b[i]![c]!)))
      n += 3
    })
    return n ? sum / n : NaN
  }
  const fromNewShot = masked(bakeRows[after]!, plain[after]!)
  const fromOldShot = masked(bakeRows[after]!, plain[CUT - 1]!)
  const stillShare = still.filter(Boolean).length / still.length
  if (!(stillShare > 0.3 && fromNewShot > 0.1 && fromOldShot < fromNewShot / 3)) reasons.push(`no melt: 5 frames after the cut, where the new shot didn't change (${Math.round(stillShare * 100)}% of the row), the bake differs from it by ${fromNewShot.toFixed(4)} and from the old shot by ${fromOldShot.toFixed(4)}`)

  // The export shows the bake.
  const baked = await exportRows('bake.mov')
  const exportVsBake = Math.max(...[5, CUT - 1, after, FRAMES - 1].map((j) => rowMean(baked[j]!, bakeRows[j]!)))
  if (!(exportVsBake < 0.01)) reasons.push(`the export isn't the bake (mean difference up to ${exportVsBake.toFixed(4)})`)

  // Real-time playback and jumps show it too.
  const played = await capturePlayback(XS, ROW_Y, FRAMES, (FRAMES - 1) / 25)
  const playback = compareFlat(played, baked)
  if (playback.compared < FRAMES * 0.9) reasons.push(`playback presented only ${playback.compared} of ${FRAMES} frames`)
  if (!(playback.mean <= 0.004 && playback.worst <= 0.03)) reasons.push(`playback and the export differ (mean ${playback.mean.toFixed(4)}, worst ${playback.worst.toFixed(4)})`)
  const jumps: Array<{ frame: number; mean: number }> = []
  for (const j of [after, 12, 90]) {
    timelineController.setPlayhead(j * FRAME)
    await player.settled()
    const row = await readRowBoxes(player.lastStill!, XS, ROW_Y)
    jumps.push({ frame: j, mean: round(rowMean(row, baked[j]!)) })
  }
  const jumpWorst = Math.max(...jumps.map((j) => j.mean))
  if (!(jumpWorst < 0.01)) reasons.push(`a paused frame isn't the export's (mean difference up to ${jumpWorst.toFixed(4)})`)

  // A change re-bakes: the live look at once, then the new bake. Push X: the picture slides right.
  const made = bakeController.made
  run(setEffectValues(layer, effect, { params: { pushX: 3 } }))
  const liveAfterChange = shownAt(10).effectId
  if (liveAfterChange !== 'datamosh') reasons.push(`straight after a change the effect showed ${liveAfterChange}, not the live look`)
  await bakeController.idle()
  const key2 = keyNow()
  const bake2 = bakeStore.get(key2)
  if (!bake2 || key2 === key1 || bakeController.made !== made + 1) reasons.push(`Push X didn't make a new bake (made ${bakeController.made - made})`)
  const pushedRows = bake2 ? await fileRows(bake2.path) : []
  // The picture slides right, further every frame (the footage's own residual keeps pulling its detail back, so less than 3 px a frame here; the still below measures it exactly).
  const shifts = pushedRows.length ? [5, 10, 15, 20, 30, 45].map((j) => ({ frame: j, px: bestShift(bakeRows[j]!, pushedRows[j]!) })) : []
  if (!(shifts.length && shifts.every((x, i) => x.px > 0 && (i === 0 || x.px >= shifts[i - 1]!.px)))) reasons.push(`Push X didn't slide the picture right, more each frame: ${JSON.stringify(shifts)}`)
  run(setEffectValues(layer, effect, { params: { pushX: 0 } }))
  const afterUndo = keyNow()
  await bakeController.idle()
  if (afterUndo !== key1 || bakeController.made !== made + 1 || shownAt(10).effectId !== 'datamosh-bake') reasons.push('going back to the first settings didn’t find the first bake ready')

  // Everything at once: the vector tools, a motion source, and every kind of moment.
  run(placeMedia({ mediaId: pattern.id, sourceIn: s(2), sourceOut: s(6), at: 0, videoTrackId: v3, audioTrackId: null, mode: 'overwrite' }))
  run(setTrackFlag(v3, 'visible', false))
  const rows = addRackRows([{ name: 'Kick' }])
  run(rows)
  const section = projectController.project!.sequence.rack.sections[0]!.id
  run(setRackCubes(section, rows.rowIds[0]!, [0, 8, 16, 24], true))
  run(addMarker(s(1)))
  run(setEffectValues(layer, effect, { params: { scale: 150, rotate: 20, swirl: 30, fluid: 50, wrongGuesses: 15, motionSource: v3, channel: rows.rowIds[0]!, channelAction: 'bloom', every: 'bar', everyAction: 'heal', markers: 'bloom', cuts: 'meltBloom', bloomFrames: 4, healAfter: 20, quality: 'rough' } }))
  const allStarted = performance.now()
  await bakeController.idle()
  const allSeconds = (performance.now() - allStarted) / 1000
  const stateAll = bakeController.stateOf(layerClip(), effect)
  const bakeAll = bakeStore.get(keyNow())
  const allRows = bakeAll ? await fileRows(bakeAll.path) : []
  if (stateAll.kind !== 'ready' || allRows.length !== FRAMES) reasons.push(`with everything on, the bake isn't ready: ${JSON.stringify(stateAll)} (${allRows.length} frames)`)
  const allChange = allRows.length ? rowMean(allRows[30]!, bakeRows[30]!) : 0
  if (!(allChange > 0.02)) reasons.push(`with everything on, frame 30 hardly changed (${allChange.toFixed(4)})`)

  // A clip's own bake, with 32 px blocks: made at the clip's size, as long as the clip.
  run(addEffect([first], 'datamosh-bake'))
  const clipEffect = projectController.project!.sequence.clips.find((c) => c.id === first)!.effects[0]!.id
  run(setEffectValues(first, clipEffect, { params: { blockSize: '32', pushY: -2 } }))
  await bakeController.idle()
  const clipNow = projectController.project!.sequence.clips.find((c) => c.id === first)!
  const clipBake = bakeStore.get(bakeKey(projectController.project!.sequence, projectController.project!.media, modulationController.context, clipNow, clipEffect))
  const clipVideo = clipBake?.item.info.video
  if (!clipBake || clipBake.frames !== CUT || clipVideo?.width !== 1920 || clipVideo?.height !== 1080) reasons.push(`the clip's bake: ${clipBake ? `${clipBake.frames} frames, ${clipVideo?.width}×${clipVideo?.height}` : bakeController.stateOf(clipNow, clipEffect).kind}`)

  // A still (no motion, nothing to correct): Push X 3 px moves it exactly 3 px a frame, to the right.
  const square = projectController.project!.media.find((m) => m.name === 'square_1080')
  let stillPush: { leftEdge: number[]; perFrame: number } | null = null
  let transfer: { leftEdge: number[]; perFrame: number; notes: string[] } | null = null
  if (square) {
    run(placeMedia({ mediaId: square.id, sourceIn: 0, sourceOut: s(1), at: s(5), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
    const sq = projectController.project!.sequence.clips.find((c) => c.mediaId === square.id && c.trackId === v1)!.id
    run(addEffect([sq], 'datamosh-bake'))
    const sqEffect = projectController.project!.sequence.clips.find((c) => c.id === sq)!.effects[0]!.id
    run(setEffectValues(sq, sqEffect, { params: { pushX: 3 } }))
    await bakeController.idle()
    const sqClip = projectController.project!.sequence.clips.find((c) => c.id === sq)!
    const sqBake = bakeStore.get(bakeKey(projectController.project!.sequence, projectController.project!.media, modulationController.context, sqClip, sqEffect))
    const sqRows = sqBake ? await fileRows(sqBake.path) : []
    const width = sqBake?.item.info.video?.width ?? 1920
    // The bake is the still's own size; the rows were read across 1920 px of it.
    const edge = (row: number[][]) => XS.findIndex((x, i) => x < width && row[i]!.reduce((a, b) => a + b, 0) / 3 > 0.5)
    const leftEdge = [0, 5, 10, 15].map((j) => (sqRows[j] ? XS[edge(sqRows[j]!)] ?? -1 : -1))
    stillPush = { leftEdge, perFrame: round((leftEdge[3]! - leftEdge[0]!) / 15) }
    if (!(stillPush.perFrame >= 2.5 && stillPush.perFrame <= 3.5)) reasons.push(`Push X 3 px moved a still ${stillPush.perFrame} px a frame (left edge ${leftEdge.join(' → ')})`)

    // Motion transfer: the same square sliding right 4 px a frame on V3 (hidden) moves the still one by its real vectors
    // (an encoder finds motion only where there's an edge to follow, so the source's edge and the still's start together).
    run(placeMedia({ mediaId: square.id, sourceIn: 0, sourceOut: s(1), at: s(5), videoTrackId: v3, audioTrackId: null, mode: 'overwrite' }))
    const mover = projectController.project!.sequence.clips.find((c) => c.trackId === v3 && c.start === s(5))!.id
    run(setAnimated({ clipId: mover, effectId: null, param: 'position' }, true, s(5)))
    run(setValue({ clipId: mover, effectId: null, param: 'position' }, [960, 540], s(5)))
    run(setValue({ clipId: mover, effectId: null, param: 'position' }, [960 + 4 * 24, 540], s(6) - FRAME))
    run(setEffectValues(sq, sqEffect, { params: { pushX: 0, motionSource: v3 } }))
    await bakeController.idle()
    const moved = projectController.project!.sequence.clips.find((c) => c.id === sq)!
    const movedBake = bakeStore.get(bakeKey(projectController.project!.sequence, projectController.project!.media, modulationController.context, moved, sqEffect))
    const movedRows = movedBake ? await fileRows(movedBake.path) : []
    const movedEdge = [0, 5, 10, 15].map((j) => (movedRows[j] ? XS[edge(movedRows[j]!)] ?? -1 : -1))
    transfer = { leftEdge: movedEdge, perFrame: round((movedEdge[3]! - movedEdge[0]!) / 15), notes: movedBake ? bakeController.notes.get(movedBake.key) ?? [] : [] }
    if (!(transfer.perFrame >= 2.5 && transfer.perFrame <= 5.5)) reasons.push(`motion transfer moved the still ${transfer.perFrame} px a frame (left edge ${movedEdge.join(' → ')}; about 4 expected)`)
  } else reasons.push('square_1080 is missing (npm run test-media)')

  workspaceController()
  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    ffglitch: status.version,
    setup: setup.slice(-4),
    firstBakeSeconds: Math.round(firstBakeSeconds * 10) / 10,
    beforeCut: { frames: beforeFrames, meanVsFootage: beforeEach, frame1SignedRGB: signed },
    melt: { stillShare: round(stillShare), fiveAfterCutVsNewShot: round(fromNewShot), fiveAfterCutVsOldShot: round(fromOldShot) },
    exportVsBake: round(exportVsBake),
    playback: { framesCompared: playback.compared, mean: round(playback.mean), worst: round(playback.worst) },
    jumps,
    pushX3: { onFootage: shifts, onStill: stillPush },
    motionTransferOnStill: transfer,
    everythingOn: { seconds: Math.round(allSeconds * 10) / 10, frame30VsFirstBake: round(allChange) },
    clipBake: clipBake ? { frames: clipBake.frames, width: clipVideo?.width, height: clipVideo?.height } : null
  }
}

/** Effect Controls on the adjustment layer for the screenshot. */
function workspaceController(): void {
  const layer = projectController.project!.sequence.clips.find((c) => c.adjustment)
  if (layer) timelineController.select([layer.id], 'replace')
}

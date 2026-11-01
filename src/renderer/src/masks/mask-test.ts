import type { ExportSettings } from '@engine/export/export-settings'
import { shapeValueAt } from '@engine/masks/masks'
import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '@engine/time'
import { addAdjustmentLayer, addEffect } from '@engine/timeline/effect-edits'
import { placeMedia } from '@engine/timeline/edits'
import { addMaskTo, addShape, setShapeAnimated, setShapeMode, setShapeValues } from '@engine/timeline/mask-edits'
import { exporter } from '../playback/exporter'
import { capturePlayback, comparePlayback } from '../playback/playback-capture'
import { projectController } from '../state/project-controller'

/**
 * M9 masks end to end: an adjustment layer inverts the frame within an edge mask whose
 * Width is keyframed from 40 px to 440 px over 8 s, minus a 120 px tall rectangle sliding
 * down through the measured row. Exported (ProRes 4444), every frame's inverted band is
 * measured against the keyframed width, and real-time playback is compared with the file.
 */

const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const XS = Array.from({ length: 960 }, (_, i) => i * 2)
const ROW_Y = 538

/** Where the bright band from the left edge ends, and where the one from the right starts (frame pixels; 50% crossings). */
function band(row: number[][]): { left: number; right: number } | null {
  const g = row.map((rgb) => rgb[1]!)
  const i = g.findIndex((v) => v < 0.5)
  let k = g.length - 1
  while (k > 0 && g[k]! >= 0.5) k--
  if (i <= 0 || k >= g.length - 1) return null
  const cross = (a: number, b: number) => XS[a]! + ((0.5 - g[a]!) / (g[b]! - g[a]!)) * (XS[b]! - XS[a]!) + 0.5
  return { left: cross(i - 1, i), right: cross(k, k + 1) }
}

export async function maskTest() {
  const project = projectController.project!
  const [v1, v2] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const run = (command: Parameters<typeof projectController.dispatch>[0]) => {
    if (!projectController.dispatch(command)) throw new Error(`${command.label} failed: ${projectController.lastError}`)
    return command
  }
  const square = projectController.project!.media.find((m) => m.name === 'square_1080')
  if (!square) throw new Error('square_1080 is missing (npm run test-media)')
  run(placeMedia({ mediaId: square.id, sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: v1!, audioTrackId: null, mode: 'overwrite' }))
  run(addAdjustmentLayer({ trackId: v2!, start: 0, duration: s(8) }))
  const layer = () => projectController.project!.sequence.clips.find((c) => c.adjustment)!
  run(addEffect([layer().id], 'invert'))
  // The layer's own mask: an edge whose width is keyframed.
  const made = run(addMaskTo(layer().id, null, 'edge')) as ReturnType<typeof addMaskTo>
  const { maskId, shapeId } = made
  run(setShapeValues(maskId, shapeId, { feather: 0, width: 40 }, 0))
  run(setShapeAnimated({ maskId, shapeId, param: 'width' }, true, 0))
  run(setShapeValues(maskId, shapeId, { width: 440 }, s(7.96)))
  // Minus a rectangle sliding down through the measured row (it hides the band while it passes).
  const box = run(addShape(maskId, 'rectangle')) as ReturnType<typeof addShape>
  run(setShapeMode(maskId, box.shapeId, 'subtract'))
  run(setShapeValues(maskId, box.shapeId, { size: [1920, 120], feather: 0, position: [960, -200] }, 0))
  run(setShapeAnimated({ maskId, shapeId: box.shapeId, param: 'position' }, true, 0))
  run(setShapeValues(maskId, box.shapeId, { position: [960, 1280] }, s(7.96)))

  const settings: ExportSettings = { format: 'prores-4444', container: 'mov', bitrateMbps: 40, keyframeSeconds: 1 }
  const path = (await window.ginosa.snapshot.exportPath('masks.mov'))!
  const result = await exporter.run(projectController.project!, settings, path)
  if (!result) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : `export ${exporter.state.kind}`)
  const a = (await window.ginosa.snapshot.analyseExport(path, XS))!
  const frames = a.rows.length
  const reasons: string[] = []
  if (frames !== 200) reasons.push(`expected 200 frames, found ${frames}`)

  const mask = () => projectController.project!.sequence.masks.find((m) => m.id === maskId)!
  let worst = 0
  let hidden = 0
  let measured = 0
  const examples: string[] = []
  for (let j = 0; j < frames; j++) {
    const t = j * FRAME
    const width = Number(shapeValueAt(mask().shapes[0]!, 'width', t))
    const [, y] = shapeValueAt(mask().shapes[1]!, 'position', t) as [number, number]
    // The row's 4 pixels (538–541) are inside the box: no band at all.
    const covered = ROW_Y >= y - 60 && ROW_Y + 4 <= y + 60
    const got = band(a.rows[j]!)
    if (covered) {
      if (got) {
        worst = Infinity
        if (examples.length < 4) examples.push(`frame ${j}: a band where the rectangle should hide it`)
      } else hidden++
      continue
    }
    // Near the rectangle's own edges the row straddles it; skip those frames.
    if (Math.abs(ROW_Y - (y - 60)) < 6 || Math.abs(ROW_Y + 4 - (y + 60)) < 6) continue
    if (!got) {
      worst = Infinity
      if (examples.length < 4) examples.push(`frame ${j}: no band`)
      continue
    }
    measured++
    const e = Math.max(Math.abs(got.left - width), Math.abs(got.right - (1920 - width)))
    if (e > 1 && examples.length < 4) examples.push(`frame ${j}: band ${got.left.toFixed(1)} / ${got.right.toFixed(1)} vs width ${width.toFixed(1)}`)
    worst = Math.max(worst, e)
  }
  if (!(worst <= 1)) reasons.push(`the band edges are up to ${worst.toFixed(2)} px from the keyframed width`)
  if (hidden < 3) reasons.push(`the sliding rectangle hid the band in only ${hidden} frames`)

  const played = await capturePlayback(XS, ROW_Y, frames, 7.96)
  const playback = comparePlayback(played, a.rows)
  if (playback.compared < frames * 0.9) reasons.push(`playback presented only ${playback.compared} of ${frames} frames`)
  if (!(playback.worst <= 0.006)) reasons.push(`playback and export differ by up to ${playback.worst.toFixed(4)} (limit 0.006)`)
  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    exportVsKeyframes: { frames, measured, hiddenByRectangle: hidden, worstPx: Math.round(worst * 100) / 100, examples },
    playbackVsExport: { framesCompared: playback.compared, points: playback.points, worst: Math.round(playback.worst * 10000) / 10000 }
  }
}

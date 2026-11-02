import type { ExportSettings } from '@engine/export/export-settings'
import type { ParamValue } from '@engine/effects/types'
import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '@engine/time'
import { placeMedia } from '@engine/timeline/edits'
import { addEffect, setEffectValues } from '@engine/timeline/effect-edits'
import { trimClips } from '@engine/timeline/edits'
import { clockAt } from '@engine/timeline/render-plan'
import { grainReference } from '../../../effects/grain/reference'
import { effectById } from '../../../effects/registry'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { readPixels } from './colour-probe'
import { exporter } from './exporter'
import { player } from './player'

/**
 * M11 end to end: Grain on an adjustment layer over the colour patches (so its pixels are
 * the sequence's; on a clip it works in the clip's own pixels), exported as ProRes 4444 (4:4:4, 12-bit,
 * read back with FFmpeg) and played, against the CPU maths frame by frame.
 *  - The preview is compared pixel by pixel, and frames sharing a refresh must be identical.
 *  - The file's 3 × 4-pixel boxes are compared with the same boxes worked out on the CPU.
 *    ProRes is lossy and grain is the hardest thing to compress (even two identical frames
 *    come out a little different), so the file is held to being the same grain: its
 *    deviations from the plain patches correlate with the CPU's, with a small RMS error.
 */

type Rgb = [number, number, number]
const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const XS = [192, 576, 960, 1344, 1728]
const ROWS = [538, 539, 540, 541]
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (v: number) => Math.round(v * 10000) / 10000

export async function grainExportTest() {
  const project = projectController.project!
  const [v1, v2] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string]
  const patches = project.media.find((m) => m.name === 'patches_rec709')
  if (!patches) throw new Error('patches_rec709 is missing (npm run test-media)')
  projectController.dispatch(placeMedia({ mediaId: patches.id, sourceIn: 0, sourceOut: s(2), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const clipId = projectController.project!.sequence.clips.find((c) => c.kind === 'video')!.id
  player.setResolution(1)
  const readAt = async (frame: number, points: Array<[number, number]>) => {
    timelineController.setPlayhead(frame * FRAME)
    await wait(900)
    return player.lastStill ? await readPixels(player.lastStill, points) : []
  }
  // The patches without grain (flat, so one pixel each).
  const under = (await readAt(12, XS.map((x) => [x, 540]))) as Rgb[]

  timelineController.newAdjustmentLayer(v2, 0)
  const layerId = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  projectController.dispatch(trimClips({ clipIds: [layerId], edge: 'out', delta: s(2) - projectController.project!.sequence.clips.find((c) => c.id === layerId)!.duration }))
  projectController.dispatch(addEffect([layerId], 'grain'))
  const effectId = projectController.project!.sequence.clips.find((c) => c.id === layerId)!.effects[0]!.id
  const params: Record<string, ParamValue> = { amount: 45, size: 2, softness: 30, colourAmount: 60, blueSize: 150, refresh: 'frames', every: 2, boil: 70, shadows: 100, midtones: 100, highlights: 80 }
  projectController.dispatch(setEffectValues(layerId, effectId, { params }))
  const all = { ...(Object.fromEntries(effectById('grain')!.params.map((p) => [p.id, p.default])) as Record<string, ParamValue>), ...params }
  const sequence = projectController.project!.sequence
  const size = { width: 1920, height: 1080 }
  const expectedBox = (frame: number): Rgb[] => {
    const r = grainReference(size, all, clockAt(sequence, frame * FRAME))
    return XS.map((x, i) => {
      const sum = [0, 0, 0]
      for (const y of ROWS) for (let dx = -1; dx <= 1; dx++) r.output(x + dx, y, under[i]!).forEach((v, k) => (sum[k] = sum[k]! + Math.min(1, Math.max(0, v))))
      return sum.map((v) => v / 12) as Rgb
    })
  }

  const settings: ExportSettings = { format: 'prores-4444', container: 'mov', bitrateMbps: 40, keyframeSeconds: 1 }
  const path = (await window.ginosa.snapshot.exportPath('grain.mov'))!
  const result = await exporter.run(projectController.project!, settings, path)
  if (!result) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : `export ${exporter.state.kind}`)
  const rows = (await window.ginosa.snapshot.analyseExport(path, XS))!.rows
  const reasons: string[] = []
  if (rows.length !== 50) reasons.push(`expected 50 frames, found ${rows.length}`)
  let worst = 0
  let where = ''
  let squares = 0
  const file: number[] = []
  const cpu: number[] = []
  for (let j = 0; j < rows.length; j++) {
    const want = expectedBox(j)
    rows[j]!.forEach((got, i) =>
      got.forEach((v, k) => {
        const e = Math.abs(v - want[i]![k]!)
        squares += e * e
        file.push(v - under[i]![k]!)
        cpu.push(want[i]![k]! - under[i]![k]!)
        if (e > worst) (worst = e), (where = `frame ${j}, patch ${i}, channel ${k}: ${v.toFixed(4)} vs ${want[i]![k]!.toFixed(4)}`)
      })
    )
  }
  const rms = Math.sqrt(squares / Math.max(1, file.length))
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
  const mf = mean(file)
  const mc = mean(cpu)
  const correlation = file.reduce((a, v, i) => a + (v - mf) * (cpu[i]! - mc), 0) / Math.sqrt(file.reduce((a, v) => a + (v - mf) ** 2, 0) * cpu.reduce((a, v) => a + (v - mc) ** 2, 0))
  if (!(correlation >= 0.97)) reasons.push(`the file's grain correlates ${correlation.toFixed(3)} with the CPU's (expected at least 0.97)`)
  if (!(rms <= 0.006)) reasons.push(`the file is ${rms.toFixed(4)} RMS from the CPU maths`)
  if (!(worst <= 0.03)) reasons.push(`the file is up to ${worst.toFixed(4)} from the CPU maths (${where})`)
  // Refresh every 2 frames: frames 10 and 11 share a pattern, 11 and 12 don't.
  const diff = (a: number, b: number) => Math.max(...rows[a]!.flatMap((p, i) => p.map((v, k) => Math.abs(v - rows[b]![i]![k]!))))
  const pair = diff(10, 11)
  const next = diff(11, 12)
  if (!(pair < next / 5)) reasons.push(`in the file, frames 10 and 11 (one pattern) differ by ${pair.toFixed(4)}, not much less than 11 and 12 (${next.toFixed(4)})`)
  // The preview, pixel by pixel, on two frames.
  let previewWorst = 0
  for (const frame of [11, 37]) {
    const points: Array<[number, number]> = XS.flatMap((x) => [[x, 540], [x + 3, 520]] as Array<[number, number]>)
    const got = await readAt(frame, points)
    const r = grainReference(size, all, clockAt(sequence, frame * FRAME))
    points.forEach(([x, y], i) => r.output(x, y, under[Math.floor(i / 2)]!).forEach((v, k) => (previewWorst = Math.max(previewWorst, Math.abs(got[i]![k]! - v)))))
  }
  if (!(previewWorst <= 0.004)) reasons.push(`preview off the CPU maths by ${previewWorst.toFixed(4)}`)
  const strip = XS.map((x) => [x, 540] as [number, number])
  const [p10, p11, p12] = [await readAt(10, strip), await readAt(11, strip), await readAt(12, strip)]
  const previewPair = Math.max(...p10.flatMap((p, i) => p.map((v, k) => Math.abs(v - p11[i]![k]!))))
  const previewNext = Math.max(...p11.flatMap((p, i) => p.map((v, k) => Math.abs(v - p12[i]![k]!))))
  if (previewPair !== 0) reasons.push(`preview frames 10 and 11 (one pattern) differ by ${previewPair.toFixed(4)}`)
  if (!(previewNext > 0.01)) reasons.push(`preview frames 11 and 12 should differ but only by ${previewNext.toFixed(4)}`)
  timelineController.select([layerId], 'replace')
  timelineController.setPlayhead(37 * FRAME)
  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    frames: rows.length,
    preview: { error: round(previewWorst), sameRefresh: round(previewPair), nextRefresh: round(previewNext) },
    file: { correlation: Math.round(correlation * 10000) / 10000, rms: round(rms), worst: round(worst), worstAt: where, sameRefresh: round(pair), nextRefresh: round(next) }
  }
}

import { parseCube } from '@engine/colour/cube'
import { lookReference, unitCube } from '@engine/colour/look-lut'
import type { ExportSettings } from '@engine/export/export-settings'
import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '@engine/time'
import { placeMedia, trimClips } from '@engine/timeline/edits'
import { addEffect, setEffectValues } from '@engine/timeline/effect-edits'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { readPixels } from './colour-probe'
import { exporter } from './exporter'
import { player } from './player'

/**
 * Look LUTs end to end (decision 77): the repo's test look, imported into the project's luts
 * folder, on an adjustment layer at 70% over the colour patches. Preview and the exported
 * file (10-bit HEVC, read back with FFmpeg) against the CPU maths, from the very first frame,
 * so export can't start before the LUT has loaded.
 */

type Rgb = [number, number, number]
const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const XS = [192, 576, 960, 1344, 1728]
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const clamp = (c: Rgb) => c.map((v) => Math.min(1, Math.max(0, v))) as Rgb
const worst = (got: number[][], want: Rgb[]) => Math.max(...got.flatMap((g, i) => g.map((v, k) => Math.abs(v - want[i]![k]!))))
const round = (v: number) => Math.round(v * 10000) / 10000

export async function lookLutExportTest() {
  const project = projectController.project!
  const path = projectController.path!
  const [v1, v2] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string]
  const patches = project.media.find((m) => m.name === 'patches_rec709')
  if (!patches) throw new Error('patches_rec709 is missing (npm run test-media)')
  projectController.dispatch(placeMedia({ mediaId: patches.id, sourceIn: 0, sourceOut: s(2), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const readAt = async (frame: number) => {
    timelineController.setPlayhead(frame * FRAME)
    await wait(900)
    return player.lastStill ? await readPixels(player.lastStill, XS.map((x) => [x, 540] as [number, number])) : []
  }
  const under = (await readAt(12)) as Rgb[]
  const reasons: string[] = []

  // The look, copied into the project like Choose .cube… does.
  const lut = await window.ginosa.media.importLut(path, await window.ginosa.snapshot.testLook())
  const listed = await window.ginosa.media.listLuts(path)
  if (!listed.some((l) => l.file === lut.file)) reasons.push(`${lut.file} isn't listed in the project's luts folder`)
  const cube = unitCube(parseCube(await window.ginosa.media.readLut(path, lut.file)))
  timelineController.newAdjustmentLayer(v2, 0)
  const layerId = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  const layer = () => projectController.project!.sequence.clips.find((c) => c.id === layerId)!
  projectController.dispatch(trimClips({ clipIds: [layerId], edge: 'out', delta: s(2) - layer().duration }))
  projectController.dispatch(addEffect([layerId], 'look-lut'))
  projectController.dispatch(setEffectValues(layerId, layer().effects[0]!.id, { params: { lut: lut.file, strength: 70 } }))
  const expected = under.map((c) => lookReference(cube, c, 70))

  await readAt(25)
  const preview = worst(await readAt(25), expected)
  if (!(preview <= 0.004)) reasons.push(`preview off by ${preview.toFixed(4)}`)

  const settings: ExportSettings = { format: 'hevc10', container: 'mov', bitrateMbps: 40, keyframeSeconds: 1 }
  const out = (await window.ginosa.snapshot.exportPath('look-lut.mov'))!
  // A fresh export: its own layers, so nothing is loaded until it loads it.
  const result = await exporter.run(projectController.project!, settings, out)
  if (!result) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : `export ${exporter.state.kind}`)
  const rows = (await window.ginosa.snapshot.analyseExport(out, XS))!.rows
  const frames = [0, 1, 25, rows.length - 1]
  const exported = Math.max(...frames.map((j) => worst(rows[j]!, expected.map(clamp))))
  if (rows.length !== 50) reasons.push(`export has ${rows.length} frames, not 50`)
  if (!(exported <= 0.006)) reasons.push(`export off by ${exported.toFixed(4)} (frames ${frames.join(', ')})`)
  // And it really changed the picture.
  const change = worst(under.map((c) => [...c]), expected)
  if (!(change > 0.05)) reasons.push(`the look barely changes the patches (${change.toFixed(3)})`)
  return {
    verdict: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    lut: lut.file,
    previewError: round(preview),
    exportError: round(exported),
    firstFrameError: round(worst(rows[0]!, expected.map(clamp))),
    lookChange: round(change),
    patches: under.map((c, i) => ({ under: c.map(round), expected: expected[i]!.map(round), exportedFrame0: rows[0]![i] }))
  }
}

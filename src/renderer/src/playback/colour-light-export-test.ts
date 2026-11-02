import { toDisplay, toLinear } from '@engine/effects/colour-spaces'
import { resolveClip } from '@engine/keyframes/properties'
import type { ExportSettings } from '@engine/export/export-settings'
import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '@engine/time'
import { addAudioSource } from '@engine/timeline/audio-edits'
import { applyBuiltinPreset } from '@engine/timeline/builtin-presets'
import { placeMedia, trimClips } from '@engine/timeline/edits'
import { addEffect, removeEffects, setEffectValues } from '@engine/timeline/effect-edits'
import { BASIC_DEFAULTS, basicCorrectionReference } from '../../../effects/basic-correction/reference'
import { curvesReference } from '../../../effects/curves/reference'
import { levelsReference } from '../../../effects/levels/reference'
import { IDENTITY_CURVE } from '@engine/effects/curves'
import { analysisController } from '../audio/analysis-controller'
import { modulationController } from '../audio/modulation-controller'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { readPixels } from './colour-probe'
import { exporter } from './exporter'
import { player } from './player'

/**
 * M10 end to end: the effects through playback and export (10-bit HEVC read back with
 * FFmpeg), against the CPU maths.
 *  1. Kick Flash (the built-in preset) on the patches clip, driven by the 128 BPM drums:
 *     every exported frame's exposure matches the modulated value, and it really flashes.
 *  2. An adjustment layer with Basic Correction → Curves → Levels.
 *  3. Mosaic added to it: patch centres stay flat, and the cell across a patch edge is
 *     the average of the light either side.
 */

type Rgb = [number, number, number]
const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const XS = [192, 576, 960, 1344, 1728]
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const clamp = (c: Rgb) => c.map((v) => Math.min(1, Math.max(0, v))) as Rgb
const worst = (got: number[][], want: Rgb[]) => Math.max(...got.flatMap((g, i) => g.map((v, k) => Math.abs(v - want[i]![k]!))))
const round = (v: number) => Math.round(v * 10000) / 10000

async function exportFile(name: string) {
  const settings: ExportSettings = { format: 'hevc10', container: 'mov', bitrateMbps: 40, keyframeSeconds: 1 }
  const path = (await window.ginosa.snapshot.exportPath(name))!
  const result = await exporter.run(projectController.project!, settings, path)
  if (!result) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : `export ${exporter.state.kind}`)
  return path
}

export async function colourLightExportTest() {
  const project = projectController.project!
  const v1 = project.sequence.tracks.filter((t) => t.kind === 'video')[0]!.id
  const v2 = project.sequence.tracks.filter((t) => t.kind === 'video')[1]!.id
  const a1 = project.sequence.tracks.find((t) => t.kind === 'audio')!.id
  const item = (name: string) => {
    const found = projectController.project!.media.find((m) => m.name === name)
    if (!found) throw new Error(`${name} is missing (npm run test-media)`)
    return found
  }
  projectController.dispatch(placeMedia({ mediaId: item('patches_rec709').id, sourceIn: 0, sourceOut: s(2), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  projectController.dispatch(placeMedia({ mediaId: item('beat_128bpm').id, sourceIn: 0, sourceOut: s(2), at: 0, videoTrackId: null, audioTrackId: a1, mode: 'overwrite' }))
  const clipId = projectController.project!.sequence.clips.find((c) => c.kind === 'video')!.id
  const clip = () => projectController.project!.sequence.clips.find((c) => c.id === clipId)!
  const readAt = async (frame: number, xs = XS) => {
    timelineController.setPlayhead(frame * FRAME)
    await wait(900)
    return player.lastStill ? await readPixels(player.lastStill, xs.map((x) => [x, 540] as [number, number])) : []
  }
  const under = (await readAt(12)) as Rgb[]
  const reasons: string[] = []
  const results: Record<string, unknown> = {}

  // 1. Kick Flash, following "Song".
  const added = addAudioSource('track', a1, 'Song')
  projectController.dispatch(added)
  await analysisController.settle()
  if (!projectController.dispatch(applyBuiltinPreset([clipId], 'builtin:kick-flash', 0))) throw new Error(`Kick Flash failed: ${projectController.lastError}`)
  modulationController.refresh()
  const kick = clip().effects[0]!
  const path1 = await exportFile('kick-flash.mov')
  const modulation = exporter.lastModulation!
  const a1Rows = (await window.ginosa.snapshot.analyseExport(path1, XS))!.rows
  const exposures: number[] = []
  let kickWorst = 0
  let kickWhere = ''
  for (let j = 0; j < a1Rows.length; j++) {
    const exposure = Number(resolveClip(clip(), j * FRAME, modulation).effects[0]!.params['exposure'])
    exposures.push(exposure)
    const want = under.map((c) => clamp(basicCorrectionReference(c, { ...BASIC_DEFAULTS, exposure })))
    const e = worst(a1Rows[j]!, want)
    if (e > kickWorst) (kickWorst = e), (kickWhere = `frame ${j} (exposure +${exposure.toFixed(2)})`)
  }
  // The drums' kicks are at 0.4 s and every 0.46875 s after: each flash starts on the first frame at or after one.
  const flashFrames = exposures.flatMap((v, i) => (v > 1 && !(exposures[i - 1]! > 1) ? [i] : []))
  const kickFrames = [0, 1, 2, 3].map((k) => Math.ceil((0.4 + k * 0.46875) * 25 - 1e-9))
  if (JSON.stringify(flashFrames) !== JSON.stringify(kickFrames)) reasons.push(`Kick Flash flashed on frames ${flashFrames.join(', ')}; the kicks are on ${kickFrames.join(', ')}`)
  const flashes = flashFrames.length
  const peak = Math.max(...exposures)
  if (a1Rows.length !== 50) reasons.push(`Kick Flash export has ${a1Rows.length} frames, not 50`)
  if (!(kickWorst <= 0.006)) reasons.push(`Kick Flash export off by ${kickWorst.toFixed(4)} at ${kickWhere}`)
  if (flashes < 3) reasons.push(`Kick Flash flashed ${flashes} times in 2 s of 128 BPM drums`)
  if (!(peak > 1.9 && peak <= 2)) reasons.push(`Kick Flash peaked at +${peak.toFixed(2)} stops (expected +2 on the hits)`)
  // The preview at the brightest frame.
  const brightest = exposures.indexOf(peak)
  const previewExposure = Number(resolveClip(clip(), brightest * FRAME, modulationController.context).effects[0]!.params['exposure'])
  // The preview keeps light above white (the monitor clips it); the file clips it.
  const previewPixels = await readAt(brightest)
  const previewKick = worst(previewPixels, under.map((c) => basicCorrectionReference(c, { ...BASIC_DEFAULTS, exposure: previewExposure })))
  if (!(previewKick <= 0.004)) reasons.push(`Kick Flash preview off by ${previewKick.toFixed(4)} at frame ${brightest}`)
  results['kick flash'] = { frames: a1Rows.length, flashes, flashFrames, kickFrames, peakStops: round(peak), exportError: round(kickWorst), previewError: round(previewKick), brightestFrame: brightest, exposures: exposures.map((v) => Math.round(v * 100) / 100) }
  projectController.dispatch(removeEffects(clipId, [kick.id]))

  // 2. Basic Correction → Curves → Levels on an adjustment layer.
  timelineController.newAdjustmentLayer(v2, 0)
  const layerId = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  const layer = () => projectController.project!.sequence.clips.find((c) => c.id === layerId)!
  projectController.dispatch(trimClips({ clipIds: [layerId], edge: 'out', delta: s(2) - layer().duration }))
  for (const id of ['basic-correction', 'curves', 'levels']) projectController.dispatch(addEffect([layerId], id))
  const [basicId, curvesId, levelsId] = layer().effects.map((e) => e.id) as [string, string, string]
  const look = { temperature: 30, tint: -10, exposure: 0.3, contrast: 35, highlights: -30, shadows: 25, saturation: 125, vibrance: 30, hue: 8 }
  const curves = { master: '0,0 0.25,0.2 0.75,0.82 1,1', red: '0,0.04 0.5,0.55 1,1' }
  const levels = { inBlack: 8, inWhite: 245, gamma: 1.1, blueOutWhite: 235 }
  projectController.dispatch(setEffectValues(layerId, basicId, { params: look }))
  projectController.dispatch(setEffectValues(layerId, curvesId, { params: curves }))
  projectController.dispatch(setEffectValues(layerId, levelsId, { params: levels }))
  const chain = (c: Rgb) => levelsReference(curvesReference(basicCorrectionReference(c, { ...BASIC_DEFAULTS, ...look }), { green: IDENTITY_CURVE, blue: IDENTITY_CURVE, ...curves }), levels)
  const expected = under.map(chain)
  const path2 = await exportFile('colour-light.mov')
  const a2 = (await window.ginosa.snapshot.analyseExport(path2, XS))!.rows
  const exportGrade = Math.max(...[6, 25, 44].map((j) => worst(a2[j]!, expected)))
  const previewGrade = worst(await readAt(25), expected)
  if (!(exportGrade <= 0.006)) reasons.push(`graded export off by ${exportGrade.toFixed(4)}`)
  if (!(previewGrade <= 0.004)) reasons.push(`graded preview off by ${previewGrade.toFixed(4)}`)
  results['basic → curves → levels'] = { exportError: round(exportGrade), previewError: round(previewGrade), patches: under.map((c, i) => ({ under: c, expected: expected[i]!.map(round) })) }

  // 3. Mosaic after them: 54 px cells from x = −39, so the cell 339–393 straddles the
  // patch edge at 384 (45 px of the first patch, 9 of the second).
  projectController.dispatch(addEffect([layerId], 'mosaic'))
  const mosaicId = layer().effects[3]!.id
  projectController.dispatch(setEffectValues(layerId, mosaicId, { params: { cellSize: 5 } }))
  const mixed = toDisplay(toLinear(expected[0]!).map((v, k) => (45 * v + 9 * toLinear(expected[1]!)[k]!) / 54)) as Rgb
  const xs = [...XS, 366]
  const want = [...expected, mixed]
  const path3 = await exportFile('mosaic.mov')
  const a3 = (await window.ginosa.snapshot.analyseExport(path3, xs))!.rows
  const exportMosaic = worst(a3[25]!, want)
  const previewMosaic = worst(await readAt(25, xs), want)
  // The straddling cell depends on the file's patch edge being sharp, so allow a little more.
  if (!(exportMosaic <= 0.012)) reasons.push(`mosaic export off by ${exportMosaic.toFixed(4)}`)
  if (!(previewMosaic <= 0.012)) reasons.push(`mosaic preview off by ${previewMosaic.toFixed(4)}`)
  results['… → mosaic 5%'] = { exportError: round(exportMosaic), previewError: round(previewMosaic), straddlingCell: { expected: mixed.map(round), exported: a3[25]![5], preview: (await readAt(25, [366]))[0] } }
  timelineController.select([layerId], 'replace')
  return { verdict: reasons.length ? 'fail' : 'pass', reasons, results }
}

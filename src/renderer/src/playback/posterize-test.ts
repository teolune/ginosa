import type { ExportSettings } from '@engine/export/export-settings'
import { resolveClip } from '@engine/keyframes/properties'
import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '@engine/time'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { applyBuiltinPreset } from '@engine/timeline/builtin-presets'
import { placeMedia, trimClips } from '@engine/timeline/edits'
import { addEffect, removeEffects, setEffectValues } from '@engine/timeline/effect-edits'
import { POSTERIZE_RATES } from '@engine/timeline/posterize'
import { addRackRows, setCubeAmount, setRackCubes, setRackRow } from '@engine/timeline/rack-edits'
import { modulationController } from '../audio/modulation-controller'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { readPixels } from './colour-probe'
import { exporter } from './exporter'
import { player } from './player'

/**
 * M12 "done when": hold patterns match the beat grid. The frame-numbered clip (ten blocks
 * spell each frame's number) plays under an adjustment layer with Posterize Time; every
 * frame of the export is read back and its number compared with the frame the beat maths
 * says it should hold, worked out here directly (beat k at k × note + phase, odd ones later
 * by swing, rounded to the nearest frame), not with the engine's own functions:
 *   1. 1/16 at 128 BPM of its own (holds of 2 and 3 frames that never drift)
 *   2. the sequence's beat grid (126 BPM, downbeat at 0.3 s), 1/8, swing 33%, phase 0.25 beat,
 *      sampling the middle of each hold
 *   3. a cut under the layer, kept until the next update, then switched at the cut
 * Then a Channel Rack row drives Kick Flash: every flash on the first frame at or after a step.
 */

const s = secondsToTicks
const FPS = 25
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const XS = Array.from({ length: 10 }, (_, b) => Math.floor((128 * b + 64) * 1.5))
const rate = (id: string) => POSTERIZE_RATES.findIndex((r) => r.id === id)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const number = (row: number[][]) => row.reduce((n, rgb, b) => n + (rgb[1]! > 0.5 ? 1 << b : 0), 0)

/** Update frames, straight from the definition: beat k × L + phase (+ swing × L when odd), at bpm from downbeat, nearest frame. */
function updates(bpm: number, downbeatSeconds: number, noteBeats: number, phase: number, swing: number, frames: number): number[] {
  const out: number[] = []
  for (let k = -4; out.length === 0 || out[out.length - 1]! < frames + 10; k++) {
    const beat = k * noteBeats + phase + (Math.abs(k % 2) === 1 ? swing * noteBeats : 0)
    out.push(Math.round((downbeatSeconds + (beat * 60) / bpm) * FPS))
  }
  return out
}

function expectedShown(points: number[], j: number, middle: boolean): number {
  let i = 0
  while (points[i + 1]! <= j) i++
  const start = points[i]!
  const end = points[i + 1]!
  return middle ? start + Math.floor((end - start) / 2) : start
}

async function exportRows(name: string) {
  const settings: ExportSettings = { format: 'h264', container: 'mp4', bitrateMbps: 40, keyframeSeconds: 1 }
  const path = (await window.ginosa.snapshot.exportPath(name))!
  const result = await exporter.run(projectController.project!, settings, path)
  if (!result) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : `export ${exporter.state.kind}`)
  return (await window.ginosa.snapshot.analyseExport(path, XS))!.rows
}

export async function posterizeTest() {
  const project = projectController.project!
  const [v1, v2] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string]
  const code = project.media.find((m) => m.name === 'framecode_h264')
  const patches = project.media.find((m) => m.name === 'patches_rec709')
  if (!code || !patches) throw new Error('framecode_h264 or patches_rec709 is missing (npm run test-media)')
  const reasons: string[] = []
  const results: Record<string, unknown> = {}
  projectController.dispatch(placeMedia({ mediaId: code.id, sourceIn: 0, sourceOut: s(10), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  timelineController.newAdjustmentLayer(v2, 0)
  const layerId = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  projectController.dispatch(trimClips({ clipIds: [layerId], edge: 'out', delta: s(10) - projectController.project!.sequence.clips.find((c) => c.id === layerId)!.duration }))
  projectController.dispatch(addEffect([layerId], 'posterize-time'))
  const effectId = projectController.project!.sequence.clips.find((c) => c.id === layerId)!.effects[0]!.id
  const set = (params: Record<string, string | number>) => projectController.dispatch(setEffectValues(layerId, effectId, { params }))
  const frames = 250

  const check = async (name: string, expected: (j: number) => number) => {
    const rows = await exportRows(`posterize-${Object.keys(results).length}.mp4`)
    let right = 0
    const wrong: string[] = []
    for (let j = 0; j < frames; j++) {
      const shown = number(rows[j]!)
      if (shown === expected(j)) right++
      else if (wrong.length < 4) wrong.push(`frame ${j}: shows ${shown}, expected ${expected(j)}`)
    }
    // The preview, on a few frames.
    let previewRight = 0
    const sample = [3, 17, 61, 118, 199, 233]
    for (const j of sample) {
      timelineController.setPlayhead(j * FRAME)
      await wait(700)
      const got = player.lastStill ? await readPixels(player.lastStill, XS.map((x) => [x, 540] as [number, number])) : []
      if (got.length && number(got) === expected(j)) previewRight++
    }
    const holds = new Set(Array.from({ length: frames }, (_, j) => expected(j))).size
    results[name] = { frames: rows.length, right, of: frames, holds, preview: `${previewRight} of ${sample.length}`, wrong }
    if (rows.length !== frames) reasons.push(`${name}: ${rows.length} frames, expected ${frames}`)
    if (right !== frames) reasons.push(`${name}: ${right} of ${frames} frames hold the right frame (${wrong.join('; ')})`)
    if (previewRight !== sample.length) reasons.push(`${name}: preview right on ${previewRight} of ${sample.length} frames`)
  }

  // 1. 1/16 at 128 BPM of its own: 2.34375 frames a hold at 25 fps.
  set({ rate: rate('1/16'), tempo: 'manual', bpm: 128 })
  const plain = updates(128, 0, 0.25, 0, 0, frames)
  await check('1/16 at 128 BPM', (j) => expectedShown(plain, j, false))

  // 2. The beat grid, 1/8, swing, phase, middle.
  projectController.dispatch(setBeatGrid({ bpm: 126, downbeat: s(0.3), beatsPerBar: 4 }))
  set({ rate: rate('1/8'), tempo: 'grid', swing: 33, phase: 0.25, sample: 'middle' })
  const swung = updates(126, 0.3, 0.5, 0.25, 0.33, frames)
  // Sampling the middle can reach past the layer's end (frame 250): it stops at its last frame.
  await check('grid 126 BPM, 1/8, swing 33%, phase 0.25, middle', (j) => Math.min(frames - 1, expectedShown(swung, j, true)))

  // 3. A cut under the layer at 4 s (frame 100) to the clip's own frame 150 (6 s): shown frame
  // n of the sequence is source n before the cut and 150 + (n − 100) after.
  projectController.dispatch(setBeatGrid(null))
  projectController.dispatch(placeMedia({ mediaId: code.id, sourceIn: s(6), sourceOut: s(12), at: s(4), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  set({ rate: rate('1/4'), tempo: 'manual', bpm: 93, swing: 0, phase: 0, sample: 'start', cuts: 'hold' })
  const beats = updates(93, 0, 1, 0, 0, frames)
  const source = (n: number) => (n < 100 ? n : 150 + (n - 100))
  await check('a cut, kept until the next update', (j) => source(expectedShown(beats, j, false)))
  set({ cuts: 'switch' })
  await check('a cut, switched at the cut', (j) => {
    const held = expectedShown(beats, j, false)
    return source(held < 100 && j >= 100 ? 100 : held)
  })

  // 4. A Channel Rack row drives Kick Flash.
  projectController.dispatch(removeEffects(layerId, [effectId]))
  projectController.dispatch(placeMedia({ mediaId: patches.id, sourceIn: 0, sourceOut: s(2), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  projectController.dispatch(setBeatGrid({ bpm: 128, downbeat: s(0.4), beatsPerBar: 4 }))
  const rows = addRackRows([{ name: 'Kick', band: 'bass' }])
  projectController.dispatch(rows)
  // Cubes on 16ths 0, 3, 8 and 11 of section A (two odd ones, swung 50%); its loop is two bars, longer than the clip.
  const steps = [0, 3, 8, 11]
  projectController.dispatch(setRackCubes(projectController.project!.sequence.rack.sections[0]!.id, rows.rowIds[0]!, steps, true))
  projectController.dispatch(setRackRow(rows.rowIds[0]!, { swing: 50 }))
  const patchesId = projectController.project!.sequence.clips.find((c) => c.mediaId === patches.id)!.id
  if (!projectController.dispatch(applyBuiltinPreset([patchesId], 'builtin:kick-flash', 0))) throw new Error(`Kick Flash failed: ${projectController.lastError}`)
  modulationController.refresh()
  const settings: ExportSettings = { format: 'h264', container: 'mp4', bitrateMbps: 40, keyframeSeconds: 1 }
  const path = (await window.ginosa.snapshot.exportPath('rack-flash.mp4'))!
  if (!(await exporter.run(projectController.project!, settings, path))) throw new Error('rack export failed')
  const modulation = exporter.lastModulation!
  const clip = projectController.project!.sequence.clips.find((c) => c.id === patchesId)!
  const exposures = Array.from({ length: 50 }, (_, j) => Number(resolveClip(clip, j * FRAME, modulation).effects[0]!.params['exposure']))
  const flashFrames = exposures.flatMap((v, j) => (v > 1.99 ? [j] : []))
  // Each step at 0.4 s + 16ths of 128 BPM (0.1171875 s), the odd ones (15, 31) half a 16th later.
  const stepSeconds = (n: number) => 0.4 + (n + (Math.abs(n % 2) === 1 ? 0.5 : 0)) * 0.1171875
  const expectedFlashes = steps.map((n) => Math.ceil(stepSeconds(n) * FPS - 1e-9)).filter((f) => f >= 0 && f < 50).sort((a, b) => a - b)
  // In the file: the frames where the dark patch jumps brighter (the patches clip is 2 s).
  const analysed = (await window.ginosa.snapshot.analyseExport(path, [192]))!.rows.slice(0, 50)
  const jumps = analysed.flatMap((row, j) => (j > 0 && row[0]![1]! - analysed[j - 1]![0]![1]! > 0.05 ? [j] : []))
  const followed = projectController.project!.sequence.modulators.find((m) => m.name.startsWith('Kick Flash'))?.source
  results['Channel Rack → Kick Flash'] = { flashFrames, expectedFlashes, jumpsInFile: jumps, modulatorSource: followed }
  if (followed?.kind !== 'pattern') reasons.push('Kick Flash didn’t follow the Kick row')
  if (JSON.stringify(flashFrames) !== JSON.stringify(expectedFlashes)) reasons.push(`Kick Flash flashed fully on frames ${flashFrames.join(', ')}; the steps are on ${expectedFlashes.join(', ')}`)
  if (JSON.stringify(jumps) !== JSON.stringify(expectedFlashes)) reasons.push(`the file's dark patch jumps brighter on frames ${jumps.join(', ')}; expected ${expectedFlashes.join(', ')}`)

  // 5. W3 (decision 109): a cube at −100% pushes Kick Flash's exposure down instead, in the file too.
  const rack = projectController.project!.sequence.rack
  const section = rack.sections[0]!
  const kickLink = Object.values(clip.effects[0]!.modulation).flat()[0]!
  projectController.dispatch(setCubeAmount([{ sectionId: section.id, rowId: rows.rowIds[0]!, step: 8 }], kickLink.id, -100))
  modulationController.refresh()
  const path2 = (await window.ginosa.snapshot.exportPath('rack-flash-down.mp4'))!
  if (!(await exporter.run(projectController.project!, settings, path2))) throw new Error('rack export (down) failed')
  const modulation2 = exporter.lastModulation!
  const clip2 = projectController.project!.sequence.clips.find((c) => c.id === patchesId)!
  const exposures2 = Array.from({ length: 50 }, (_, j) => Number(resolveClip(clip2, j * FRAME, modulation2).effects[0]!.params['exposure']))
  const downFrame = Math.ceil(stepSeconds(8) * FPS - 1e-9)
  const upFrames = exposures2.flatMap((v, j) => (v > 1.99 ? [j] : []))
  const downFrames = exposures2.flatMap((v, j) => (v < -1.99 ? [j] : []))
  const analysed2 = (await window.ginosa.snapshot.analyseExport(path2, [192]))!.rows.slice(0, 50)
  const drops = analysed2.flatMap((row, j) => (j > 0 && analysed2[j - 1]![0]![1]! - row[0]![1]! > 0.02 ? [j] : []))
  results['Channel Rack cube at −100%'] = { downFrame, upFrames, downFrames, dropsInFile: drops, patchBefore: analysed2[downFrame - 1]?.[0]?.[1], patchAt: analysed2[downFrame]?.[0]?.[1] }
  if (JSON.stringify(downFrames) !== JSON.stringify([downFrame])) reasons.push(`a −100% cube pushed exposure down on frames ${downFrames.join(', ')}; expected ${downFrame}`)
  if (JSON.stringify(upFrames) !== JSON.stringify(expectedFlashes.filter((f) => f !== downFrame))) reasons.push(`with one cube at −100%, the others flashed on ${upFrames.join(', ')}`)
  if (!drops.includes(downFrame)) reasons.push(`the file's dark patch doesn't drop on frame ${downFrame} (drops on ${drops.join(', ') || 'none'})`)
  return { verdict: reasons.length ? 'fail' : 'pass', reasons, results }
}

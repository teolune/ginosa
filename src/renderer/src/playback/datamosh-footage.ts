import type { ExportSettings } from '@engine/export/export-settings'
import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '@engine/time'
import { addAdjustmentLayer, addEffect, setEffectEnabled, setEffectValues } from '@engine/timeline/effect-edits'
import { placeMedia } from '@engine/timeline/edits'
import { setAnimated, setValue } from '@engine/timeline/keyframe-edits'
import type { ParamValue } from '@engine/effects/types'
import { mediaController } from '../state/media-controller'
import { projectController } from '../state/project-controller'
import { exporter } from './exporter'

/**
 * M14 side-by-side material: your two Apple Log clips cut together (3 s of each, 1080p25), with
 * Datamosh exported several ways, as ProRes 422 HQ in renders/export. scripts/codec-mosh.py then
 * moshes the plain export with a real MPEG-4 Part 2 bitstream (an I-frame removed at the cut;
 * a P-frame repeated for bloom) and lays the stills out next to these. Your clips are only read.
 *
 *  - mosh-plain: no Datamosh;
 *  - mosh-cut: Datamosh from the frame before the cut, Reset on Cuts off (as removing the cut's I-frame);
 *  - mosh-melt: the same with Melt 50 (Transition Melt);
 *  - mosh-codec: the same with the Codec Mosh settings (Residual 100%, Intra Blocks 20%, half pixels);
 *  - mosh-fluid: the same with the Fluid settings;
 *  - mosh-freeze: Freeze & Drift on the whole timeline (resetting at the cut);
 *  - mosh-bloom: the real picture until frame 90, then the motion of frame 90 repeated for 12 frames.
 */

const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const CUT = 75
const SETTINGS: ExportSettings = { format: 'prores-422hq', container: 'mov', bitrateMbps: 40, keyframeSeconds: 1 }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function datamoshFootage() {
  const run = (command: Parameters<typeof projectController.dispatch>[0]) => {
    if (!projectController.dispatch(command)) throw new Error(`${command.label} failed: ${projectController.lastError}`)
  }
  const files = await window.ginosa.snapshot.referenceClips()
  if (files.length < 2) throw new Error('The Apple Log clips aren’t in Reference Materials/AppleLogClips')
  await mediaController.importPaths(files.slice(0, 2), null)
  // Until both can be played (an optimised copy may be made first).
  for (let i = 0; i < 600; i++) {
    const media = projectController.project?.media ?? []
    if (media.length === 2 && media.every((m) => mediaController.playablePath(m))) break
    await wait(500)
  }
  const project = projectController.project!
  const [one, two] = project.media
  if (!one || !two || !mediaController.playablePath(one) || !mediaController.playablePath(two)) throw new Error('The clips never became playable')
  const [v1, v2, v3] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string, string]
  run(placeMedia({ mediaId: one.id, sourceIn: s(1), sourceOut: s(4), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  run(placeMedia({ mediaId: two.id, sourceIn: s(2), sourceOut: s(5), at: s(3), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const end = s(6)
  const layerOn = (track: string, from: number) => {
    run(addAdjustmentLayer({ trackId: track, start: from * FRAME, duration: end - from * FRAME }))
    const layer = projectController.project!.sequence.clips.find((c) => c.trackId === track && c.adjustment)!.id
    run(addEffect([layer], 'datamosh'))
    const effect = projectController.project!.sequence.clips.find((c) => c.id === layer)!.effects[0]!.id
    return { layer, effect }
  }
  const cut = layerOn(v2, CUT - 1)
  const whole = layerOn(v3, 0)
  const set = (on: { layer: string; effect: string }, params: Record<string, ParamValue>) => run(setEffectValues(on.layer, on.effect, { params }))
  // (Switching an effect to how it already is changes nothing, so isn't checked.)
  const enable = (cutOn: boolean, wholeOn: boolean) => {
    projectController.dispatch(setEffectEnabled(cut.layer, cut.effect, cutOn))
    projectController.dispatch(setEffectEnabled(whole.layer, whole.effect, wholeOn))
  }
  const exported: Record<string, { file: string; seconds: number }> = {}
  const exportAs = async (name: string) => {
    const path = (await window.ginosa.snapshot.exportPath(`${name}.mov`))!
    const started = performance.now()
    const result = await exporter.run(projectController.project!, SETTINGS, path)
    if (!result) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : `export ${exporter.state.kind}`)
    exported[name] = { file: path, seconds: Math.round((performance.now() - started) / 100) / 10 }
  }

  enable(false, false)
  await exportAs('mosh-plain')
  enable(true, false)
  set(cut, { onCuts: false })
  await exportAs('mosh-cut')
  set(cut, { melt: 50 })
  await exportAs('mosh-melt')
  set(cut, { melt: 0, residual: 100, intra: 20, rounding: 'half' })
  await exportAs('mosh-codec')
  set(cut, { residual: 0, intra: 0, momentum: 80, smoothing: 75, rounding: 'off' })
  await exportAs('mosh-fluid')
  enable(false, true)
  set(whole, { speed: 40, momentum: 85, leak: 0, rounding: 'half' })
  await exportAs('mosh-freeze')
  // Bloom: Leak 100% (the real picture) until frame 89, then none; the trigger rises on frame 90.
  set(whole, { speed: 100, momentum: 0, rounding: 'whole', bloomFrames: 12 })
  for (const param of ['leak', 'bloomTrigger']) run(setAnimated({ clipId: whole.layer, effectId: whole.effect, param }, true, 89 * FRAME))
  run(setValue({ clipId: whole.layer, effectId: whole.effect, param: 'leak' }, 100, 89 * FRAME))
  run(setValue({ clipId: whole.layer, effectId: whole.effect, param: 'leak' }, 0, 90 * FRAME))
  run(setValue({ clipId: whole.layer, effectId: whole.effect, param: 'bloomTrigger' }, 100, 90 * FRAME))
  run(setValue({ clipId: whole.layer, effectId: whole.effect, param: 'bloomTrigger' }, 0, 91 * FRAME))
  await exportAs('mosh-bloom')
  return { verdict: 'pass', cutFrame: CUT, clips: [one.name, two.name], exported }
}

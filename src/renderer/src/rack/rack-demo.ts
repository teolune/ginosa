import { STEPS_PER_BEAT } from '@engine/project/model'
import { secondsToTicks } from '@engine/time'
import { addAudioSource } from '@engine/timeline/audio-edits'
import { applyBuiltinPreset } from '@engine/timeline/builtin-presets'
import { placeMedia, trimClips } from '@engine/timeline/edits'
import { addEffect, setEffectValues } from '@engine/timeline/effect-edits'
import { POSTERIZE_RATES } from '@engine/timeline/posterize'
import { addRackRows, setCubeAmount, STARTER_ROWS } from '@engine/timeline/rack-edits'
import { linksTo } from '@engine/timeline/modulation-edits'
import { channelModulatorIds, hitBeat, placeSections } from '@engine/timeline/rack'
import { beatTime } from '@engine/audio/beat-grid'
import { frameTicks } from '@engine/timeline/timeline'
import { rackUi } from './rack-ui'
import { analysisController } from '../audio/analysis-controller'
import { modulationController } from '../audio/modulation-controller'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import { fillFromBands } from './autofill'

/**
 * M12's UI screenshot and Auto-fill check: the 128 BPM test drums as the song, Kick and Hat
 * auto-filled from its hits (kicks on every beat, hats on every 8th), Kick Flash following the
 * Kick row on the test card, and Posterize Time (1/8) on an adjustment layer.
 */
export async function buildRackUi() {
  const s = secondsToTicks
  const FRAME = frameTicks(projectController.project!.sequence)
  const project = projectController.project!
  const [v1, v2] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string]
  const a1 = project.sequence.tracks.find((t) => t.kind === 'audio')!.id
  const media = (name: string) => {
    const found = projectController.project!.media.find((m) => m.name === name)
    if (!found) throw new Error(`${name} is missing (npm run test-media)`)
    return found
  }
  projectController.dispatch(placeMedia({ mediaId: media('testsrc_1080p24_h264').id, sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  projectController.dispatch(placeMedia({ mediaId: media('beat_128bpm').id, sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: null, audioTrackId: a1, mode: 'overwrite' }))
  const song = addAudioSource('track', a1, 'Song')
  projectController.dispatch(song)
  analysisController.useDetectedTempo(song.sourceId)
  await analysisController.settle()
  const rows = addRackRows(STARTER_ROWS)
  projectController.dispatch(rows)
  const filled = fillFromBands(song.sourceId) ?? {}
  const rack = () => projectController.project!.sequence.rack.rows
  const kick = filled[rack()[0]!.id] ?? []
  const hat = filled[rack()[2]!.id] ?? []
  const clipId = projectController.project!.sequence.clips.find((c) => c.kind === 'video')!.id
  projectController.dispatch(applyBuiltinPreset([clipId], 'builtin:kick-flash', 0))
  timelineController.newAdjustmentLayer(v2, 0)
  const layerId = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  projectController.dispatch(trimClips({ clipIds: [layerId], edge: 'out', delta: s(8) - projectController.project!.sequence.clips.find((c) => c.id === layerId)!.duration }))
  projectController.dispatch(addEffect([layerId], 'posterize-time'))
  const posterize = projectController.project!.sequence.clips.find((c) => c.id === layerId)!.effects[0]!.id
  projectController.dispatch(setEffectValues(layerId, posterize, { params: { rate: POSTERIZE_RATES.findIndex((r) => r.id === '1/8') } }))
  // W3: the Kick channel's first two cubes in section A push Kick Flash's exposure by 100% and −50%.
  const sequence = () => projectController.project!.sequence
  const kickRow = rack()[0]!
  const sectionA = sequence().rack.sections[0]!
  const kickCubes = sectionA.cubes[kickRow.id] ?? []
  const link = channelModulatorIds(sequence(), kickRow.id).flatMap((id) => linksTo(sequence(), id))[0]?.link
  if (link && kickCubes.length >= 2) {
    projectController.dispatch(setCubeAmount([{ sectionId: sectionA.id, rowId: kickRow.id, step: kickCubes[1]!.step }], link.id, -50))
  }
  modulationController.refresh()
  const grid0 = sequence().beatGrid!
  const timeOf = (step: number) => beatTime(grid0, hitBeat(placeSections(sequence().rack, grid0)[0]!.firstStep + step, kickRow))
  const pushes = link && kickCubes.length >= 2 ? kickCubes.slice(0, 2).map((c) => modulationController.context.linkValue?.(link, Math.ceil(timeOf(c.step) / FRAME) * FRAME) ?? null) : []
  rackUi.select(kickCubes.slice(0, 2).map((c) => ({ sectionId: sectionA.id, rowId: kickRow.id, step: c.step })))
  rackUi.openCubeWindow(true)
  rackUi.toggleLinking(kickRow.id)
  timelineController.select([clipId], 'replace')
  timelineController.setPlayhead(s(2.1))
  timelineController.zoomToFit()
  workspaceController.open('channel-rack')
  workspaceController.open('effect-controls')
  workspaceController.focus('channel-rack')
  await new Promise((resolve) => setTimeout(resolve, 600))
  const ui = await uiChecks(clipId)
  // Show Kick Flash's link to the Kick channel in Effect Controls.
  document.querySelector('.fx-channel-link')?.scrollIntoView({ block: 'center' })
  const grid = projectController.project!.sequence.beatGrid
  // Kicks on every beat (steps 0, 4, 8…), hats on every 8th (0, 2, 4…).
  return {
    grid,
    sections: sequence().rack.sections.map((x) => x.bars),
    sectionA: Object.fromEntries(rack().map((r) => [r.name, (sectionA.cubes[r.id] ?? []).map((c) => c.step)])),
    pushes,
    ui,
    kick: { steps: kick.length, onBeats: kick.every((n) => n % STEPS_PER_BEAT === 0), first: kick.slice(0, 8) },
    hat: { steps: hat.length, onEighths: hat.every((n) => n % 2 === 0), first: hat.slice(0, 8) },
    kickFlashSource: projectController.project!.sequence.modulators.find((m) => m.name.startsWith('Kick Flash'))?.source
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The row in Effect Controls for a value, by its label. */
function valueRow(label: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('.fx-row')].find((row) => row.querySelector('.kf-name')?.textContent?.trim() === label) ?? null
}

/**
 * W3's interface, through the DOM as you'd use it: link mode's socket links and unlinks a
 * value; dragging a channel's name onto a value links it; clicking an empty cube makes one
 * and Backspace deletes it.
 */
async function uiChecks(clipId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const sequence = () => projectController.project!.sequence
  const clip = () => sequence().clips.find((c) => c.id === clipId)!
  const basic = () => clip().effects.find((e) => e.effectId === 'basic-correction')
  const links = (param: string) => basic()?.modulation[param] ?? []
  const [kick, clap] = sequence().rack.rows
  // Link mode is on for Kick: the socket beside Contrast links it, a second click unlinks it, a third links it again.
  const socket = () => valueRow('Contrast')?.querySelector<HTMLButtonElement>('.link-socket')
  socket()?.click()
  await pause(150)
  out['socketLinks'] = links('contrast').length
  socket()?.click()
  await pause(150)
  out['socketUnlinks'] = links('contrast').length
  socket()?.click()
  await pause(150)
  out['contrastLinkedToKick'] = links('contrast').some((l) => sequence().modulators.find((m) => m.id === l.modulatorId)?.source.kind === 'pattern')
  // Drag Clap onto Brightness.
  const target = valueRow('Brightness')
  if (target && clap) {
    const data = new DataTransfer()
    data.setData('application/x-ginosa-channel', clap.id)
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    await pause(150)
  }
  out['dragLinksClap'] = links('brightness').some((l) => l.modulatorId === clap?.modulatorId)
  // Click an empty Kick cube (16th 1), then Backspace.
  const section = () => sequence().rack.sections[0]!
  const cubes = () => (section().cubes[kick!.id] ?? []).map((c) => c.step)
  const kickRow = document.querySelectorAll('.rack-row')[0]
  const cube = kickRow?.querySelectorAll<HTMLButtonElement>('.rack-cube')[1]
  cube?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
  await pause(150)
  out['clickMakesCube'] = cubes().includes(1)
  document.querySelector<HTMLElement>('.channel-rack')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
  await pause(150)
  out['backspaceDeletes'] = !cubes().includes(1)
  out['pass'] = out['socketLinks'] === 1 && out['socketUnlinks'] === 0 && out['contrastLinkedToKick'] === true && out['dragLinksClap'] === true && out['clickMakesCube'] === true && out['backspaceDeletes'] === true
  return out
}

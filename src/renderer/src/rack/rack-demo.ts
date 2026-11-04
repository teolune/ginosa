import { STEPS_PER_BEAT } from '@engine/project/model'
import { secondsToTicks } from '@engine/time'
import { addAudioSource } from '@engine/timeline/audio-edits'
import { applyBuiltinPreset } from '@engine/timeline/builtin-presets'
import { placeMedia, trimClips } from '@engine/timeline/edits'
import { addEffect, setEffectValues } from '@engine/timeline/effect-edits'
import { POSTERIZE_RATES } from '@engine/timeline/posterize'
import { addRackRows, STARTER_ROWS } from '@engine/timeline/rack-edits'
import { analysisController } from '../audio/analysis-controller'
import { modulationController } from '../audio/modulation-controller'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import { autofillRow, songSteps } from './autofill'

/**
 * M12's UI screenshot and Auto-fill check: the 128 BPM test drums as the song, Kick and Hat
 * auto-filled from its hits (kicks on every beat, hats on every 8th), Kick Flash following the
 * Kick row on the test card, and Posterize Time (1/8) on an adjustment layer.
 */
export async function buildRackUi() {
  const s = secondsToTicks
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
  const [from, to] = songSteps(projectController.project!.sequence)
  const rack = () => projectController.project!.sequence.rack.rows
  const kick = autofillRow(rack()[0]!, song.sourceId, from, to) ?? []
  const hat = autofillRow(rack()[2]!, song.sourceId, from, to) ?? []
  const clipId = projectController.project!.sequence.clips.find((c) => c.kind === 'video')!.id
  projectController.dispatch(applyBuiltinPreset([clipId], 'builtin:kick-flash', 0))
  timelineController.newAdjustmentLayer(v2, 0)
  const layerId = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  projectController.dispatch(trimClips({ clipIds: [layerId], edge: 'out', delta: s(8) - projectController.project!.sequence.clips.find((c) => c.id === layerId)!.duration }))
  projectController.dispatch(addEffect([layerId], 'posterize-time'))
  const posterize = projectController.project!.sequence.clips.find((c) => c.id === layerId)!.effects[0]!.id
  projectController.dispatch(setEffectValues(layerId, posterize, { params: { rate: POSTERIZE_RATES.findIndex((r) => r.id === '1/8') } }))
  modulationController.refresh()
  timelineController.select([layerId], 'replace')
  timelineController.setPlayhead(s(2.1))
  timelineController.zoomToFit()
  workspaceController.open('channel-rack')
  workspaceController.open('effect-controls')
  workspaceController.focus('channel-rack')
  const grid = projectController.project!.sequence.beatGrid
  // Kicks on every beat (steps 0, 4, 8…), hats on every 8th (0, 2, 4…).
  return {
    grid,
    kick: { steps: kick.length, onBeats: kick.every((n) => n % STEPS_PER_BEAT === 0), first: kick.slice(0, 8) },
    hat: { steps: hat.length, onEighths: hat.every((n) => n % 2 === 0), first: hat.slice(0, 8) },
    kickFlashSource: projectController.project!.sequence.modulators.find((m) => m.name.startsWith('Kick Flash'))?.source
  }
}

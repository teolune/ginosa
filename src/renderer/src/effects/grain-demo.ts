import { secondsToTicks } from '@engine/time'
import { applyBuiltinPreset } from '@engine/timeline/builtin-presets'
import { placeMedia } from '@engine/timeline/edits'
import { setEffectValues } from '@engine/timeline/effect-edits'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'

/** M11's UI screenshot: the test card with the Super 8 Grain preset, refreshing on 1/8 notes, in Effect Controls. */
export async function buildGrainUi(): Promise<void> {
  const project = projectController.project!
  const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!.id
  const media = project.media.find((m) => m.name === 'testsrc_1080p24_h264')
  if (!media) throw new Error('testsrc_1080p24_h264 is missing (npm run test-media)')
  projectController.dispatch(placeMedia({ mediaId: media.id, sourceIn: 0, sourceOut: secondsToTicks(6), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const clipId = projectController.project!.sequence.clips.find((c) => c.kind === 'video')!.id
  projectController.dispatch(applyBuiltinPreset([clipId], 'builtin:grain-super8', 0))
  const effectId = projectController.project!.sequence.clips.find((c) => c.id === clipId)!.effects[0]!.id
  projectController.dispatch(setEffectValues(clipId, effectId, { params: { refresh: 'note', note: '1/8', boil: 80 } }))
  timelineController.select([clipId], 'replace')
  timelineController.setPlayhead(secondsToTicks(2))
  timelineController.zoomToFit()
  workspaceController.open('effect-controls')
  workspaceController.focus('effect-controls')
}

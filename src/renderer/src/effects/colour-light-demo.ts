import { secondsToTicks } from '@engine/time'
import { addEffect, setEffectValues } from '@engine/timeline/effect-edits'
import { placeMedia } from '@engine/timeline/edits'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'

/**
 * M10's UI screenshot: the test card with Curves (an S-curve and a warmer red), Basic
 * Correction and a soft Mosaic, shown in Effect Controls (curve editor, grouped rows) and
 * the Effects Library (the built-in presets).
 */
export async function buildColourLightUi(): Promise<void> {
  const project = projectController.project!
  const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!.id
  const media = project.media.find((m) => m.name === 'testsrc_1080p24_h264')
  if (!media) throw new Error('testsrc_1080p24_h264 is missing (npm run test-media)')
  projectController.dispatch(placeMedia({ mediaId: media.id, sourceIn: 0, sourceOut: secondsToTicks(6), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const clipId = projectController.project!.sequence.clips.find((c) => c.kind === 'video')!.id
  for (const id of ['curves', 'basic-correction', 'mosaic']) projectController.dispatch(addEffect([clipId], id))
  const [curves, basic, mosaic] = projectController.project!.sequence.clips.find((c) => c.id === clipId)!.effects.map((e) => e.id) as [string, string, string]
  projectController.dispatch(setEffectValues(clipId, curves, { params: { master: '0,0 0.25,0.17 0.5,0.52 0.75,0.86 1,1', red: '0,0.03 0.5,0.57 1,1' } }))
  projectController.dispatch(setEffectValues(clipId, basic, { params: { temperature: 18, contrast: 15, highlights: -25, vibrance: 40 } }))
  projectController.dispatch(setEffectValues(clipId, mosaic, { params: { cellSize: 3, softness: 35 }, mix: 100 }))
  timelineController.select([clipId], 'replace')
  timelineController.setPlayhead(secondsToTicks(2))
  timelineController.zoomToFit()
  workspaceController.open('effects-library')
  workspaceController.open('effect-controls')
  workspaceController.focus('effect-controls')
}

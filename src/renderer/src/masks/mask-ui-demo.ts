import { secondsToTicks } from '@engine/time'
import { addAdjustmentLayer, addEffect, setEffectValues } from '@engine/timeline/effect-edits'
import { placeMedia } from '@engine/timeline/edits'
import { addMaskTo, addShape, setEffectMask, setShapeMode, setShapeValues } from '@engine/timeline/mask-edits'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import { maskController } from './mask-controller'

/** The masksui snapshot: colour patches, an adjustment layer inverting inside a pen path minus an ellipse, being edited. */
export async function buildMaskUiTimeline(): Promise<void> {
  const s = secondsToTicks
  const project = projectController.project!
  const [v1, v2] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const patches = project.media.find((m) => m.name === 'patches_rec709')!
  projectController.dispatch(placeMedia({ mediaId: patches.id, sourceIn: 0, sourceOut: s(6), at: 0, videoTrackId: v1!, audioTrackId: null, mode: 'overwrite' }))
  projectController.dispatch(addAdjustmentLayer({ trackId: v2!, start: 0, duration: s(6) }))
  const layer = projectController.project!.sequence.clips.find((c) => c.adjustment)!
  projectController.dispatch(addEffect([layer.id], 'invert'))
  const effectId = projectController.project!.sequence.clips.find((c) => c.adjustment)!.effects[0]!.id
  const made = addMaskTo(layer.id, effectId, 'path')
  projectController.dispatch(made)
  projectController.dispatch(setShapeValues(made.maskId, made.shapeId, { scale: 160, feather: 30 }, 0))
  const hole = addShape(made.maskId, 'ellipse')
  projectController.dispatch(hole)
  projectController.dispatch(setShapeMode(made.maskId, hole.shapeId, 'subtract'))
  projectController.dispatch(setShapeValues(made.maskId, hole.shapeId, { size: [260, 180], position: [960, 600], feather: 20 }, 0))
  // The same mask, inverted, on the clip's own effect too (at 40%): one mask, two uses.
  const clip = projectController.project!.sequence.clips.find((c) => !c.adjustment && c.kind === 'video')!
  projectController.dispatch(addEffect([clip.id], 'invert'))
  const clipEffect = projectController.project!.sequence.clips.find((c) => c.id === clip.id)!.effects[0]!.id
  projectController.dispatch(setEffectMask(clip.id, clipEffect, { id: made.maskId, invert: true }))
  projectController.dispatch(setEffectValues(clip.id, clipEffect, { mix: 40 }))
  timelineController.select([layer.id], 'replace')
  timelineController.zoomToFit()
  timelineController.setPlayhead(s(1))
  maskController.edit(made.maskId)
  maskController.selectShape(made.shapeId)
  maskController.selectPoint(1)
  workspaceController.open('effect-controls')
}

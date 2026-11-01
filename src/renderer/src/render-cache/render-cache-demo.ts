import { secondsToTicks } from '@engine/time'
import { addAdjustmentLayer, addEffect, setEffectValues } from '@engine/timeline/effect-edits'
import { placeMedia } from '@engine/timeline/edits'
import { player } from '../playback/player'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import { renderCache } from './render-cache'

/**
 * The cacheui snapshot: real footage (the 1080p test pattern) under a Feedback tunnel on
 * an adjustment layer; the first 4 s rendered to the cache (green), the rest still live
 * (yellow). Reports the render speed and preview size on footage.
 */
export async function renderCacheDemo() {
  const s = secondsToTicks
  const project = projectController.project!
  const [v1, v2] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const footage = project.media.find((m) => m.name === 'testsrc_1080p24_h264')
  if (!footage) throw new Error('testsrc_1080p24_h264 is missing (npm run test-media)')
  projectController.dispatch(placeMedia({ mediaId: footage.id, sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: v1!, audioTrackId: null, mode: 'overwrite' }))
  projectController.dispatch(addAdjustmentLayer({ trackId: v2!, start: s(1), duration: s(7) }))
  const layer = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  projectController.dispatch(addEffect([layer], 'feedback'))
  const effect = projectController.project!.sequence.clips.find((c) => c.id === layer)!.effects[0]!.id
  projectController.dispatch(setEffectValues(layer, effect, { params: { amount: 88, zoom: 101.5, rotation: 0.8 } }))
  await renderCache.settle()
  const rendered = await renderCache.renderSection([], { from: 0, to: s(4) })
  const last = renderCache.last!
  timelineController.select([layer], 'replace')
  timelineController.zoomToFit()
  timelineController.setPlayhead(s(3))
  workspaceController.open('effect-controls')
  await player.settled()
  return {
    verdict: rendered === 75 && last.error === null ? 'pass' : 'fail',
    rendered,
    seconds: Math.round(last.ms / 100) / 10,
    fps: Math.round((rendered / (last.ms / 1000)) * 10) / 10,
    previewMBPerFrame: Math.round(last.bytes / rendered / 1e4) / 100,
    shownFromCache: player.lastStillCached
  }
}

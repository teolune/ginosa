import { secondsToTicks } from '@engine/time'
import { addEffect, setEffectValues } from '@engine/timeline/effect-edits'
import { placeMedia } from '@engine/timeline/edits'
import { formatGradient, solid, starterGradients, type Gradient } from '@engine/gradients/gradient'
import { writeGrd } from '@engine/gradients/grd'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import { gradientController } from './gradient-controller'

/**
 * M13's UI screenshot: the test card through a Gradient Map, Effect Controls with its
 * gradient rows, and the Gradient Editor on it, after importing a .grd made here (folders,
 * an HSB and a CMYK stop, a noise gradient) and any of yours in Reference Materials/Gradients.
 */
export async function buildGradientUi(): Promise<{ imported: string; warnings: string[] }> {
  const project = projectController.project!
  const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!.id
  const media = project.media.find((m) => m.name === 'testsrc_1080p24_h264')
  if (!media) throw new Error('testsrc_1080p24_h264 is missing (npm run test-media)')
  projectController.dispatch(placeMedia({ mediaId: media.id, sourceIn: 0, sourceOut: secondsToTicks(6), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const clipId = projectController.project!.sequence.clips.find((c) => c.kind === 'video')!.id
  projectController.dispatch(addEffect([clipId], 'gradient-map'))
  const effect = projectController.project!.sequence.clips.find((c) => c.id === clipId)!.effects[0]!
  const sunset = solid('Sunset', [[0, [0.08, 0.02, 0.2]], [0.35, [0.75, 0.1, 0.35]], [0.7, [1, 0.55, 0.15]], [1, [1, 0.95, 0.75]]])
  sunset.colourStops[2]!.midpoint = 0.3
  projectController.dispatch(setEffectValues(clipId, effect.id, { params: { gradient: formatGradient(sunset), method: 'perceptual' } }))

  // A library made here, with folders and the things ginosa flags.
  const cmyk = solid('Print Teal', [[0, [0, 0, 0]], [1, [0, 0.6, 0.65]]])
  cmyk.colourStops[1]!.source = { model: 'cmyk', c: 85, m: 20, y: 40, k: 5 }
  const hsb = solid('HSB Rainbow', [[0, [1, 0, 0]], [1, [0, 0, 1]]])
  hsb.colourStops[0]!.source = { model: 'hsb', h: 0, s: 100, b: 100 }
  const noise: Gradient = { kind: 'noise', name: 'Static', seed: 7, roughness: 0.8, model: 'hsb', min: [0, 0.4, 0.5, 0], max: [1, 1, 1, 1], transparency: false, restrict: true }
  const bytes = writeGrd(
    [
      ...starterGradients().map((gradient) => ({ gradient, folder: ['Basics'] })),
      { gradient: sunset, folder: ['Looks', 'Warm'] },
      { gradient: cmyk, folder: ['Looks', 'Cool'] },
      { gradient: hsb, folder: ['Looks'] },
      { gradient: noise, folder: ['Noise'] }
    ],
    [['Looks'], ['Looks', 'Warm'], ['Looks', 'Cool'], ['Noise']]
  )
  const files = [{ name: 'Demo Looks.grd', bytes }, ...(await window.ginosa.snapshot.referenceGradients()).libraries]
  await gradientController.importFiles(files)
  gradientController.openFolder(['Demo Looks', 'Looks', 'Warm'])
  timelineController.select([clipId], 'replace')
  timelineController.setPlayhead(secondsToTicks(2))
  timelineController.zoomToFit()
  workspaceController.open('effect-controls')
  gradientController.edit({ clipId, effectId: effect.id, param: 'gradient' })
  gradientController.select({ kind: 'colour', index: 2 })
  return { imported: gradientController.message?.text ?? '', warnings: gradientController.message?.warnings ?? [] }
}

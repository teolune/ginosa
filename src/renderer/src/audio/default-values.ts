import { paramDefault } from '@engine/effects/params'
import type { ParamValue } from '@engine/effects/types'
import type { Clip, Project } from '@engine/project/model'
import { effectImageSize } from '@engine/timeline/effect-edits'
import { defaultMotion } from '@engine/timeline/motion'
import { effectById } from '../../../effects/registry'

/** What Reset puts a single value back to (null where there's nothing to reset, like Speed). */
export function defaultValueOf(project: Project, clip: Clip, effectId: string | null, param: string): ParamValue | null {
  if (effectId !== null) {
    const effect = clip.effects.find((e) => e.id === effectId)
    if (!effect) return null
    if (param === 'mix') return 100
    const spec = effectById(effect.effectId)?.params.find((p) => p.id === param)
    return spec ? paramDefault(spec, effectImageSize(clip, project.media, project.sequence)) : null
  }
  const motion = clip.adjustment ? null : defaultMotion(project.media.find((m) => m.id === clip.mediaId), project.sequence.settings)
  switch (param) {
    case 'position':
      return motion ? [motion.positionX, motion.positionY] : null
    case 'anchor':
      return motion ? [motion.anchorX, motion.anchorY] : null
    case 'scale':
      return motion?.scale ?? null
    case 'scaleWidth':
      return 100
    case 'rotation':
      return 0
    case 'opacity':
      return 100
    case 'volume':
      return 0
    default:
      return null
  }
}

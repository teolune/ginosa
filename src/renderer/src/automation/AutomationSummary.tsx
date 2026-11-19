import type { Clip } from '@engine/project/model'
import { findEffect, propertySpec } from '@engine/keyframes/properties'
import { linksTo, removeLinks } from '@engine/timeline/modulation-edits'
import { effectById } from '../../../effects/registry'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'

/**
 * Effect Controls for an automation clip (W2, decision 127): what it controls (each value, with
 * the clip it's on, and × to let it go) and how to link more.
 */
export function AutomationSummary({ clip }: { clip: Clip }) {
  const project = projectController.project
  if (!project || !clip.automation) return null
  const targets = linksTo(project.sequence, clip.automation.modulatorId)
  const label = (t: (typeof targets)[number]) => {
    const spec = propertySpec(t.clip, t.ref.effectId, t.ref.param)
    const effect = t.ref.effectId ? findEffect(t.clip, t.ref.effectId) : null
    const where = effect ? `${effectById(effect.effectId)?.name ?? 'Effect'} · ` : ''
    return `${where}${spec?.label ?? t.ref.param}`
  }
  const sharing = project.sequence.clips.filter((c) => c.automation?.modulatorId === clip.automation!.modulatorId).length
  return (
    <div className="fx-automation">
      <div className="fx-clip">
        <span className="fx-clip-name">{clip.name}</span>
      </div>
      <p className="muted small">
        An automation clip: while it plays it sets the values below along its curve, and after it ends they hold its last point.
        {sharing > 1 ? ` ${sharing} clips share these values (split or copied from one another).` : ''}
      </p>
      <div className="fx-automation-targets">
        <span className="fx-section-title">Controls</span>
        {targets.length === 0 && <p className="muted small">Nothing yet. Right-click a value in Effect Controls › Create Automation Clip makes a clip linked to it.</p>}
        {targets.map((t) => (
          <div key={t.link.id} className="fx-automation-target">
            <button className="link-button" title="Show that clip" onClick={() => timelineController.select([t.clip.id], 'replace')}>
              {label(t)}
            </button>
            <span className="muted small">{t.clip.name}</span>
            <span className="spacer" />
            <button className="icon-button" title="Stop controlling this value" aria-label={`Unlink ${label(t)}`} onClick={() => projectController.dispatch(removeLinks(t.ref, t.link.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

import { frameRateOf } from '@engine/project/model'
import { formatTimecode } from '@engine/time'
import { projectController } from '../state/project-controller'
import { useObservable } from '../state/observable'

/** The program monitor frame, sized to the sequence. Playback of the timeline arrives in M4. */
export function ProgramMonitor() {
  useObservable(projectController)
  const project = projectController.project
  if (!project) return null
  const { settings } = project.sequence
  return (
    <section className="panel monitor-panel">
      <header className="panel-header">
        <span>Program: {project.sequence.name}</span>
        <span className="spacer" />
        <span className="mono muted">
          {settings.width} × {settings.height} · {settings.frameRate} fps
        </span>
      </header>
      <div className="monitor-area">
        <div className="monitor-frame" style={{ aspectRatio: `${settings.width} / ${settings.height}` }}>
          <span className="muted small">Timeline playback arrives in M4</span>
        </div>
      </div>
      <footer className="transport">
        <span className="mono timecode">{formatTimecode(0, frameRateOf(settings))}</span>
      </footer>
    </section>
  )
}

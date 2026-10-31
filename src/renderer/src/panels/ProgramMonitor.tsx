import { useEffect, useRef, useState } from 'react'
import { mediaController } from '../state/media-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { FramePreview, type PreviewStatus } from '../timeline/frame-preview'
import { timelineController } from '../timeline/timeline-controller'

/** The program monitor: in M3 a still of the frame under the playhead. Playback arrives in M4. */
export function ProgramMonitor() {
  useObservable(projectController)
  useObservable(timelineController)
  useObservable(mediaController)
  const project = projectController.project
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<FramePreview | null>(null)
  const [status, setStatus] = useState<PreviewStatus>({ kind: 'empty' })
  const settings = project?.sequence.settings
  const sequence = project?.sequence
  const playhead = timelineController.playhead

  useEffect(() => {
    if (!canvasRef.current) return
    const preview = new FramePreview(canvasRef.current)
    previewRef.current = preview
    return () => {
      preview.dispose()
      previewRef.current = null
    }
  }, [project?.id, settings?.width, settings?.height])

  // Redraw when the playhead, the edit, or a clip's media (optimised copy, relink) changes.
  const mediaVersion = mediaController.getVersion()
  useEffect(() => {
    if (!project || !previewRef.current) return
    // While a trim or move is being dragged, show the edit as it would be.
    previewRef.current.show(timelineController.sequence ?? project.sequence, project.media, playhead, setStatus)
  }, [sequence, timelineController.preview, playhead, mediaVersion, project?.media])

  if (!project || !settings) return null
  return (
    <section className="panel monitor-panel">
      <header className="panel-header">
        <span>Program: {project.sequence.name}</span>
        <span className="muted small monitor-note">Frame preview: top clip, fitted. Playback and effects arrive in M4</span>
        <span className="spacer" />
        <span className="mono muted">
          {settings.width} × {settings.height} · {settings.frameRate} fps
        </span>
      </header>
      <div className="monitor-area">
        <div className="monitor-frame" style={{ aspectRatio: `${settings.width} / ${settings.height}` }}>
          <canvas ref={canvasRef} className="monitor-canvas" width={settings.width} height={settings.height} />
          {status.kind === 'message' && <span className="monitor-message small">{status.text}</span>}
        </div>
      </div>
      <footer className="transport">
        <span className="mono timecode">{timelineController.timecode(playhead)}</span>
        {status.kind === 'frame' && <span className="muted small">{status.clip.name}</span>}
      </footer>
    </section>
  )
}

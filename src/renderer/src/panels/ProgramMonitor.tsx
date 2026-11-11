import { useEffect, useRef } from 'react'
import { Icon } from '../app/Icon'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { player, type PlaybackResolution } from '../playback/player'
import { timelineController } from '../timeline/timeline-controller'
import { MaskOverlay } from '../masks/MaskOverlay'
import { workspaceController } from '../state/workspace'
import type { Frame } from '../workspace/layout'

const RESOLUTIONS: Array<{ value: PlaybackResolution; label: string }> = [
  { value: 1, label: 'Full' },
  { value: 0.5, label: '1/2' },
  { value: 0.25, label: '1/4' }
]

/** The preview panel, so the Control Panel can make it full screen. */
let previewPanel: HTMLElement | null = null

/** Full-screen preview (Control Panel): the preview fills the screen; Esc or the button again leaves. */
export function togglePreviewFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen()
  else void previewPanel?.requestFullscreen().catch((error: Error) => projectController.showMessage(`Full screen didn't start: ${error.message}`))
}

/** The program monitor: the composited sequence at the playhead, and timeline playback. */
export function ProgramMonitor({ frame = 'landscape' }: { frame?: Frame }) {
  useObservable(projectController)
  useObservable(timelineController)
  useObservable(player)
  const project = projectController.project
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    previewPanel = panelRef.current
    return () => {
      if (previewPanel === panelRef.current) previewPanel = null
    }
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    void player.attach(canvas)
    return () => player.detach(canvas)
  }, [project?.id])

  if (!project) return null
  const settings = project.sequence.settings
  const stats = player.stats
  const portrait = frame === 'portrait'
  const timecode = <span className="mono timecode">{timelineController.timecode(timelineController.playhead)}</span>
  const tools = (
    <span className="transport-right">
      <select
        className="input compact"
        title="Playback resolution: lower is lighter on the GPU"
        value={player.resolution}
        onChange={(event) => player.setResolution(Number(event.target.value) as PlaybackResolution)}
      >
        {RESOLUTIONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      <button className={`tool-button ${player.showStats ? 'active' : ''}`} title="Timing overlay: fps, dropped frames, render time, A/V offset" onClick={() => player.toggleStats()}>
        <Icon name="gauge" fallback="fps" />
      </button>
      <button className="tool-button" title="Sequence settings: size, frame rate, sample rate" aria-label="Sequence settings" onClick={() => workspaceController.open('project-settings')}>
        <Icon name="gear" fallback="⚙" />
      </button>
    </span>
  )
  return (
    <section className="panel monitor-panel" ref={panelRef}>
      {portrait ? (
        // The mobile wireframe: resolution and settings over the picture, the transport under it.
        <header className="panel-header monitor-top">
          {tools}
          <span className="spacer" />
          {timecode}
        </header>
      ) : (
        <header className="panel-header">
          <span>Preview · {project.sequence.name}</span>
          <span className="spacer" />
          <span className="mono muted">
            {settings.width} × {settings.height} · {settings.frameRate} fps
          </span>
        </header>
      )}
      <div className="monitor-area" onDoubleClick={() => player.toggleStats()}>
        <div className="monitor-frame" style={{ aspectRatio: `${settings.width} / ${settings.height}`, ['--ar' as string]: settings.width / settings.height }}>
          <canvas ref={canvasRef} className="monitor-canvas" width={settings.width} height={settings.height} />
          <MaskOverlay width={settings.width} height={settings.height} />
          {player.message && <span className="monitor-message small">{player.message}</span>}
          {player.showStats && (
            <div className="monitor-stats mono">
              <div>{player.playing ? `${stats.fps.toFixed(1)} fps` : 'paused'}</div>
              <div>dropped {stats.dropped}</div>
              <div>render {stats.renderMs.toFixed(1)} ms</div>
              <div>A/V {stats.lagMs >= 0 ? '+' : ''}{stats.lagMs.toFixed(0)} ms</div>
              <div>{player.resolution === 1 ? 'Full' : player.resolution === 0.5 ? '1/2' : '1/4'} resolution</div>
              {player.temporal && player.temporal.bytes() > 0 && (
                <div title="Stateful effects' kept frames and checkpoints; approximate frames carried on from an older state after a drop">
                  states {Math.round(player.temporal.bytes() / 1e6)} MB{player.temporal.stats.approximate > 0 ? ` · ${player.temporal.stats.approximate} approx` : ''}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <footer className={`transport ${portrait ? 'centred' : ''}`}>
        {!portrait && timecode}
        <span className="transport-buttons">
          <button className="tool-button" title="Go to the start (Home)" aria-label="Go to the start" onClick={() => timelineController.gotoEnd(false)}>
            <Icon name="goToStart" fallback="⏮︎" />
          </button>
          <button className="tool-button" title="Back one frame (←)" onClick={() => timelineController.stepFrames(-1)}>
            <Icon name="stepBack" fallback="◀︎" />
          </button>
          <button className="tool-button transport-play" title={player.playing ? 'Pause (Space)' : 'Play (Space). J/K/L shuttle'} onClick={() => player.toggle()}>
            <Icon name={player.playing ? 'pause' : 'play'} fallback={player.playing ? 'Pause' : 'Play'} />
          </button>
          <button className="tool-button" title="Forward one frame (→)" onClick={() => timelineController.stepFrames(1)}>
            <Icon name="stepForward" fallback="▶︎" />
          </button>
          <button className="tool-button" title="Go to the end (End)" aria-label="Go to the end" onClick={() => timelineController.gotoEnd(true)}>
            <Icon name="goToEnd" fallback="⏭︎" />
          </button>
          {player.playing && player.rate !== 1 && <span className="mono small muted">{`${player.rate}×`}</span>}
        </span>
        {!portrait && tools}
      </footer>
    </section>
  )
}

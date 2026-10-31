import { useEffect, useRef } from 'react'
import { Icon } from '../app/Icon'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { player, type PlaybackResolution } from '../playback/player'
import { timelineController } from '../timeline/timeline-controller'

const RESOLUTIONS: Array<{ value: PlaybackResolution; label: string }> = [
  { value: 1, label: 'Full' },
  { value: 0.5, label: '1/2' },
  { value: 0.25, label: '1/4' }
]

/** The program monitor: the composited sequence at the playhead, and timeline playback. */
export function ProgramMonitor() {
  useObservable(projectController)
  useObservable(timelineController)
  useObservable(player)
  const project = projectController.project
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    void player.attach(canvas)
    return () => player.detach(canvas)
  }, [project?.id])

  if (!project) return null
  const settings = project.sequence.settings
  const stats = player.stats
  return (
    <section className="panel monitor-panel">
      <header className="panel-header">
        <span>Program: {project.sequence.name}</span>
        <span className="spacer" />
        <span className="mono muted">
          {settings.width} × {settings.height} · {settings.frameRate} fps
        </span>
      </header>
      <div className="monitor-area" onDoubleClick={() => player.toggleStats()}>
        <div className="monitor-frame" style={{ aspectRatio: `${settings.width} / ${settings.height}` }}>
          <canvas ref={canvasRef} className="monitor-canvas" width={settings.width} height={settings.height} />
          {player.message && <span className="monitor-message small">{player.message}</span>}
          {player.showStats && (
            <div className="monitor-stats mono">
              <div>{player.playing ? `${stats.fps.toFixed(1)} fps` : 'paused'}</div>
              <div>dropped {stats.dropped}</div>
              <div>render {stats.renderMs.toFixed(1)} ms</div>
              <div>A/V {stats.lagMs >= 0 ? '+' : ''}{stats.lagMs.toFixed(0)} ms</div>
              <div>{player.resolution === 1 ? 'Full' : player.resolution === 0.5 ? '1/2' : '1/4'} resolution</div>
            </div>
          )}
        </div>
      </div>
      <footer className="transport">
        <span className="mono timecode">{timelineController.timecode(timelineController.playhead)}</span>
        <span className="transport-buttons">
          <button className="tool-button" title="Back one frame (←)" onClick={() => timelineController.stepFrames(-1)}>
            <Icon name="stepBack" fallback="◀︎" />
          </button>
          <button className="tool-button transport-play" title={player.playing ? 'Stop (Space)' : 'Play (Space). J/K/L shuttle'} onClick={() => player.toggle()}>
            <Icon name={player.playing ? 'stop' : 'play'} fallback={player.playing ? 'Stop' : 'Play'} />
          </button>
          <button className="tool-button" title="Forward one frame (→)" onClick={() => timelineController.stepFrames(1)}>
            <Icon name="stepForward" fallback="▶︎" />
          </button>
          {player.playing && player.rate !== 1 && <span className="mono small muted">{player.rate > 0 ? `${player.rate}×` : `${player.rate}×`}</span>}
        </span>
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
        </span>
      </footer>
    </section>
  )
}

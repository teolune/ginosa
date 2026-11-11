import { useState } from 'react'
import { MAX_BPM, MIN_BPM, barNumber, beatAt } from '@engine/audio/beat-grid'
import type { BeatGrid } from '@engine/project/model'
import type { Ticks } from '@engine/time'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { Icon } from '../app/Icon'
import { analysisController } from '../audio/analysis-controller'
import { changeTempo, detectTempo } from './actions'
import { togglePreviewFullscreen } from '../panels/ProgramMonitor'
import { player } from '../playback/player'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import type { FrameChoice } from '../workspace/layout'
import { BpmKnob } from './BpmKnob'

/** The tempo the knob shows before there is a beat grid. */
const UNSET_BPM = 120

const FRAMES: Array<{ value: FrameChoice; label: string }> = [
  { value: 'auto', label: 'Auto: follow the sequence shape' },
  { value: 'landscape', label: 'Landscape (desktop)' },
  { value: 'portrait', label: 'Portrait (mobile)' }
]

function Divider() {
  return <span className="cp-divider" aria-hidden="true" />
}

/**
 * The Control Panel (the wireframe's top bar): tempo, transport, new things at the playhead,
 * and the switches for the panels and windows around the preview.
 */
export function ControlPanel() {
  useObservable(projectController)
  useObservable(player, ['state'])
  useObservable(workspaceController)
  useObservable(analysisController)
  const [framesMenu, setFramesMenu] = useState<{ x: number; y: number } | null>(null)
  const sequence = projectController.project?.sequence
  if (!sequence) return null
  const grid = sequence.beatGrid
  const bpm = grid?.bpm ?? UNSET_BPM
  const pending = analysisController.pendingTempo
  const pendingStatus = pending ? analysisController.state(pending).status.kind : null
  const detecting = pendingStatus === 'queued' || pendingStatus === 'mixing' || pendingStatus === 'analysing'
  const layout = workspaceController.layout
  const rackOpen = workspaceController.isOpen('channel-rack')
  const playing = player.playing

  const frameItems: MenuEntry[] = FRAMES.map((f) => ({
    label: `${layout.frame === f.value ? '✓ ' : '   '}${f.label}`,
    onSelect: () => workspaceController.setFrame(f.value)
  }))

  return (
    <div className="control-panel" role="toolbar" aria-label="Control Panel">
      <div className="cp-group cp-tempo">
        <BpmKnob bpm={bpm} set={grid !== null} onChange={changeTempo} onInvalid={(message) => projectController.showMessage(message)} />
        <span className="cp-stack">
          <button
            className={`cp-button ${detecting ? 'busy' : ''}`}
            title={detecting ? 'Listening for the tempo…' : 'Automatic Detection: find the tempo and downbeat of the music'}
            aria-label="Detect tempo"
            onClick={detectTempo}
            disabled={detecting}
          >
            <Icon name="sparkles" fallback="✦" />
          </button>
          <button className="cp-button" disabled title="Automate BPM: tempo changes over time come with automation clips (the next phase)" aria-label="Automate tempo">
            <Icon name="automate" fallback="∿" />
          </button>
        </span>
        <span className="cp-stack">
          <button className="cp-button small" title="Double the tempo" aria-label="Double the tempo" disabled={bpm * 2 > MAX_BPM} onClick={() => changeTempo(bpm * 2, 'Double Tempo')}>
            <Icon name="tempoUp" fallback="▲" />
          </button>
          <button className="cp-button small" title="Halve the tempo" aria-label="Halve the tempo" disabled={bpm / 2 < MIN_BPM} onClick={() => changeTempo(bpm / 2, 'Halve Tempo')}>
            <Icon name="chevronDown" fallback="▼" />
          </button>
        </span>
      </div>
      <Divider />
      <div className="cp-group cp-transport">
        <button className="cp-button" title="Back to the start (Home)" aria-label="Back to the start" onClick={() => timelineController.gotoEnd(false)}>
          <Icon name="goToStart" fallback="⏮︎" />
        </button>
        <button className={`cp-button cp-play ${playing ? 'on' : ''}`} title={playing ? 'Pause (Space): stays here' : 'Play (Space)'} aria-label={playing ? 'Pause' : 'Play'} onClick={() => player.toggle()}>
          <Icon name={playing ? 'pause' : 'play'} fallback={playing ? '❚❚' : '▶'} />
        </button>
        <button
          className="cp-button"
          title="Stop: back to where Play started. Press again for the start."
          aria-label="Stop"
          onClick={() => player.stopAndReturn()}
        >
          <Icon name="stop" fallback="■" />
        </button>
        <button className="cp-button" title="Skip to the end (End)" aria-label="Skip to the end" onClick={() => timelineController.gotoEnd(true)}>
          <Icon name="goToEnd" fallback="⏭︎" />
        </button>
      </div>
      <Divider />
      <div className="cp-group">
        <button className="cp-button" disabled title="New automation clip at the playhead: comes in the next phase (an FL-style keyframe editor)" aria-label="New automation clip">
          <Icon name="automationClip" fallback="⤳" />
        </button>
        <button className="cp-button" title="New adjustment layer at the playhead, above the clips there" aria-label="New adjustment layer" onClick={() => timelineController.newAdjustmentLayer()}>
          <Icon name="adjustmentLayer" fallback="▤" />
        </button>
      </div>
      <Divider />
      <div className="cp-group">
        <button className={`cp-button ${rackOpen ? 'on' : ''}`} title={rackOpen ? 'Close the Channel Rack' : 'Open the Channel Rack'} aria-label="Channel Rack" onClick={() => workspaceController.toggle('channel-rack')}>
          <Icon name="channelRack" fallback="▦" />
        </button>
        <button className={`cp-button ${layout.mediaOpen ? 'on' : ''}`} title={layout.mediaOpen ? 'Close the import folder' : 'Open the import folder'} aria-label="Import folder" onClick={() => workspaceController.toggleMedia()}>
          <Icon name="sidebarLeft" fallback="▯" />
        </button>
        <button className="cp-button" title="Full-screen preview (Esc to leave)" aria-label="Full-screen preview" onClick={togglePreviewFullscreen}>
          <Icon name="fullscreen" fallback="⤢" />
        </button>
        <button
          className={`cp-button ${player.metronome ? 'on' : ''}`}
          title={grid ? `Metronome: clicks on the beat grid while playing (${player.metronome ? 'on' : 'off'})` : 'Metronome: set a tempo first, then it clicks on each beat while playing'}
          aria-label="Metronome"
          onClick={() => player.setMetronome(!player.metronome)}
        >
          <Icon name="metronome" fallback="♩" />
        </button>
        <button
          className="cp-button"
          title="Frames: where the panels sit (landscape, portrait, or follow the sequence)"
          aria-label="Frames"
          onClick={(event) => {
            const r = event.currentTarget.getBoundingClientRect()
            setFramesMenu({ x: r.left, y: r.bottom + 4 })
          }}
        >
          <Icon name="frames" fallback="▥" />
        </button>
      </div>
      <span className="spacer" />
      <span className="cp-time mono" title="Playhead">
        <PlayheadTime />
      </span>
      {framesMenu && <ContextMenu x={framesMenu.x} y={framesMenu.y} items={frameItems} onClose={() => setFramesMenu(null)} />}
    </div>
  )
}

/** The playhead's timecode, in its own component so only it re-renders during playback. */
function PlayheadTime() {
  useObservable(timelineController, ['playhead'], { throttle: { playhead: 50 } })
  const grid = projectController.project?.sequence.beatGrid
  const time = timelineController.playhead
  return (
    <>
      <span>{timelineController.timecode(time)}</span>
      {grid && <span className="muted"> · bar {barBeat(grid, time)}</span>}
    </>
  )
}

function barBeat(grid: BeatGrid, time: Ticks): string {
  const beat = Math.floor(beatAt(grid, time) + 1e-9)
  return `${barNumber(grid, time)}.${(((beat % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar) + 1}`
}

import { useState } from 'react'
import { addTrack, removeTrack, renameProject, setSequenceSettings } from '@engine/project/commands'
import { RESOLUTION_PRESETS } from '@engine/project/model'
import { FRAME_RATES, type FrameRateName } from '@engine/time'
import { CommitInput } from '../app/CommitInput'
import { projectController } from '../state/project-controller'
import { useObservable } from '../state/observable'

const FRAME_RATE_NAMES = Object.keys(FRAME_RATES) as FrameRateName[]

/** Project and sequence settings. Every change here is an undoable command. */
export function ProjectSettingsWindow() {
  useObservable(projectController)
  const project = projectController.project
  const [customW, setCustomW] = useState('')
  const [customH, setCustomH] = useState('')
  if (!project) return null
  const { settings, tracks } = project.sequence
  const presetIndex = RESOLUTION_PRESETS.findIndex((p) => p.width === settings.width && p.height === settings.height)

  const applyCustom = () => {
    const width = Number(customW || settings.width)
    const height = Number(customH || settings.height)
    if (projectController.dispatch(setSequenceSettings({ width, height }))) {
      setCustomW('')
      setCustomH('')
    }
  }

  return (
    <div className="form">
      <label className="field">
        <span>Project name</span>
        <CommitInput className="input" value={project.name} onCommit={(name) => projectController.dispatch(renameProject(name))} />
      </label>

      <div className="form-section">Sequence</div>
      <label className="field">
        <span>Frame size</span>
        <select
          className="input"
          value={presetIndex === -1 ? 'custom' : String(presetIndex)}
          onChange={(event) => {
            const preset = RESOLUTION_PRESETS[Number(event.target.value)]
            if (preset) projectController.dispatch(setSequenceSettings({ width: preset.width, height: preset.height }))
          }}
        >
          {RESOLUTION_PRESETS.map((preset, index) => (
            <option key={preset.label} value={String(index)}>
              {preset.label}
            </option>
          ))}
          {presetIndex === -1 && <option value="custom">Custom {settings.width} × {settings.height}</option>}
        </select>
      </label>
      <div className="field-row">
        <input className="input mono" placeholder={String(settings.width)} value={customW} onChange={(e) => setCustomW(e.target.value)} aria-label="Custom width" />
        <span className="muted">×</span>
        <input className="input mono" placeholder={String(settings.height)} value={customH} onChange={(e) => setCustomH(e.target.value)} aria-label="Custom height" />
        <button className="button" onClick={applyCustom} disabled={!customW && !customH}>
          Set
        </button>
      </div>
      <label className="field">
        <span>Frame rate</span>
        <select
          className="input"
          value={settings.frameRate}
          onChange={(event) => projectController.dispatch(setSequenceSettings({ frameRate: event.target.value as FrameRateName }))}
        >
          {FRAME_RATE_NAMES.map((name) => (
            <option key={name} value={name}>
              {name} fps
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>Audio</span>
        <span className="mono">{settings.sampleRate / 1000} kHz</span>
      </div>

      <div className="form-section">Tracks</div>
      <div className="track-summary">
        <span>
          {tracks.filter((t) => t.kind === 'video').length} video · {tracks.filter((t) => t.kind === 'audio').length} audio
        </span>
        <span className="spacer" />
        <button className="button" onClick={() => projectController.dispatch(addTrack('video'))}>
          + Video
        </button>
        <button className="button" onClick={() => projectController.dispatch(addTrack('audio'))}>
          + Audio
        </button>
      </div>
      <ul className="track-list">
        {[...tracks.filter((t) => t.kind === 'video'), ...tracks.filter((t) => t.kind === 'audio')].map((track) => (
          <li key={track.id}>
            <span className={`kind-dot ${track.kind}`} />
            <span>{track.name}</span>
            <span className="spacer" />
            <button className="icon-button" title={`Delete ${track.name}`} onClick={() => projectController.dispatch(removeTrack(track.id))}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

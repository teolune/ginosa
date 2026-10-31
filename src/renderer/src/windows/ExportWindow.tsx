import { useState } from 'react'
import { DEFAULT_EXPORT, FORMATS, exportProblem, suggestedBitrate, type ExportContainer, type ExportFormat, type ExportSettings } from '@engine/export/export-settings'
import { frameRateOf } from '@engine/project/model'
import { formatTimecode, frameRateValue } from '@engine/time'
import { sequenceEnd } from '@engine/timeline/timeline'
import { exporter } from '../playback/exporter'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'

const STORAGE_KEY = 'ginosa.export.settings'

function loadSettings(): ExportSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<ExportSettings> | null
    if (saved && saved.format && saved.format in FORMATS) return { ...DEFAULT_EXPORT, ...saved }
  } catch {
    // ignore: defaults
  }
  return DEFAULT_EXPORT
}

function saveSettings(settings: ExportSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // not essential
  }
}

function megabytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`
}

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`
}

/**
 * Export (⌘M), like Premiere's Export Settings: format, quality, where to save, then
 * progress. The export works from a snapshot of the edit taken when it starts, so you
 * can keep editing meanwhile.
 */
export function ExportWindow() {
  useObservable(projectController)
  useObservable(exporter)
  const project = projectController.project
  const [settings, setSettingsState] = useState<ExportSettings>(loadSettings)
  const [output, setOutput] = useState<string | null>(null)
  if (!project) return null
  const sequence = project.sequence
  const rate = frameRateOf(sequence.settings)
  const end = sequenceEnd(sequence)
  const info = FORMATS[settings.format]
  const problem = end === 0 ? 'The timeline is empty' : exportProblem(settings, sequence.settings.width, sequence.settings.height)
  const state = exporter.state
  const running = state.kind === 'running'

  const update = (changes: Partial<ExportSettings>) => {
    const next = { ...settings, ...changes }
    if (!FORMATS[next.format].containers.includes(next.container)) next.container = FORMATS[next.format].containers[0]!
    setSettingsState(next)
    saveSettings(next)
    if (output && changes.container) setOutput(output.replace(/\.(mp4|mov)$/i, `.${next.container}`))
  }
  const chooseOutput = async () => {
    const name = `${project.name}${sequence.name ? ` - ${sequence.name}` : ''}.${settings.container}`
    const folder = projectController.path ? projectController.path.replace(/\/[^/]*$/, '') : null
    const path = await window.ginosa.export.chooseFile(folder ? `${folder}/${name}` : name, settings.container)
    if (path) setOutput(path)
    return path
  }
  const start = async () => {
    const path = output ?? (await chooseOutput())
    if (!path) return
    await exporter.run(project, settings, path)
  }
  const estimate = info.bitrate ? ((settings.bitrateMbps * 1e6 + 320e3) / 8) * (end / 254_016_000_000) : null

  return (
    <div className="form export-window">
      <div className="export-summary muted small">
        {sequence.name} · {sequence.settings.width} × {sequence.settings.height} · {Math.round(frameRateValue(rate) * 1000) / 1000} fps · {formatTimecode(end, rate)}
      </div>

      <label className="field">
        <span>Format</span>
        <select className="input" value={settings.format} disabled={running} onChange={(e) => update({ format: e.target.value as ExportFormat, bitrateMbps: suggestedBitrate(sequence.settings.width, sequence.settings.height, rate, e.target.value as ExportFormat) })}>
          {(Object.keys(FORMATS) as ExportFormat[]).map((format) => (
            <option key={format} value={format}>
              {FORMATS[format].label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>File type</span>
        <select className="input" value={settings.container} disabled={running || info.containers.length === 1} onChange={(e) => update({ container: e.target.value as ExportContainer })}>
          {info.containers.map((c) => (
            <option key={c} value={c}>
              {c === 'mp4' ? 'MPEG-4 (.mp4)' : 'QuickTime (.mov)'}
            </option>
          ))}
        </select>
      </label>
      {info.bitrate && (
        <>
          <label className="field">
            <span>Bitrate</span>
            <span className="field-unit">
              <input className="input mono" type="number" min={1} max={400} step={1} value={settings.bitrateMbps} disabled={running} onChange={(e) => update({ bitrateMbps: Number(e.target.value) })} />
              Mbit/s
              <button type="button" className="button compact" disabled={running} onClick={() => update({ bitrateMbps: suggestedBitrate(sequence.settings.width, sequence.settings.height, rate, settings.format) })}>
                Suggested
              </button>
            </span>
          </label>
          <label className="field">
            <span>Keyframe every</span>
            <span className="field-unit">
              <input className="input mono" type="number" min={0.1} max={10} step={0.5} value={settings.keyframeSeconds} disabled={running} onChange={(e) => update({ keyframeSeconds: Number(e.target.value) })} />s
            </span>
          </label>
        </>
      )}
      <div className="field">
        <span>Picture</span>
        <span className="small">
          {info.bitDepth}-bit, Rec.709 tags{settings.format === 'h264' || settings.format.startsWith('hevc') ? ', hardware encoder' : ''}
        </span>
      </div>
      <div className="field">
        <span>Sound</span>
        <span className="small">{info.bitrate ? 'AAC 320 kbit/s' : '24-bit PCM'}, 48 kHz stereo</span>
      </div>
      <div className="field">
        <span>Save as</span>
        <span className="export-path small">
          <span className="mono" title={output ?? undefined}>
            {output ? output.split('/').pop() : 'Choose when you export'}
          </span>
          <button type="button" className="button compact" disabled={running} onClick={() => void chooseOutput()}>
            Choose…
          </button>
        </span>
      </div>
      {estimate !== null && <p className="muted small">About {megabytes(estimate)}.</p>}
      {problem && <p className="modal-note error">{problem}</p>}

      {state.kind === 'running' && (
        <div className="export-progress">
          <progress max={state.frames} value={state.frame} />
          <div className="small">
            {state.stage === 'checking' && 'Getting ready…'}
            {state.stage === 'sound' && 'Mixing the sound…'}
            {state.stage === 'frames' &&
              `Frame ${state.frame} of ${state.frames} · ${state.fps.toFixed(0)} fps${state.fps > 0 ? ` · ${duration((state.frames - state.frame) / state.fps)} left` : ''}`}
            {state.stage === 'finishing' && 'Finishing the file…'}
          </div>
        </div>
      )}
      {state.kind === 'done' && (
        <p className="small export-done">
          Exported {state.result.path.split('/').pop()} in {duration(state.seconds)} ({state.fps.toFixed(0)} fps), {megabytes(state.result.size)}.{' '}
          <button type="button" className="button compact" onClick={() => void window.ginosa.media.reveal(state.result.path)}>
            Show in Finder
          </button>
        </p>
      )}
      {state.kind === 'failed' && <p className="modal-note error">Export failed: {state.error}</p>}
      {state.kind === 'cancelled' && <p className="muted small">Export cancelled. Nothing was written.</p>}

      <div className="modal-actions">
        {running ? (
          <button type="button" className="button" onClick={() => exporter.cancel()}>
            Cancel Export
          </button>
        ) : (
          <button type="button" className="button primary" disabled={problem !== null} onClick={() => void start()}>
            Export
          </button>
        )}
      </div>
    </div>
  )
}

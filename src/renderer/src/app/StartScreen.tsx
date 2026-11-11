import { useState } from 'react'
import { newProjectSize, parseRatio, type NewProjectChoice, type ResolutionChoice } from '@engine/project/new-project'
import { FRAME_RATES, type FrameRateName } from '@engine/time'
import { projectController } from '../state/project-controller'
import { useObservable } from '../state/observable'
import { Logo } from './Logo'

const RESOLUTIONS: Array<{ value: ResolutionChoice; label: string }> = [
  { value: 'custom', label: 'Custom Resolution' },
  { value: '1080p', label: '1080p Video' },
  { value: '4k', label: '4K Video' }
]

const FRAME_RATE_NAMES = Object.keys(FRAME_RATES) as FrameRateName[]
const REMEMBER_KEY = 'ginosa.new-project'

interface Remembered {
  resolution: ResolutionChoice
  portrait: boolean
  ratioOn: boolean
  ratioText: string
  width: string
  height: string
  frameRate: FrameRateName
}

const DEFAULTS: Remembered = { resolution: '1080p', portrait: false, ratioOn: false, ratioText: '4:5', width: '1920', height: '1080', frameRate: '25' }

/** The last choices, so making several projects in a row is quick (kept in this browser profile only). */
function recall(): Remembered {
  try {
    const saved = JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? 'null') as Partial<Remembered> | null
    const merged = { ...DEFAULTS, ...saved }
    if (!RESOLUTIONS.some((r) => r.value === merged.resolution)) merged.resolution = DEFAULTS.resolution
    if (!FRAME_RATE_NAMES.includes(merged.frameRate)) merged.frameRate = DEFAULTS.frameRate
    return merged
  } catch {
    return DEFAULTS
  }
}

function remember(choice: Remembered): void {
  try {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(choice))
  } catch {
    // Storage unavailable: nothing to remember.
  }
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The title screen (the wireframe): the mark, New Project with its sizes and shapes, and Recent. */
export function StartScreen() {
  useObservable(projectController)
  const recent = projectController.recent
  const [choice, setChoice] = useState<Remembered>(recall)
  const update = (change: Partial<Remembered>) => setChoice((c) => ({ ...c, ...change }))

  const custom = choice.resolution === 'custom'
  const ratio = choice.ratioOn ? parseRatio(choice.ratioText) : null
  const request: NewProjectChoice = {
    resolution: choice.resolution,
    portrait: choice.portrait,
    ratio,
    size: { width: Number(choice.width), height: Number(choice.height) }
  }
  const size = choice.ratioOn && !custom && !ratio ? { error: 'Type a ratio like 4:5, 1:1 or 2.39:1' } : newProjectSize(request)
  const error = 'error' in size ? size.error : null

  const create = () => {
    if ('error' in size) return
    remember(choice)
    void projectController.newProject({ width: size.width, height: size.height, frameRate: choice.frameRate })
  }

  return (
    <div className="start-screen">
      <div className="start-card">
        <div className="start-brand">
          <Logo size={58} />
          <span className="wordmark large">ginosa</span>
        </div>
        <div className="start-panels">
          <section className="start-panel new-project" aria-label="New Project">
            <h2 className="start-heading">New Project</h2>
            <div className="choice-list" role="radiogroup" aria-label="Resolution">
              {RESOLUTIONS.map((r) => (
                <button
                  key={r.value}
                  role="radio"
                  aria-checked={choice.resolution === r.value}
                  className={`choice ${choice.resolution === r.value ? 'on' : ''}`}
                  onClick={() => update({ resolution: r.value })}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {custom && (
              <div className="size-inputs">
                <input className="input mono" aria-label="Width" inputMode="numeric" value={choice.width} onChange={(e) => update({ width: e.target.value.trim() })} />
                <span className="muted">×</span>
                <input className="input mono" aria-label="Height" inputMode="numeric" value={choice.height} onChange={(e) => update({ height: e.target.value.trim() })} />
              </div>
            )}
            <div className="start-rule" />
            <div className={`ratio-row ${custom || choice.ratioOn ? 'dimmed' : ''}`}>
              <span className="shape-icon landscape" aria-hidden="true" />
              <span className={!choice.portrait ? 'on' : ''}>16:9</span>
              <button
                role="switch"
                aria-checked={choice.portrait}
                aria-label="Portrait (9:16)"
                className={`switch ${choice.portrait ? 'right' : ''}`}
                disabled={custom}
                title="16:9 landscape or 9:16 portrait"
                onClick={() => update({ portrait: !choice.portrait, ratioOn: false })}
              >
                <span className="switch-knob" />
              </button>
              <span className={choice.portrait ? 'on' : ''}>9:16</span>
              <span className="shape-icon portrait" aria-hidden="true" />
            </div>
            <div className={`custom-ratio ${custom ? 'dimmed' : ''}`}>
              <button role="radio" aria-checked={choice.ratioOn} className={`radio ${choice.ratioOn ? 'on' : ''}`} disabled={custom} onClick={() => update({ ratioOn: !choice.ratioOn })}>
                <span className="radio-dot" />
                Custom Ratio
              </button>
              {choice.ratioOn && !custom && (
                <input className="input compact mono ratio-input" aria-label="Ratio" value={choice.ratioText} onChange={(e) => update({ ratioText: e.target.value })} placeholder="4:5" />
              )}
            </div>
            <div className="new-footer">
              <select className="input compact" aria-label="Frame rate" value={choice.frameRate} onChange={(e) => update({ frameRate: e.target.value as FrameRateName })}>
                {FRAME_RATE_NAMES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate} fps
                  </option>
                ))}
              </select>
              <span className={`mono small ${error ? 'error-text' : 'muted'}`} title={error ?? undefined}>
                {error ? 'Check the size' : `${'width' in size ? size.width : 0} × ${'height' in size ? size.height : 0}`}
              </span>
              <span className="spacer" />
              <button className="button primary create-button" disabled={error !== null} onClick={create}>
                Create
              </button>
            </div>
            {error && <p className="error-text small new-error">{error}</p>}
          </section>
          <section className="start-panel recent-panel" aria-label="Recent">
            <header className="recent-head">
              <h2 className="start-heading">Recent</h2>
              <span className="muted small">Date Created</span>
            </header>
            {recent.length === 0 ? (
              <p className="muted small recent-empty">No recent projects yet.</p>
            ) : (
              <ul className="recent-list">
                {recent.map((item) => (
                  <li
                    key={item.path}
                    onClick={() => void projectController.open(item.path)}
                    title={`${item.path}\nLast opened ${new Date(item.openedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`}
                  >
                    <span className="recent-name">{item.name}</span>
                    <span className="muted small">{formatDate(item.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            <footer className="recent-foot">
              <button className="button" onClick={() => void projectController.open()}>
                Open Project…
              </button>
            </footer>
          </section>
        </div>
      </div>
    </div>
  )
}

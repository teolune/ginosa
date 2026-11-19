import { useEffect } from 'react'
import { projectController, type ProjectTab, type SaveStatus } from '../state/project-controller'
import { useObservable } from '../state/observable'
import { ClefBarMark } from './Logo'

function describe(status: SaveStatus, dirty: boolean): string {
  switch (status.kind) {
    case 'saving':
      return 'Saving…'
    case 'error':
      return status.message
    case 'autosaved':
      return `Unsaved · autosaved ${status.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    case 'dirty':
      return 'Unsaved changes'
    case 'clean':
      if (dirty) return 'Unsaved changes'
      return status.at ? `Saved ${status.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Saved'
  }
}

/** One open project, as a tab in Chrome (decision 128): click to show it, × or a middle click to close it. */
function Tab({ tab, active }: { tab: ProjectTab; active: boolean }) {
  const name = tab.project.name
  const close = () => void projectController.closeTab(tab)
  return (
    <div
      className={`project-tab${active ? ' active' : ''}`}
      role="tab"
      aria-selected={active}
      title={tab.path}
      onClick={() => projectController.switchTo(tab)}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onAuxClick={(event) => {
        if (event.button === 1) close()
      }}
    >
      <span className="project-tab-name">{name}</span>
      {tab.isDirty && <span className="dirty-dot" title="Unsaved changes" />}
      <button
        className="project-tab-close"
        aria-label={`Close ${name}`}
        title={`Close ${name}`}
        onClick={(event) => {
          event.stopPropagation()
          close()
        }}
      >
        ×
      </button>
    </div>
  )
}

/** Full screen hides the window buttons: the clef moves into their space (decision 128). */
export function setFullScreenLook(fullScreen: boolean): void {
  document.documentElement.classList.toggle('full-screen', fullScreen)
}

export function TitleBar() {
  useObservable(projectController)
  useEffect(() => window.ginosa.app.onFullScreen(setFullScreenLook), [])
  const active = projectController.active
  return (
    <header className="titlebar">
      <button
        className={`home-button${active ? '' : ' active'}`}
        aria-label="Home"
        title="Home: your projects (⇧⌘H)"
        onClick={() => projectController.showHome()}
      >
        <ClefBarMark />
      </button>
      <div className="project-tabs" role="tablist">
        {projectController.tabs.map((tab) => (
          <Tab key={tab.key} tab={tab} active={tab === active} />
        ))}
      </div>
      <span className="spacer" />
      {active && (
        <span className={`save-status ${active.status.kind === 'error' ? 'error-text' : 'muted'}`}>{describe(active.status, active.isDirty)}</span>
      )}
      <span className="milestone muted">M14</span>
    </header>
  )
}

import { projectController, type SaveStatus } from '../state/project-controller'
import { useObservable } from '../state/observable'

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

export function TitleBar() {
  useObservable(projectController)
  const project = projectController.project
  const dirty = projectController.isDirty
  return (
    <header className="titlebar">
      <span className="wordmark">ginosa</span>
      {project && (
        <>
          <span className="titlebar-project">
            {project.name}
            {dirty && <span className="dirty-dot" title="Unsaved changes" />}
          </span>
          <span className="spacer" />
          <span className={`save-status ${projectController.status.kind === 'error' ? 'error-text' : 'muted'}`}>
            {describe(projectController.status, dirty)}
          </span>
        </>
      )}
      {!project && <span className="spacer" />}
      <span className="milestone muted">M13</span>
    </header>
  )
}

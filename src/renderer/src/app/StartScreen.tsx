import { projectController } from '../state/project-controller'
import { useObservable } from '../state/observable'

/** Shown when no project is open, like Premiere's Home screen. */
export function StartScreen() {
  useObservable(projectController)
  const recent = projectController.recent
  return (
    <div className="start-screen">
      <div className="start-card">
        <h1 className="wordmark large">ginosa</h1>
        <p className="muted">Music video editor and visual effects workstation</p>
        <div className="start-actions">
          <button className="button primary large" onClick={() => void projectController.newProject()}>
            New Project…
          </button>
          <button className="button large" onClick={() => void projectController.open()}>
            Open Project…
          </button>
        </div>
        <h2 className="section-label">Recent</h2>
        {recent.length === 0 ? (
          <p className="muted small">No recent projects.</p>
        ) : (
          <ul className="recent-list">
            {recent.map((item) => (
              <li key={item.path} onClick={() => void projectController.open(item.path)} title={item.path}>
                <span>{item.name}</span>
                <span className="muted small">{new Date(item.openedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

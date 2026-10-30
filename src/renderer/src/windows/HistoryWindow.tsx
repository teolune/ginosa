import { projectController } from '../state/project-controller'
import { useObservable } from '../state/observable'

/** Every undoable step. Click a row to go back (or forward) to that point. */
export function HistoryWindow() {
  useObservable(projectController)
  const history = projectController.historyView
  if (!history) return null
  const entries = history.entries
  const position = history.position
  return (
    <ol className="history-list">
      <li className={position === 0 ? 'current' : ''} onClick={() => projectController.jumpTo(0)}>
        <span className="muted">{history.baselineLabel}</span>
      </li>
      {entries.map((entry, index) => (
        <li
          key={`${entry.id}-${index}`}
          className={`${index + 1 === position ? 'current' : ''} ${index + 1 > position ? 'undone' : ''}`}
          onClick={() => projectController.jumpTo(index + 1)}
        >
          <span>{entry.label}</span>
          <span className="mono muted">{new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        </li>
      ))}
    </ol>
  )
}

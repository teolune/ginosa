import { angleName } from '@engine/timeline/multicam-edits'
import { gridCells } from '@engine/timeline/multicam-grid'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { multicamUi } from './multicam-ui'

/** Over the Program monitor in the multi-camera view: each angle's key and name in its cell, the live one framed (red while recording). Click a cell to switch to it. */
export function MulticamOverlay() {
  useObservable(multicamUi)
  useObservable(projectController)
  const sequence = projectController.project?.sequence
  const group = multicamUi.view && sequence ? multicamUi.group(sequence) : null
  if (!group || !sequence) return null
  return (
    <div className={`multicam-overlay ${multicamUi.recording ? 'recording' : ''}`}>
      {gridCells(group).map((cell) => {
        const angle = group.angles.find((a) => a.id === cell.angleId)!
        return (
          <button
            key={cell.angleId}
            className={`multicam-cell ${multicamUi.live === cell.angleId ? 'live' : ''}`}
            style={{ left: `${cell.x * 100}%`, top: `${cell.y * 100}%`, width: `${cell.w * 100}%`, height: `${cell.h * 100}%` }}
            title={`${angleName(sequence, angle)}: press ${cell.key === ',' ? 'the comma' : cell.key} or click to switch to it`}
            onClick={() => multicamUi.press(cell.key)}
          >
            <span className="multicam-cell-label mono">
              {cell.key} · {angleName(sequence, angle)}
            </span>
          </button>
        )
      })}
    </div>
  )
}

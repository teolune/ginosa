import { Observable } from '../state/observable'
import { workspaceController } from '../state/workspace'

/**
 * The automation editor's interface state (W2.2): which clip it edits, its selected points and
 * whether it snaps. Not in the project, not undoable.
 */
class AutomationUi extends Observable {
  clipId: string | null = null
  /** Indexes into the clip's points. */
  selected: number[] = []
  snapping = true

  /** Double-click an automation clip: its curve in the editor. */
  open(clipId: string): void {
    if (this.clipId !== clipId) this.selected = []
    this.clipId = clipId
    workspaceController.open('automation-editor')
    workspaceController.focus('automation-editor')
    this.notify()
  }

  select(indexes: number[]): void {
    this.selected = [...new Set(indexes)].sort((a, b) => a - b)
    this.notify()
  }

  setSnapping(on: boolean): void {
    this.snapping = on
    this.notify()
  }
}

export const automationUi = new AutomationUi()

/** Dragging an automation clip's name from its editor onto a value in Effect Controls links them (W2.2). */
export const AUTOMATION_DRAG_TYPE = 'application/x-ginosa-automation'

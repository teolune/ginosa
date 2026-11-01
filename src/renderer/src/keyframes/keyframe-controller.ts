import { refKey, type PropertyRef } from '@engine/keyframes/properties'
import { copyKeyframes, keyframeKey, pasteKeyframes, removeKeyframes, type KeyframeClipboard, type KeyframeRef } from '@engine/timeline/keyframe-edits'
import { projectController } from '../state/project-controller'
import { Observable } from '../state/observable'
import { timelineController } from '../timeline/timeline-controller'

/**
 * Shared state of the Keyframe Editor and Effect Controls: which keyframes are selected,
 * which value (row) has focus (what the graph shows and what Paste goes onto), and the
 * keyframe clipboard.
 */
class KeyframeController extends Observable {
  /** Selected keyframes, by keyframeKey(). */
  selected = new Map<string, KeyframeRef>()
  focused: PropertyRef | null = null
  clipboard: KeyframeClipboard | null = null
  mode: 'dope' | 'graph' = 'dope'

  constructor() {
    super()
    // Keyframes that no longer exist drop out of the selection.
    projectController.subscribe(() => {
      const sequence = projectController.project?.sequence
      if (!sequence || this.selected.size === 0) return
      let changed = false
      for (const [key, ref] of this.selected) {
        const clip = sequence.clips.find((c) => c.id === ref.clipId)
        const map = !clip ? undefined : ref.effectId === null ? clip.keyframes : clip.effects.find((e) => e.id === ref.effectId)?.keyframes
        if (!map?.[ref.param]?.some((k) => k.id === ref.keyframeId)) {
          this.selected.delete(key)
          changed = true
        }
      }
      if (changed) this.notify()
    })
  }

  isSelected(ref: KeyframeRef): boolean {
    return this.selected.has(keyframeKey(ref))
  }

  select(refs: KeyframeRef[], mode: 'replace' | 'toggle' | 'add'): void {
    if (mode === 'replace') this.selected.clear()
    for (const ref of refs) {
      const key = keyframeKey(ref)
      if (mode === 'toggle' && this.selected.has(key)) this.selected.delete(key)
      else this.selected.set(key, ref)
    }
    this.notify()
  }

  focus(ref: PropertyRef | null): void {
    this.focused = ref
    this.notify()
  }

  isFocused(ref: PropertyRef): boolean {
    return this.focused !== null && this.focused.clipId === ref.clipId && refKey(this.focused) === refKey(ref)
  }

  setMode(mode: 'dope' | 'graph'): void {
    this.mode = mode
    this.notify()
  }

  get selection(): KeyframeRef[] {
    return [...this.selected.values()]
  }

  deleteSelected(): void {
    if (this.selected.size === 0) return
    projectController.dispatch(removeKeyframes(this.selection))
  }

  copy(): boolean {
    const sequence = projectController.project?.sequence
    if (!sequence || this.selected.size === 0) return false
    const board = copyKeyframes(sequence, this.selection)
    if (!board) return false
    const properties = new Set(this.selection.map((r) => `${r.clipId}|${refKey(r)}`))
    this.clipboard = board
    if (properties.size > 1) projectController.showMessage(`Copied the ${board.label} keyframes; keyframes copy one value at a time`)
    this.notify()
    return true
  }

  /** Pastes at the playhead onto the focused value (or the one they came from on the focused clip). */
  paste(): void {
    const board = this.clipboard
    if (!board) return
    const target = this.focused
    if (!target) {
      projectController.showMessage('Click a value’s name in the Keyframe Editor or Effect Controls to choose where the keyframes go')
      return
    }
    projectController.dispatch(pasteKeyframes(target, board, timelineController.playhead))
  }
}

export const keyframeController = new KeyframeController()

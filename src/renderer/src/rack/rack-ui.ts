import { type CubeRef } from '@engine/timeline/rack-edits'
import { Observable } from '../state/observable'

/**
 * The Channel Rack's interface state (not in the project, not undoable): the selected cubes,
 * the section shown, the channel picked, link mode, the cube window and the clipboards.
 */
class RackUi extends Observable {
  selection: CubeRef[] = []
  /** The section shown when not following the playhead (null: the first). */
  sectionId: string | null = null
  follow = true
  /** The channel clicked last (its name): R links values to it. */
  channelId: string | null = null
  /** Link mode (decision 109): values clicked in Effect Controls link to this channel. */
  linking: string | null = null
  /** The cube window, for the selection. */
  cubeWindow = false
  copiedCubes: Array<{ rowId: string; step: number; amounts: Record<string, number> }> | null = null
  copiedAmounts: Record<string, number> | null = null
  private keyHandler: ((event: KeyboardEvent) => void) | null = null

  isSelected(ref: CubeRef): boolean {
    return this.selection.some((s) => s.sectionId === ref.sectionId && s.rowId === ref.rowId && s.step === ref.step)
  }

  select(refs: CubeRef[], mode: 'replace' | 'toggle' | 'add' = 'replace'): void {
    if (mode === 'replace') this.selection = refs
    else if (mode === 'add') this.selection = [...this.selection, ...refs.filter((r) => !this.isSelected(r))]
    else {
      const next = this.selection.filter((s) => !refs.some((r) => r.sectionId === s.sectionId && r.rowId === s.rowId && r.step === s.step))
      this.selection = next.length === this.selection.length ? [...this.selection, ...refs] : next
    }
    if (refs[0]) this.channelId = refs[0].rowId
    if (this.selection.length === 0) this.cubeWindow = false
    this.notify()
  }

  showSection(id: string | null): void {
    this.sectionId = id
    this.follow = false
    this.notify()
  }

  setFollow(on: boolean): void {
    this.follow = on
    this.notify()
  }

  pickChannel(id: string | null): void {
    this.channelId = id
    this.notify()
  }

  openCubeWindow(open: boolean): void {
    this.cubeWindow = open && this.selection.length > 0
    this.notify()
  }

  /** R: link mode on for the picked channel, or off. While it's on, R or Esc anywhere ends it. */
  toggleLinking(channelId: string | null = this.channelId): void {
    this.linking = this.linking ? null : channelId
    if (this.linking && !this.keyHandler) {
      this.keyHandler = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
        if (event.key === 'Escape' || ((event.key === 'r' || event.key === 'R') && !event.metaKey && !event.ctrlKey && !event.altKey)) {
          event.preventDefault()
          event.stopPropagation()
          this.toggleLinking()
        }
      }
      window.addEventListener('keydown', this.keyHandler, true)
    } else if (!this.linking && this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler, true)
      this.keyHandler = null
    }
    this.notify()
  }

  /** After an edit, forget cubes and sections that are gone. */
  prune(exists: (ref: CubeRef) => boolean, sectionExists: (id: string) => boolean, channelExists: (id: string) => boolean): void {
    const selection = this.selection.filter(exists)
    let changed = selection.length !== this.selection.length
    this.selection = selection
    if (this.sectionId && !sectionExists(this.sectionId)) {
      this.sectionId = null
      changed = true
    }
    if (this.channelId && !channelExists(this.channelId)) {
      this.channelId = null
      changed = true
    }
    if (this.linking && !channelExists(this.linking)) {
      this.toggleLinking()
      changed = false
    }
    if (this.selection.length === 0 && this.cubeWindow) {
      this.cubeWindow = false
      changed = true
    }
    if (changed) this.notify()
  }
}

export const rackUi = new RackUi()

/** Dragging a channel's name onto a value in Effect Controls links them (decision 109). */
export const CHANNEL_DRAG_TYPE = 'application/x-ginosa-channel'

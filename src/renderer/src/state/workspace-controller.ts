import {
  clampRect,
  DEFAULT_WORKSPACE,
  defaultLayout,
  normaliseWorkspaceFile,
  PANEL_LIMITS,
  topZ,
  type FrameChoice,
  type PanelKey,
  type Rect,
  type Size,
  type WindowLayout,
  type WindowSpec,
  type WorkspaceFile,
  type WorkspaceLayout
} from '../workspace/layout'
import { Observable } from './observable'

/**
 * Window arrangement (UI state, not part of the project and not undoable).
 * Layouts are saved globally in the app's settings folder, so they work across projects.
 */
export class WorkspaceController extends Observable {
  private file: WorkspaceFile
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private loaded = false

  constructor(readonly specs: WindowSpec[]) {
    super()
    this.file = normaliseWorkspaceFile(null, specs)
  }

  async load(): Promise<void> {
    const raw = await window.ginosa.workspace.load()
    this.file = normaliseWorkspaceFile(raw, this.specs)
    this.loaded = true
    this.notify()
  }

  get activeName(): string {
    return this.file.active
  }

  get names(): string[] {
    return Object.keys(this.file.layouts)
  }

  get layout(): WorkspaceLayout {
    const layout = this.file.layouts[this.file.active]
    if (layout) return layout
    const fresh = defaultLayout(this.specs)
    this.file.layouts[this.file.active] = fresh
    return fresh
  }

  spec(id: string): WindowSpec | undefined {
    return this.specs.find((spec) => spec.id === id)
  }

  window(id: string): WindowLayout | undefined {
    return this.layout.windows[id]
  }

  isOpen(id: string): boolean {
    return this.window(id)?.open === true
  }

  // ---- Window actions ----------------------------------------------------------

  private update(id: string, change: (w: WindowLayout) => void): void {
    const w = this.layout.windows[id]
    if (!w) return
    change(w)
    this.changed()
  }

  toggle(id: string): void {
    if (this.isOpen(id)) this.close(id)
    else this.open(id)
  }

  open(id: string): void {
    this.update(id, (w) => {
      w.open = true
      if (w.mode === 'minimized') w.mode = 'normal'
      w.z = topZ(this.layout) + 1
    })
  }

  close(id: string): void {
    this.update(id, (w) => {
      w.open = false
    })
  }

  focus(id: string): void {
    const w = this.window(id)
    if (!w || w.z === topZ(this.layout)) return
    this.update(id, (win) => {
      win.z = topZ(this.layout) + 1
    })
  }

  setRect(id: string, rect: Rect, bounds: Size): void {
    const spec = this.spec(id)
    if (!spec) return
    this.update(id, (w) => {
      w.rect = clampRect(rect, bounds, spec.minSize)
      if (w.mode === 'maximized') w.mode = 'normal'
    })
  }

  minimize(id: string): void {
    this.update(id, (w) => {
      w.mode = 'minimized'
    })
  }

  restore(id: string): void {
    this.update(id, (w) => {
      w.mode = 'normal'
      w.z = topZ(this.layout) + 1
    })
  }

  toggleMaximize(id: string): void {
    this.update(id, (w) => {
      w.mode = w.mode === 'maximized' ? 'normal' : 'maximized'
      w.z = topZ(this.layout) + 1
    })
  }

  setDocked(id: string, docked: boolean): void {
    const spec = this.spec(id)
    if (!spec?.dockable && docked) return
    this.update(id, (w) => {
      w.docked = docked
      w.open = true
      w.mode = 'normal'
      w.z = topZ(this.layout) + 1
    })
  }

  /** Keeps every floating window reachable after the app window shrinks. */
  fitToBounds(bounds: Size): void {
    let moved = false
    for (const spec of this.specs) {
      const w = this.layout.windows[spec.id]
      if (!w) continue
      const fitted = clampRect(w.rect, bounds, spec.minSize)
      if (fitted.x !== w.rect.x || fitted.y !== w.rect.y || fitted.w !== w.rect.w || fitted.h !== w.rect.h) {
        w.rect = fitted
        moved = true
      }
    }
    if (moved) this.changed()
  }

  setPanelSize(key: PanelKey, value: number): void {
    const limits = PANEL_LIMITS[key]
    this.layout[key] = Math.round(Math.min(limits.max, Math.max(limits.min, value)))
    this.changed()
  }

  /** Frames: a preset for where the panels sit (Control Panel). */
  setFrame(frame: FrameChoice): void {
    if (this.layout.frame === frame) return
    this.layout.frame = frame
    this.changed()
  }

  /** Control Panel: Open/Close Import Folder (the media and folders column). */
  toggleMedia(open = !this.layout.mediaOpen): void {
    if (this.layout.mediaOpen === open) return
    this.layout.mediaOpen = open
    this.changed()
  }

  // ---- Named workspaces --------------------------------------------------------

  apply(name: string): void {
    if (!this.file.layouts[name]) return
    this.file.active = name
    this.changed()
  }

  saveAs(name: string): void {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!clean) return
    this.file.layouts[clean] = structuredClone(this.layout)
    this.file.active = clean
    this.changed()
  }

  /** Puts the current workspace back to the built-in arrangement. */
  reset(): void {
    this.file.layouts[this.file.active] = defaultLayout(this.specs)
    this.changed()
  }

  private changed(): void {
    this.notify()
    if (!this.loaded) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void window.ginosa.workspace.save(this.file)
    }, 400)
  }
}

export { DEFAULT_WORKSPACE }

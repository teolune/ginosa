import { valueAt, type PropertyRef } from '@engine/keyframes/properties'
import { setValue } from '@engine/timeline/keyframe-edits'
import { formatGradient, GRADIENT_METHODS, parseGradient, BLACK_WHITE, type Gradient, type GradientMethod } from '@engine/gradients/gradient'
import {
  addFolder,
  addGradient,
  BASICS,
  exportGrd,
  importGrd,
  moveGradients,
  parseLibrary,
  removeFolder,
  removeGradients,
  renameFolder,
  updateGradient,
  type GradientLibrary,
  type LibraryGradient
} from '@engine/gradients/library'
import type { GradientParam } from '@engine/effects/types'
import { effectById } from '../../../effects/registry'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'

const newId = () => globalThis.crypto.randomUUID()

export type StopSelection = { kind: 'colour' | 'opacity'; index: number } | null

/**
 * The gradient library and the Gradient Editor's state (M13). The library is shared by every
 * project (userData/gradient-library.json). The editor edits a target: one effect's gradient
 * parameter (opened from Effect Controls), changed through the same undoable command as any
 * value, so keyframes and undo work as usual; or, with no target, a scratch gradient to save.
 */
class GradientController extends Observable {
  library: GradientLibrary | null = null
  /** The folder shown in the library browser. */
  folder: string[] = BASICS
  target: PropertyRef | null = null
  scratch: Gradient = BLACK_WHITE
  scratchMethod: GradientMethod = 'classic'
  selected: StopSelection = { kind: 'colour', index: 0 }
  /** The last import or export, for the editor to show. */
  message: { text: string; warnings: string[] } | null = null
  private loading: Promise<void> | null = null

  load(): Promise<void> {
    this.loading ??= (async () => {
      this.library = parseLibrary(await window.ginosa.gradients.read(), newId)
      this.notify()
    })()
    return this.loading
  }

  private async commit(library: GradientLibrary): Promise<void> {
    this.library = library
    this.notify()
    await window.ginosa.gradients.write(library)
  }

  // ---- The gradient being edited ------------------------------------------------------

  /** Opens the editor on an effect's gradient parameter. */
  edit(ref: PropertyRef): void {
    this.target = ref
    this.selected = { kind: 'colour', index: 0 }
    workspaceController.open('gradient-editor')
    workspaceController.focus('gradient-editor')
    this.notify()
    void this.load()
  }

  /** A gradient parameter's spec, if it still exists (the clip or effect may have gone). */
  private specOf(ref: PropertyRef | null): { spec: GradientParam; ref: PropertyRef } | null {
    const clip = projectController.project?.sequence.clips.find((c) => c.id === ref?.clipId)
    const effect = clip?.effects.find((e) => e.id === ref?.effectId)
    const spec = effect ? effectById(effect.effectId)?.params.find((p) => p.id === ref!.param) : undefined
    if (!ref || !clip || !effect || spec?.type !== 'gradient') return null
    return { spec, ref }
  }

  /** Whether the editor's target is still there. */
  get linked(): boolean {
    return this.specOf(this.target) !== null
  }

  /** What the editor shows: the target's gradient and method at the playhead, or the scratch gradient. */
  current(): { gradient: Gradient; method: GradientMethod; label: string; editingEffect: boolean } {
    const t = this.specOf(this.target)
    const clip = projectController.project?.sequence.clips.find((c) => c.id === t?.ref.clipId)
    if (!t || !clip) return { gradient: this.scratch, method: this.scratchMethod, label: 'Not linked to an effect: save it to the library to use it', editingEffect: false }
    const at = Math.min(Math.max(0, timelineController.playhead - clip.start), clip.duration - 1)
    const gradient = parseGradient(String(valueAt(clip, t.ref.effectId, t.ref.param, at))) ?? BLACK_WHITE
    const methodValue = t.spec.methodParam ? valueAt(clip, t.ref.effectId, t.spec.methodParam, at) : 'classic'
    const method = GRADIENT_METHODS.some((m) => m.id === methodValue) ? (methodValue as GradientMethod) : 'classic'
    const effect = clip.effects.find((e) => e.id === t.ref.effectId)
    return { gradient, method, label: `${clip.name} › ${effectById(effect?.effectId ?? '')?.name ?? 'Effect'} › ${t.spec.label}`, editingEffect: true }
  }

  /** Changes the gradient being edited, or another effect's (undoable, like any value; a drag is one step). */
  set(gradient: Gradient, ref: PropertyRef | null = this.target): void {
    const t = this.specOf(ref)
    if (!t) {
      this.scratch = gradient
      this.notify()
      return
    }
    projectController.dispatch(setValue(t.ref, formatGradient(gradient), timelineController.playhead))
  }

  setMethod(method: GradientMethod, ref: PropertyRef | null = this.target): void {
    const t = this.specOf(ref)
    if (!t?.spec.methodParam) {
      this.scratchMethod = method
      this.notify()
      return
    }
    projectController.dispatch(setValue({ ...t.ref, param: t.spec.methodParam }, method, timelineController.playhead))
  }

  /** Uses a library gradient (and its method, if it was saved with one). */
  use(item: LibraryGradient, ref: PropertyRef | null = this.target): void {
    this.set(item.gradient, ref)
    if (item.gradient.kind === 'solid' && item.gradient.method) this.setMethod(item.gradient.method, ref)
  }

  select(selection: StopSelection): void {
    this.selected = selection
    this.notify()
  }

  // ---- The library --------------------------------------------------------------------

  openFolder(folder: string[]): void {
    this.folder = folder
    this.notify()
  }

  async saveCurrent(name: string): Promise<void> {
    await this.load()
    const { gradient, method } = this.current()
    const saved: Gradient = gradient.kind === 'solid' ? { ...gradient, name, ...(method !== 'classic' ? { method } : {}) } : { ...gradient, name }
    if (saved.kind === 'solid' && method === 'classic') delete saved.method
    const { library } = addGradient(this.library!, this.folder, saved, newId)
    await this.commit(library)
  }

  async renameGradient(id: string, name: string): Promise<void> {
    if (this.library) await this.commit(updateGradient(this.library, id, (g) => ({ ...g, name })))
  }

  async removeGradient(id: string): Promise<void> {
    if (this.library) await this.commit(removeGradients(this.library, [id]))
  }

  async moveGradient(id: string, folder: string[]): Promise<void> {
    if (this.library) await this.commit(moveGradients(this.library, [id], folder))
  }

  async newFolder(name: string): Promise<void> {
    await this.load()
    const { library, folder } = addFolder(this.library!, this.folder, name)
    this.folder = folder
    await this.commit(library)
  }

  async renameFolder(folder: string[], name: string): Promise<void> {
    if (!this.library) return
    const library = renameFolder(this.library, folder, name)
    const renamed = library.folders[this.library.folders.findIndex((f) => JSON.stringify(f) === JSON.stringify(folder))]
    if (renamed && JSON.stringify(this.folder.slice(0, folder.length)) === JSON.stringify(folder)) this.folder = [...renamed, ...this.folder.slice(folder.length)]
    await this.commit(library)
  }

  async removeFolder(folder: string[]): Promise<void> {
    if (!this.library) return
    if (JSON.stringify(this.folder.slice(0, folder.length)) === JSON.stringify(folder)) this.folder = folder.slice(0, -1)
    await this.commit(removeFolder(this.library, folder))
  }

  /** Asks for .grd files and adds each to the library in a folder of its own. */
  async import(): Promise<void> {
    await this.load()
    const files = await window.ginosa.gradients.chooseImport()
    if (files.length === 0) return
    await this.importFiles(files)
  }

  async importFiles(files: Array<{ name: string; bytes: Uint8Array }>): Promise<void> {
    await this.load()
    let library = this.library!
    const lines: string[] = []
    const warnings: string[] = []
    for (const file of files) {
      try {
        const result = importGrd(library, file.name, file.bytes, newId)
        library = result.library
        this.folder = result.folder
        lines.push(`${file.name}: ${result.added} gradient${result.added === 1 ? '' : 's'} into “${result.folder.join(' › ')}”`)
        warnings.push(...result.warnings.map((w) => `${file.name}: ${w}`))
      } catch (error) {
        warnings.push(`${file.name} couldn't be read: ${(error as Error).message}`)
      }
    }
    this.message = { text: lines.join('\n') || 'Nothing was imported', warnings }
    await this.commit(library)
  }

  /** Writes a folder (or the whole library) as a .grd that Photoshop reads. */
  async export(folder: string[] | null): Promise<void> {
    await this.load()
    const bytes = exportGrd(this.library!, folder)
    const path = await window.ginosa.gradients.export(folder?.[folder.length - 1] ?? 'ginosa Gradients', bytes)
    if (path) this.message = { text: `Exported to ${path}`, warnings: [] }
    this.notify()
  }

  dismissMessage(): void {
    this.message = null
    this.notify()
  }
}

export const gradientController = new GradientController()

import { applyBuiltinPreset, BUILTIN_PREFIX } from '@engine/timeline/builtin-presets'
import { timelineController } from '../timeline/timeline-controller'
import type { EffectInstance, ImageSize } from '@engine/effects/types'
import { parsePresets, type EffectPreset } from '@engine/effects/presets'
import { cloneEffect } from '@engine/effects/params'
import { effectImageSize, pasteEffects } from '@engine/timeline/effect-edits'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'

/** Drag data types for effects and presets (Effects Library → timeline or Effect Controls). */
export const EFFECT_DRAG_TYPE = 'application/x-ginosa-effect'
export const PRESET_DRAG_TYPE = 'application/x-ginosa-preset'
export const STACK_DRAG_TYPE = 'application/x-ginosa-stack-effect'

/**
 * Effect UI state that isn't part of the project: which effects are selected in Effect
 * Controls, the effects clipboard, and the preset library (shared by every project).
 */
class EffectsController extends Observable {
  /** Selected effect ids in Effect Controls. */
  selected = new Set<string>()
  clipboard: { effects: EffectInstance[]; size: ImageSize } | null = null
  presets: EffectPreset[] = []
  private loaded = false

  select(ids: string[], mode: 'replace' | 'toggle'): void {
    if (mode === 'replace') this.selected = new Set(ids)
    else for (const id of ids) (this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id))
    this.notify()
  }

  /** Copies effects from a clip (the selected ones, or the whole stack). */
  copy(clipId: string): number {
    const project = projectController.project
    const clip = project?.sequence.clips.find((c) => c.id === clipId)
    if (!project || !clip) return 0
    const chosen = clip.effects.filter((e) => this.selected.size === 0 || this.selected.has(e.id))
    if (chosen.length === 0) return 0
    this.clipboard = { effects: chosen.map((e) => cloneEffect(e)), size: effectImageSize(clip, project.media, project.sequence) }
    this.notify()
    return chosen.length
  }

  paste(clipIds: string[]): void {
    if (!this.clipboard) return
    projectController.dispatch(pasteEffects(clipIds, this.clipboard.effects, this.clipboard.effects.length === 1 ? 'Paste Effect' : 'Paste Effects', undefined, this.clipboard.size))
  }

  // ---- Presets ----------------------------------------------------------------------

  async loadPresets(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    this.presets = parsePresets(await window.ginosa.presets.read())
    this.notify()
  }

  private async savePresets(): Promise<void> {
    await window.ginosa.presets.write({ version: 1, presets: this.presets })
    this.notify()
  }

  async savePreset(name: string, clipId: string): Promise<void> {
    const project = projectController.project
    const clip = project?.sequence.clips.find((c) => c.id === clipId)
    if (!project || !clip) return
    const effects = clip.effects.filter((e) => this.selected.size === 0 || this.selected.has(e.id))
    if (effects.length === 0) throw new Error('There are no effects to save')
    await this.loadPresets()
    this.presets = [
      ...this.presets,
      { id: globalThis.crypto.randomUUID(), name, effects: effects.map((e) => cloneEffect(e)), size: effectImageSize(clip, project.media, project.sequence), createdAt: new Date().toISOString() }
    ].sort((a, b) => a.name.localeCompare(b.name))
    await this.savePresets()
  }

  async renamePreset(id: string, name: string): Promise<void> {
    this.presets = this.presets.map((p) => (p.id === id ? { ...p, name } : p)).sort((a, b) => a.name.localeCompare(b.name))
    await this.savePresets()
  }

  async deletePreset(id: string): Promise<void> {
    this.presets = this.presets.filter((p) => p.id !== id)
    await this.savePresets()
  }

  applyPreset(presetId: string, clipIds: string[]): void {
    if (presetId.startsWith(BUILTIN_PREFIX)) {
      projectController.dispatch(applyBuiltinPreset(clipIds, presetId, timelineController.playhead))
      return
    }
    const preset = this.presets.find((p) => p.id === presetId)
    if (!preset) return
    projectController.dispatch(pasteEffects(clipIds, preset.effects, `Apply Preset “${preset.name}”`, undefined, preset.size))
  }
}

export const effectsController = new EffectsController()

import type { ParamValue } from '@engine/effects/types'
import type { PropertyRef } from '@engine/keyframes/properties'
import type { MaskValueRef } from '@engine/timeline/mask-edits'
import { Observable } from '../state/observable'

/** A value that can be modulated: a clip's or effect's, or a mask shape's setting. */
export type ValueRef = PropertyRef | MaskValueRef

export function isMaskRef(ref: ValueRef): ref is MaskValueRef {
  return 'maskId' in ref
}

/**
 * What the modulation windows are doing: which modulator is open in the Modulation
 * window, a value waiting to be linked ("Modulate Parameter…"), the Link to Audio picker,
 * and the copied value (Copy Value / Paste Value).
 */
class ModulationUi extends Observable {
  selected: string | null = null
  /** A value to link to a modulator chosen in the Modulation window. */
  target: ValueRef | null = null
  /** The Link to Audio picker, open for this value. */
  linkToAudio: ValueRef | null = null
  copied: { kind: 'number' | 'point' | 'stepped'; value: ParamValue; label: string } | null = null

  select(id: string | null): void {
    this.selected = id
    this.notify()
  }

  modulate(ref: ValueRef | null): void {
    this.target = ref
    this.notify()
  }

  openLinkToAudio(ref: ValueRef | null): void {
    this.linkToAudio = ref
    this.notify()
  }

  copy(kind: 'number' | 'point' | 'stepped', value: ParamValue, label: string): void {
    this.copied = { kind, value: Array.isArray(value) ? [value[0], value[1]] : value, label }
    this.notify()
  }
}

export const modulationUi = new ModulationUi()

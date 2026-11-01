import { Observable } from '../state/observable'

/**
 * Warnings that ask before something is removed (decision 42), each with "Don't ask me
 * again". What you've silenced is remembered on this Mac; ginosa → Show All Warnings
 * Again brings them back.
 */

export interface WarningRequest {
  id: string
  title: string
  message: string
  confirm: string
  /** False for questions that should always be asked (deleting files). */
  silenceable: boolean
  resolve(ok: boolean, dontAskAgain: boolean): void
}

const KEY = 'ginosa.warnings.silenced'

class WarningController extends Observable {
  request: WarningRequest | null = null
  private silenced: Set<string>

  constructor() {
    super()
    let stored: unknown = []
    try {
      stored = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    } catch {
      stored = []
    }
    this.silenced = new Set(Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : [])
  }

  isSilenced(id: string): boolean {
    return this.silenced.has(id)
  }

  /** Always asks (no "Don't ask me again"): for deleting files. */
  confirm(title: string, message: string, confirm: string): Promise<boolean> {
    this.request?.resolve(false, false)
    return new Promise((resolve) => {
      this.request = {
        id: 'confirm',
        title,
        message,
        confirm,
        silenceable: false,
        resolve: (ok) => {
          this.request = null
          this.notify()
          resolve(ok)
        }
      }
      this.notify()
    })
  }

  /** Asks, unless this warning was silenced; resolves true to go ahead. */
  ask(id: string, title: string, message: string, confirm: string): Promise<boolean> {
    if (this.silenced.has(id)) return Promise.resolve(true)
    this.request?.resolve(false, false)
    return new Promise((resolve) => {
      this.request = {
        id,
        title,
        message,
        confirm,
        silenceable: true,
        resolve: (ok, dontAskAgain) => {
          this.request = null
          if (ok && dontAskAgain) {
            this.silenced.add(id)
            this.save()
          }
          this.notify()
          resolve(ok)
        }
      }
      this.notify()
    })
  }

  showAllAgain(): number {
    const count = this.silenced.size
    this.silenced.clear()
    this.save()
    this.notify()
    return count
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify([...this.silenced]))
    } catch {
      // Storage unavailable: the choice lasts until ginosa quits.
    }
  }
}

export const warnings = new WarningController()

/** Asks before keyframes are removed (stopwatch off, Reset, Remove All Keyframes). Goes ahead without asking when there are none. */
export async function confirmKeyframeRemoval(count: number, what: string): Promise<boolean> {
  if (count === 0) return true
  return warnings.ask(
    'remove-keyframes',
    'Remove keyframes?',
    `This removes ${count} keyframe${count === 1 ? '' : 's'} from ${what}. ⌘Z brings ${count === 1 ? 'it' : 'them'} back.`,
    count === 1 ? 'Remove Keyframe' : 'Remove Keyframes'
  )
}

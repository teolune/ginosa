import { useSyncExternalStore } from 'react'

/** Minimal observable for controllers: React re-renders when `version` changes. */
export class Observable {
  private listeners = new Set<() => void>()
  private revision = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.revision

  protected notify(): void {
    this.revision++
    for (const listener of this.listeners) listener()
  }
}

/** Re-renders the component whenever the controller notifies. */
export function useObservable(observable: Observable): number {
  return useSyncExternalStore(observable.subscribe, observable.getVersion)
}

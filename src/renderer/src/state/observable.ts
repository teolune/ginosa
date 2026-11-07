import { useCallback, useRef, useSyncExternalStore } from 'react'

/**
 * What changed, so listeners only hear what they use. Most changes are to the `state`. The
 * timeline's zoom and scroll (`view`) matter only to the timeline itself, and the `playhead`
 * moves on every frame of playback. Plain subscribers hear `state` and `playhead`.
 */
export type Topic = 'state' | 'playhead' | 'view'

export const STATE_AND_PLAYHEAD: readonly Topic[] = ['state', 'playhead']

/** Minimal observable for controllers: React re-renders when the version of the topics it listens to changes. */
export class Observable {
  private listeners = new Map<() => void, readonly Topic[]>()
  private revisions: Record<Topic, number> = { state: 0, playhead: 0, view: 0 }

  subscribe = (listener: () => void, topics: readonly Topic[] = STATE_AND_PLAYHEAD): (() => void) => {
    this.listeners.set(listener, topics)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion = (): number => this.versionOf(STATE_AND_PLAYHEAD)

  /** Changes so far to these topics (it only ever grows). */
  versionOf(topics: readonly Topic[]): number {
    let version = 0
    for (const topic of topics) version += this.revisions[topic]
    return version
  }

  protected notify(topic: Topic = 'state'): void {
    this.revisions[topic]++
    for (const [listener, topics] of [...this.listeners]) if (topics.includes(topic)) listener()
  }
}

export interface ObserveOptions {
  /** Topics passed on at most this often, in ms (the last change always arrives), e.g. the playhead during playback. */
  throttle?: Partial<Record<Topic, number>>
}

/** For windows showing values at the playhead: during playback they refresh 10 times a second, not every frame. */
export const PLAYHEAD_THROTTLE: ObserveOptions = { throttle: { playhead: 100 } }

/** Re-renders the component when the controller notifies about these topics. */
export function useObservable(observable: Observable, topics: readonly Topic[] = STATE_AND_PLAYHEAD, options: ObserveOptions = {}): number {
  const key = `${topics.join(',')}|${JSON.stringify(options.throttle ?? {})}`
  // The version React sees: live for unthrottled topics, as of the last pass-on for throttled ones.
  const seen = useRef<Partial<Record<Topic, number>>>({})
  const subscribe = useCallback(
    (listener: () => void) => {
      const offs: Array<() => void> = []
      const live = topics.filter((t) => !options.throttle?.[t])
      if (live.length) offs.push(observable.subscribe(listener, live))
      for (const topic of topics) {
        const every = options.throttle?.[topic]
        if (!every) continue
        seen.current[topic] = observable.versionOf([topic])
        let timer: ReturnType<typeof setTimeout> | null = null
        let last = 0
        const pass = () => {
          timer = null
          last = performance.now()
          seen.current[topic] = observable.versionOf([topic])
          listener()
        }
        offs.push(
          observable.subscribe(() => {
            const wait = last + every - performance.now()
            if (wait <= 0) pass()
            else timer ??= setTimeout(pass, wait)
          }, [topic])
        )
        offs.push(() => {
          if (timer) clearTimeout(timer)
        })
      }
      return () => offs.forEach((off) => off())
    },
    [observable, key]
  )
  const getSnapshot = useCallback(() => {
    let version = 0
    for (const topic of topics) version += options.throttle?.[topic] ? (seen.current[topic] ?? observable.versionOf([topic])) : observable.versionOf([topic])
    return version
  }, [observable, key])
  return useSyncExternalStore(subscribe, getSnapshot)
}

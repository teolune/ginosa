/// <reference lib="webworker" />
import { findSync, syncSound, type SyncMatch } from '@engine/audio/sync'

/**
 * Syncing by sound (W5.1) off the interface thread: the song and each take, mono at SYNC_RATE;
 * replies with each take's match as it's found, then done.
 */

export interface SyncWorkerRequest {
  song: Float32Array
  takes: Array<{ id: string; pcm: Float32Array }>
}

export type SyncWorkerMessage = { kind: 'match'; id: string; match: SyncMatch } | { kind: 'done' } | { kind: 'failed'; error: string }

self.onmessage = (event: MessageEvent<SyncWorkerRequest>) => {
  try {
    const song = syncSound(event.data.song)
    for (const take of event.data.takes) self.postMessage({ kind: 'match', id: take.id, match: findSync(song, syncSound(take.pcm)) } satisfies SyncWorkerMessage)
    self.postMessage({ kind: 'done' } satisfies SyncWorkerMessage)
  } catch (error) {
    self.postMessage({ kind: 'failed', error: (error as Error).message } satisfies SyncWorkerMessage)
  }
}

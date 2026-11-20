import { SYNC_RATE, type SyncMatch } from '@engine/audio/sync'
import type { Clip } from '@engine/project/model'
import type { MediaItem } from '@engine/project/media'
import { placeInSync, syncable, syncPlacement } from '@engine/timeline/sync-edits'
import { songTempo } from '../control-panel/song-tempo'
import { mediaController } from '../state/media-controller'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import type { SyncWorkerMessage, SyncWorkerRequest } from './sync.worker'

/**
 * Syncing takes to the song by their sound (W5.1, decision 134): the song is the first clip on
 * A1; each take's own sound is matched against it (in a worker), and the takes ginosa is sure or
 * nearly sure of are moved into sync in one undo step. A take it isn't sure of is placed at its
 * best guess and flagged (with the other place it could be); one where it can't hear the song
 * stays where it is, flagged: line it up by hand, or with a sync point.
 */

export interface SyncResult {
  clipId: string
  name: string
  /** sure / unsure (placed, check it) / none (not moved) / skipped (why). */
  outcome: 'sure' | 'unsure' | 'none' | 'skipped'
  match: SyncMatch | null
  detail: string
}

function seconds(value: number): string {
  const sign = value < 0 ? '−' : ''
  const v = Math.abs(value)
  const m = Math.floor(v / 60)
  return `${sign}${m}:${(v - m * 60).toFixed(2).padStart(5, '0')}`
}

class SyncController extends Observable {
  busy = false
  results: SyncResult[] = []

  /** The song clip on A1, or null. */
  song(): Clip | null {
    return songTempo.songClip()
  }

  /** Syncs these clips (video clips, or the clips linked to them) to the song; resolves with what happened to each. */
  async syncToSong(clipIds: readonly string[]): Promise<SyncResult[]> {
    const project = projectController.project
    const song = this.song()
    if (!project) return []
    if (!song) throw new Error('Put the song on A1 first: takes are synced to it')
    const songItem = project.media.find((m) => m.id === song.mediaId)
    if (!songItem) throw new Error('The song’s file isn’t in the project')
    // One take per picture: a clip's linked sound comes with it.
    const chosen = project.sequence.clips.filter((c) => clipIds.includes(c.id) && c.id !== song.id)
    const takes: Clip[] = []
    for (const clip of chosen) {
      const owner = clip.kind === 'video' ? clip : (project.sequence.clips.find((c) => c.kind === 'video' && c.linkId !== null && c.linkId === clip.linkId) ?? clip)
      if (!takes.includes(owner)) takes.push(owner)
    }
    this.busy = true
    this.results = []
    this.notify()
    try {
      const results: SyncResult[] = []
      const work: Array<{ clip: Clip; path: string }> = []
      for (const clip of takes) {
        const item = project.media.find((m) => m.id === clip.mediaId)
        const why = !item ? 'its file isn’t in the project' : !item.info.audio ? 'its file has no sound' : syncable(clip)
        if (why || !item) results.push({ clipId: clip.id, name: clip.name, outcome: 'skipped', match: null, detail: why ?? '' })
        else work.push({ clip, path: item.path })
      }
      const matches = await this.match(songItem, work.map((w) => ({ id: w.clip.id, path: w.path })))
      // Into sync, all at once (from the project as it is now).
      const now = projectController.project!
      const places: Parameters<typeof placeInSync>[0][number][] = []
      for (const { clip } of work) {
        const match = matches.get(clip.id) ?? null
        const current = now.sequence.clips.find((c) => c.id === clip.id)
        if (!match || !current) continue
        if (match.confidence === 'none') {
          results.push({ clipId: clip.id, name: clip.name, outcome: 'none', match, detail: 'couldn’t hear the song in it: line it up by hand or with a sync point' })
          continue
        }
        const place = syncPlacement(now.sequence, now.media, song, current, match.offset)
        if ('problem' in place) {
          results.push({ clipId: clip.id, name: clip.name, outcome: 'skipped', match, detail: place.problem })
          continue
        }
        places.push({ clipId: clip.id, ...place })
        results.push({
          clipId: clip.id,
          name: clip.name,
          outcome: match.confidence,
          match,
          detail:
            match.confidence === 'sure'
              ? `in sync at ${seconds(match.offset)} of the song`
              : `placed at ${seconds(match.offset)} of the song, but check it${match.alternative !== null ? ` (it could be at ${seconds(match.alternative)})` : ''}`
        })
      }
      if (places.length) projectController.dispatch(placeInSync(places))
      this.results = results
      return results
    } finally {
      this.busy = false
      this.notify()
    }
  }

  /** Where each file's start is in the song's file (in a worker); ids are the caller's. */
  async match(song: MediaItem, files: ReadonlyArray<{ id: string; path: string }>): Promise<Map<string, SyncMatch>> {
    const matches = new Map<string, SyncMatch>()
    if (files.length === 0) return matches
    const songPcm = new Float32Array(await window.ginosa.stems.pcm(mediaController.playablePath(song) ?? song.path, SYNC_RATE))
    const pcms = await Promise.all(files.map(async (f) => ({ id: f.id, pcm: new Float32Array(await window.ginosa.stems.pcm(f.path, SYNC_RATE)) })))
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL('./sync.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<SyncWorkerMessage>) => {
        const m = event.data
        if (m.kind === 'match') matches.set(m.id, m.match)
        else {
          worker.terminate()
          if (m.kind === 'done') resolve()
          else reject(new Error(m.error))
        }
      }
      worker.onerror = (event) => {
        worker.terminate()
        reject(new Error(event.message))
      }
      worker.postMessage({ song: songPcm, takes: pcms } satisfies SyncWorkerRequest, [songPcm.buffer, ...pcms.map((p) => p.pcm.buffer)])
    })
    return matches
  }

  /** One line for the message bar. */
  summary(results: readonly SyncResult[]): string {
    const synced = results.filter((r) => r.outcome === 'sure').length
    const parts = [synced ? `${synced} in sync with the song` : null, ...results.filter((r) => r.outcome !== 'sure').map((r) => `${r.name}: ${r.detail}`)].filter(Boolean)
    return parts.join('. ') || 'Nothing to sync'
  }
}

export const syncController = new SyncController()

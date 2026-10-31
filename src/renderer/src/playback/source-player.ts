import type { MediaItem } from '@engine/project/media'
import type { Sequence } from '@engine/project/model'
import type { Ticks } from '@engine/time'
import { sourceSequence } from '@engine/timeline/source-sequence'
import { frameTicks, sequenceEnd, toFrame } from '@engine/timeline/timeline'
import { mediaController } from '../state/media-controller'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { Player, type PlayerHost } from './player'

/**
 * The Source Monitor's side of playback: which file is open, where its playhead is,
 * and the one-clip sequence it plays (rebuilt only when the file or its playable copy
 * changes, so marking In/Out or a colour change never restarts playback).
 */
class SourceHost extends Observable implements PlayerHost {
  playhead: Ticks = 0
  private built: { key: string; sequence: Sequence | null } | null = null
  private last: { id: string | null; item: MediaItem | null; path: string | null; seek: number } = { id: null, item: null, path: null, seek: -1 }

  constructor() {
    super()
    const check = () => this.check()
    mediaController.subscribe(check)
    projectController.subscribe(check)
  }

  item(): MediaItem | null {
    return projectController.project?.media.find((m) => m.id === mediaController.sourceId) ?? null
  }

  scene(): { sequence: Sequence; media: MediaItem[] } | null {
    const project = projectController.project
    const item = this.item()
    if (!project || !item) return null
    const path = mediaController.playablePath(item)
    if (!path) return null
    const key = `${item.id}|${path}|${item.info.durationSeconds}`
    if (this.built?.key !== key) this.built = { key, sequence: sourceSequence(item) }
    return this.built.sequence ? { sequence: this.built.sequence, media: project.media } : null
  }

  /** The frame length of the open file's sequence. */
  frame(): Ticks {
    const scene = this.scene()
    return scene ? frameTicks(scene.sequence) : 1
  }

  end(): Ticks {
    const scene = this.scene()
    return scene ? sequenceEnd(scene.sequence) : 0
  }

  setPlayhead(time: Ticks): void {
    const scene = this.scene()
    if (scene) {
      const frame = frameTicks(scene.sequence)
      time = Math.min(Math.max(0, toFrame(time, frame)), Math.max(0, sequenceEnd(scene.sequence) - frame))
    }
    if (time === this.playhead) return
    this.playhead = time
    this.notify()
  }

  /** Only tell the player when something it shows changed: not on every media-panel update. */
  private check(): void {
    const item = this.item()
    const id = item?.id ?? null
    const path = item ? mediaController.playablePath(item) : null
    const seek = mediaController.sourceSeek?.version ?? 0
    const last = this.last
    if (id === last.id && item === last.item && path === last.path && seek === last.seek) return
    const opened = id !== last.id
    this.last = { id, item, path, seek }
    if (opened || seek !== last.seek) {
      // A new file opens at its In point (or where Match Frame asked).
      const at = mediaController.sourceSeek && seek !== last.seek ? mediaController.sourceSeek.at : (item?.marks.in ?? 0)
      this.playhead = 0
      if (opened && sourcePlayer.playing) sourcePlayer.stop()
      this.setPlayhead(at)
    }
    this.notify()
  }
}

export const sourceHost = new SourceHost()
export const sourcePlayer = new Player(sourceHost)

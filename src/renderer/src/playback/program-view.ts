import type { MediaItem } from '@engine/project/media'
import type { Sequence } from '@engine/project/model'
import { Observable } from '../state/observable'

/**
 * What the Program monitor shows instead of the sequence as it is, when something asks
 * (W5.3: the multi-camera view, every angle in a grid). The filter's result is kept for the
 * same sequence and media, so the monitor sees one sequence until something changes. Export
 * never uses it.
 */
class ProgramView extends Observable {
  private filter: ((sequence: Sequence, media: MediaItem[]) => Sequence) | null = null
  private kept: { sequence: Sequence; media: MediaItem[]; out: Sequence } | null = null

  set(filter: ((sequence: Sequence, media: MediaItem[]) => Sequence) | null): void {
    this.filter = filter
    this.kept = null
    this.notify()
  }

  get active(): boolean {
    return this.filter !== null
  }

  apply(sequence: Sequence, media: MediaItem[]): Sequence {
    if (!this.filter) return sequence
    const kept = this.kept
    if (kept && kept.sequence === sequence && kept.media === media) return kept.out
    const out = this.filter(sequence, media)
    this.kept = { sequence, media, out }
    return out
  }
}

export const programView = new ProgramView()

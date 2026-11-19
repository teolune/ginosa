import { beatTime } from '@engine/audio/beat-grid'
import { hashText } from '@engine/audio/sources'
import type { MediaItem } from '@engine/project/media'
import { STEPS_PER_BEAT, type Clip, type RackRow } from '@engine/project/model'
import { ticksToSeconds } from '@engine/time'
import { DETECT_LISTEN, hitBeat, type PlacedSection } from '@engine/timeline/rack'
import { clipEnd, frameTicks, sourceTimeAt } from '@engine/timeline/timeline'
import { projectController } from '../state/project-controller'

const RATE = 44_100
/** What you hear: from a little before the cube's moment to half a second after it. */
const BEFORE = 0.12
const AFTER = 0.5
const FADE = 0.004

/**
 * Doubtful cubes (W4.6): hear the moment a cube stands for in its own stem (the drums or the
 * bass separated from the song on A1), then keep or delete it; each answer is saved with the
 * detection bench's answers (media/bench/answers), so your songs build up answer keys.
 */
class ListenBack {
  private stems = new Map<string, Promise<Float32Array>>()
  private context: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  /** Off in the tests, so they don't add answers. */
  recording = true

  /** The cube's first time in its section: the song clip on A1 there, and that moment of the song file (seconds). */
  where(placed: PlacedSection, row: RackRow, step: number): { clip: Clip; item: MediaItem; seconds: number } | null {
    const project = projectController.project
    const sequence = project?.sequence
    const grid = sequence?.beatGrid
    const a1 = sequence?.tracks.find((t) => t.kind === 'audio')
    if (!project || !sequence || !grid || !a1) return null
    const time = beatTime(grid, placed.firstStep / STEPS_PER_BEAT + hitBeat(step, row))
    const clip = sequence.clips.find((c) => c.trackId === a1.id && c.kind === 'audio' && c.start <= time && time < clipEnd(c))
    const item = clip && project.media.find((m) => m.id === clip.mediaId)
    if (!clip || !item) return null
    return { clip, item, seconds: ticksToSeconds(sourceTimeAt(clip, time, frameTicks(sequence))) }
  }

  /** The stem a channel listens to, as mono samples (kept while the app runs). */
  private async stem(item: MediaItem, stem: 'drums' | 'bass'): Promise<Float32Array> {
    const project = projectController.project!
    const status = await window.ginosa.stems.status()
    const separator = status.separators[0]
    if (!separator) throw new Error('stem separation isn’t set up on this Mac')
    const paths = await window.ginosa.stems.separate(project.id, item.path, hashText(JSON.stringify(['stems', separator, item.fingerprint])), separator)
    const path = paths[stem]
    let samples = this.stems.get(path)
    if (!samples) {
      samples = window.ginosa.stems.pcm(path, RATE).then((b) => new Float32Array(b))
      this.stems.set(path, samples)
      samples.catch(() => this.stems.delete(path))
    }
    return samples
  }

  /** Plays the cube's moment in its stem; resolves with what was played (its length and loudest sample), for the tests. */
  async play(placed: PlacedSection, row: RackRow, step: number): Promise<{ seconds: number; peak: number }> {
    if (!row.detect) throw new Error('only detected channels have a stem to listen to')
    const at = this.where(placed, row, step)
    if (!at) throw new Error('there’s no song on A1 under that cube')
    const samples = await this.stem(at.item, DETECT_LISTEN[row.detect].stem)
    const from = Math.max(0, Math.round((at.seconds - BEFORE) * RATE))
    const to = Math.min(samples.length, Math.round((at.seconds + AFTER) * RATE))
    if (to <= from) throw new Error('that moment is past the end of the song')
    this.context ??= new AudioContext({ sampleRate: RATE })
    const buffer = this.context.createBuffer(1, to - from, RATE)
    const out = buffer.getChannelData(0)
    out.set(samples.subarray(from, to))
    const fade = Math.round(FADE * RATE)
    let peak = 0
    for (let i = 0; i < out.length; i++) {
      const edge = Math.min(1, i / fade, (out.length - 1 - i) / fade)
      out[i] = out[i]! * edge
      peak = Math.max(peak, Math.abs(out[i]!))
    }
    this.source?.stop()
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.context.destination)
    source.start()
    this.source = source
    await this.context.resume()
    return { seconds: (to - from) / RATE, peak }
  }

  /** Saves your answer on a doubtful cube (kept or deleted) with the bench's answers. */
  async answer(placed: PlacedSection, row: RackRow, step: number, kept: boolean): Promise<void> {
    if (!this.recording || !row.detect) return
    const at = this.where(placed, row, step)
    if (!at) return
    await window.ginosa.stems.answer({ song: at.item.path, fingerprint: hashText(JSON.stringify(at.item.fingerprint)), kind: row.detect, seconds: at.seconds, kept })
  }
}

export const listenBack = new ListenBack()

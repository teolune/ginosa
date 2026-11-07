/**
 * Waveform peaks, detailed enough to zoom into: the lowest and highest sample of every 10
 * (4800 a second from a 48 kHz mono mix), so at the timeline's closest zoom (2400 px a second)
 * each pixel of a Retina screen has its own. Zoomed out, coarser copies (each a quarter the
 * size of the one before) keep drawing quick: a column never reads more than a few peaks.
 *
 * File (cache): uint32 peaks per second, uint32 peak count, then min, max pairs as int16
 * (±32767 = ±1). The `.peaks2` extension keeps older files (100 a second) from being read.
 */

export const WAVEFORM_SAMPLE_RATE = 48_000
export const WAVEFORM_PEAKS_PER_SECOND = 4_800
export const WAVEFORM_EXTENSION = 'peaks2'
const HEADER_BYTES = 8
const FULL = 32_767

export interface WaveLevel {
  /** Peaks per second. */
  rate: number
  /** min, max pairs, ±32767 = ±1. */
  peaks: Int16Array
}

/** Finest first; each level a quarter the rate of the one before. */
export interface Waveform {
  levels: WaveLevel[]
  /** Seconds of sound. */
  duration: number
}

/** Accumulates samples into peaks as they're decoded (in pieces of any size). */
export class PeakWriter {
  private peaks: number[] = []
  private min = FULL
  private max = -FULL
  private count = 0
  private readonly per = WAVEFORM_SAMPLE_RATE / WAVEFORM_PEAKS_PER_SECOND

  add(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const v = Math.round(Math.max(-1, Math.min(1, samples[i]!)) * FULL)
      if (v < this.min) this.min = v
      if (v > this.max) this.max = v
      if (++this.count === this.per) this.flush()
    }
  }

  private flush(): void {
    this.peaks.push(this.min, this.max)
    this.min = FULL
    this.max = -FULL
    this.count = 0
  }

  /** The cache file. */
  finish(): Uint8Array {
    if (this.count > 0) this.flush()
    const out = new Uint8Array(HEADER_BYTES + this.peaks.length * 2)
    const view = new DataView(out.buffer)
    view.setUint32(0, WAVEFORM_PEAKS_PER_SECOND, true)
    view.setUint32(4, this.peaks.length / 2, true)
    new Int16Array(out.buffer, HEADER_BYTES).set(this.peaks)
    return out
  }
}

/** A cache file back into a waveform, with its coarser levels. */
export function readWaveform(buffer: ArrayBuffer): Waveform {
  const view = new DataView(buffer)
  const rate = view.getUint32(0, true)
  const count = view.getUint32(4, true)
  const finest: WaveLevel = { rate, peaks: new Int16Array(buffer.slice(HEADER_BYTES, HEADER_BYTES + count * 4)) }
  const levels = [finest]
  // A quarter the rate each time, down to about one peak a second.
  for (let level = finest; level.rate / 4 >= 1 && level.peaks.length > 8; ) {
    const n = Math.ceil(level.peaks.length / 2 / 4)
    const peaks = new Int16Array(n * 2)
    for (let i = 0; i < n; i++) {
      let lo = FULL
      let hi = -FULL
      for (let k = i * 4; k < Math.min(i * 4 + 4, level.peaks.length / 2); k++) {
        lo = Math.min(lo, level.peaks[k * 2]!)
        hi = Math.max(hi, level.peaks[k * 2 + 1]!)
      }
      peaks[i * 2] = lo
      peaks[i * 2 + 1] = hi
    }
    level = { rate: level.rate / 4, peaks }
    levels.push(level)
  }
  return { levels, duration: count / rate }
}

/** The coarsest level that still has a peak for every `seconds` (a column's span), so drawing reads few. */
export function levelFor(wave: Waveform, seconds: number): WaveLevel {
  let pick = wave.levels[0]!
  for (const level of wave.levels) if (1 / level.rate <= seconds) pick = level
  return pick
}

/** The lowest and highest sample (−1 to 1) from `t0` to `t1` seconds, or null outside the sound. */
export function peakRange(level: WaveLevel, t0: number, t1: number): [number, number] | null {
  const count = level.peaks.length / 2
  const a = Math.max(0, Math.floor(Math.min(t0, t1) * level.rate))
  const b = Math.min(count, Math.max(a + 1, Math.ceil(Math.max(t0, t1) * level.rate)))
  if (a >= count || b <= 0) return null
  let lo = FULL
  let hi = -FULL
  for (let i = a; i < b; i++) {
    lo = Math.min(lo, level.peaks[i * 2]!)
    hi = Math.max(hi, level.peaks[i * 2 + 1]!)
  }
  return [lo / FULL, hi / FULL]
}

import type { BeatGrid } from '../project/model'
import { secondsToTicks, ticksToSeconds, type Ticks } from '../time'

/**
 * The beat grid (M8): a constant tempo laid over the sequence. Beat n sits at
 * downbeat + n × (60 / BPM) seconds, for any whole n (negative before the downbeat), and
 * every `beatsPerBar`-th beat starts a bar. Positions are exact (not rounded to frames);
 * snapping rounds them to the frame grid where clips and keyframes live.
 */

export const MIN_BPM = 20
export const MAX_BPM = 999.999

export function beatLength(grid: BeatGrid): Ticks {
  return secondsToTicks(60 / grid.bpm)
}

/** Beat number at `time` (fractional; 0 at the downbeat). */
export function beatAt(grid: BeatGrid, time: Ticks): number {
  return (time - grid.downbeat) / beatLength(grid)
}

export function beatTime(grid: BeatGrid, beat: number): Ticks {
  return grid.downbeat + beat * beatLength(grid)
}

/** 0–1 through the current beat, and through the current bar. */
export function beatPhase(grid: BeatGrid, time: Ticks): number {
  const b = beatAt(grid, time)
  return b - Math.floor(b)
}

export function barPhase(grid: BeatGrid, time: Ticks): number {
  const b = beatAt(grid, time) / grid.beatsPerBar
  return b - Math.floor(b)
}

/** Bar number shown on the ruler: bar 1 starts at the first downbeat at or after the sequence start. */
export function barNumber(grid: BeatGrid, time: Ticks): number {
  const first = Math.ceil(beatAt(grid, 0) / grid.beatsPerBar - 1e-9)
  return Math.floor(beatAt(grid, time) / grid.beatsPerBar + 1e-9) - first + 1
}

/** Beats in [from, to], each with whether it starts a bar. */
export function beatsBetween(grid: BeatGrid, from: Ticks, to: Ticks): Array<{ time: Ticks; beat: number; bar: boolean }> {
  const out: Array<{ time: Ticks; beat: number; bar: boolean }> = []
  for (let n = Math.ceil(beatAt(grid, from) - 1e-9); ; n++) {
    const time = beatTime(grid, n)
    if (time > to) break
    out.push({ time, beat: n, bar: ((n % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar === 0 })
  }
  return out
}

/** Beat times in [from, to] rounded to the frame grid, for snapping. */
export function beatSnapTargets(grid: BeatGrid, from: Ticks, to: Ticks, frame: Ticks): Ticks[] {
  return beatsBetween(grid, Math.max(0, from), to).map((b) => Math.round(b.time / frame) * frame)
}

/**
 * Tap tempo: the BPM from tap times (ms, oldest first), by a least-squares line through
 * them, so one late tap doesn't swing it. Needs four taps; a pause of 2 s starts over.
 */
export function tapTempo(taps: number[]): number | null {
  const recent: number[] = []
  for (const t of taps) {
    if (recent.length > 0 && t - recent[recent.length - 1]! > 2000) recent.length = 0
    recent.push(t)
  }
  const n = recent.length
  if (n < 4) return null
  const mean = (n - 1) / 2
  const tMean = recent.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  recent.forEach((t, i) => {
    num += (i - mean) * (t - tMean)
    den += (i - mean) ** 2
  })
  const interval = num / den
  return interval > 0 ? Math.round((60_000 / interval) * 100) / 100 : null
}

/** The downbeat moved by whole beats so it sits near `near` (keeps the grid; tidier numbers). */
export function normaliseDownbeat(grid: BeatGrid, near: Ticks = 0): Ticks {
  const bar = beatLength(grid) * grid.beatsPerBar
  return grid.downbeat - Math.floor((grid.downbeat - near) / bar) * bar
}

export function describeGrid(grid: BeatGrid): string {
  return `${Math.round(grid.bpm * 100) / 100} BPM, ${grid.beatsPerBar}/4, downbeat at ${ticksToSeconds(grid.downbeat).toFixed(3)} s`
}

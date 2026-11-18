/**
 * The grid from Beat This! (W4.5, decision 123): Beat This! (Foscarin, Schlüter and Widmer, ISMIR
 * 2024) lists the beats and downbeats of the song file, in 20 ms frames; this lays a constant
 * grid over them, counts it the way your DAW does, and puts bar 1 where the music starts. Times
 * here are seconds in the song file.
 */

export interface SongBeats {
  beats: number[]
  downbeats: number[]
  /** Where the music starts: the end of any silence at the start of the file. */
  firstSound: number
}

export interface SongGrid {
  bpm: number
  /** Bar 1: the first bar line at the music's first sound (a pickup before it is bar 0). */
  downbeat: number
  /** How well the beats line up on one constant tempo, 0–1. */
  steadiness: number
  /** The share of Beat This!'s downbeats on the bar line chosen, 0–1. */
  barShare: number
  /** The count was doubled (Beat This! heard it in half time). */
  doubled: boolean
}

/** Beat This! hears half time below this; your songs count twice as fast in your DAW (167, not 83.5). */
export const DOUBLE_BELOW_BPM = 90
/** A first sound this close before a bar line starts on it. */
const ON_THE_LINE = 0.07

/**
 * The beat length within 5% of the beats' median spacing on which they line up best (the mean of
 * their phases is longest, so missed beats and the 20 ms frames don't matter), and its phase.
 */
export function steadyBeat(beats: readonly number[]): { period: number; phase: number; steadiness: number } | null {
  if (beats.length < 8) return null
  const gaps = beats
    .slice(1)
    .map((b, i) => b - beats[i]!)
    .sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]!
  if (!(median > 0)) return null
  let best = { period: median, phase: 0, steadiness: -1 }
  const STEPS = 4000
  for (let i = 0; i <= STEPS; i++) {
    const period = median * (0.95 + (0.1 * i) / STEPS)
    let c = 0
    let s = 0
    for (const b of beats) {
      const a = (2 * Math.PI * b) / period
      c += Math.cos(a)
      s += Math.sin(a)
    }
    const steadiness = Math.hypot(c, s) / beats.length
    if (steadiness > best.steadiness) best = { period, phase: ((((Math.atan2(s, c) / (2 * Math.PI)) * period) % period) + period) % period, steadiness }
  }
  return best
}

/** The grid for a song: Beat This!'s tempo (doubled below 90 BPM), its bar lines, bar 1 at the first sound. */
export function songGrid(song: SongBeats, beatsPerBar = 4): SongGrid | null {
  const steady = steadyBeat(song.beats)
  if (!steady) return null
  const { period, phase } = steady
  // Which beat of the bar: the one most of the downbeats fall on.
  const votes = new Array<number>(beatsPerBar).fill(0)
  for (const d of song.downbeats) {
    const n = Math.round((d - phase) / period)
    if (Math.abs(d - (phase + n * period)) < ON_THE_LINE) votes[((n % beatsPerBar) + beatsPerBar) % beatsPerBar]! += 1
  }
  const total = votes.reduce((a, b) => a + b, 0)
  const first = votes.indexOf(Math.max(...votes))
  const doubled = 60 / period < DOUBLE_BELOW_BPM
  const beat = doubled ? period / 2 : period
  const bar = beat * beatsPerBar
  // A bar line of Beat This!'s count is one of the doubled count's too.
  const line = phase + first * period
  // The first bar line at the first sound (or just before it); it can be a hair before the file's start.
  const after = song.firstSound - ON_THE_LINE
  const downbeat = line + Math.ceil((after - line) / bar) * bar
  return { bpm: 60 / beat, downbeat, steadiness: steady.steadiness, barShare: total ? votes[first]! / total : 0, doubled }
}

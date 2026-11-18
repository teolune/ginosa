import { describe, expect, it } from 'vitest'
import { songGrid, steadyBeat } from './song-beats'

/** Beats at `bpm` from `start`, in Beat This!'s 20 ms frames, every `per`-th a downbeat starting at beat `first`. */
function song(bpm: number, start: number, count: number, per = 4, first = 0, firstSound = 0) {
  const beat = 60 / bpm
  const beats = Array.from({ length: count }, (_, i) => Math.round((start + i * beat) * 50) / 50)
  return { beats, downbeats: beats.filter((_, i) => i % per === first % per), firstSound }
}

describe('the grid from Beat This!', () => {
  it('finds the steady tempo through 20 ms frames and a missed beat', () => {
    const s = song(128, 0.4, 64)
    s.beats.splice(20, 1)
    const steady = steadyBeat(s.beats)!
    expect(60 / steady.period).toBeCloseTo(128, 1)
    expect(steady.steadiness).toBeGreaterThan(0.95)
  })

  it('puts bar 1 on the downbeats, from the start of the music', () => {
    const g = songGrid(song(128, 0.4, 64))!
    expect(g.bpm).toBeCloseTo(128, 1)
    expect(g.doubled).toBe(false)
    expect(g.downbeat).toBeCloseTo(0.4, 1)
    expect(g.barShare).toBe(1)
  })

  it('counts half time twice as fast, as your DAW does (83.5 → 167)', () => {
    const g = songGrid(song(83.5, 0.0, 120))!
    expect(g.bpm).toBeCloseTo(167, 0)
    expect(g.doubled).toBe(true)
    expect(g.downbeat).toBeCloseTo(0, 1)
  })

  it('starts bar 1 at the first sound after silence, not in the silence', () => {
    // Downbeats every 2.4 s from 0.2 s (100 BPM); the music starts at 5.0 s, on a bar line.
    const g = songGrid(song(100, 0.2, 80, 4, 0, 5.0))!
    expect(g.downbeat).toBeCloseTo(5.0, 1)
  })

  it('a song cut mid-bar starts at its first whole bar (the beat before is a pickup)', () => {
    // Downbeats on the third beat given (1.2 s); the file starts on a beat that isn't one.
    const g = songGrid(song(100, 0.0, 80, 4, 2))!
    expect(g.downbeat).toBeCloseTo(1.2, 1)
  })

  it('needs a few beats', () => {
    expect(songGrid({ beats: [0, 0.5, 1], downbeats: [0], firstSound: 0 })).toBeNull()
  })
})

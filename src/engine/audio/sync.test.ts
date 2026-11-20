import { describe, expect, it } from 'vitest'
import { butterworth, filtfilt } from './dsp'
import { SYNC_RATE, fft, findSync, syncSound } from './sync'

/** A seeded random source, so the tests are the same every run. */
function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A minute of "song" at 8 kHz: kicks on most beats (122 BPM unless asked), hats and snares at random 16ths, and a bass line of changing notes. */
function song(seconds = 60, seed = 1, bpm = 122): Float32Array {
  const rand = random(seed)
  const out = new Float32Array(seconds * SYNC_RATE)
  const beat = 60 / bpm
  const add = (at: number, length: number, f: (t: number) => number) => {
    const start = Math.round(at * SYNC_RATE)
    for (let i = 0; i < length * SYNC_RATE && start + i < out.length; i++) out[start + i]! += f(i / SYNC_RATE)
  }
  for (let b = 0; b * beat < seconds; b++) {
    if (rand() < 0.85) add(b * beat, 0.25, (t) => 0.8 * Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12))
    const note = 55 * Math.pow(2, Math.floor(rand() * 12) / 12)
    add(b * beat, beat * 0.9, (t) => 0.25 * Math.sin(2 * Math.PI * note * t) * Math.exp(-t * 2))
    for (let s = 0; s < 4; s++) {
      if (rand() < 0.45) add(b * beat + (s * beat) / 4, 0.05, (t) => 0.3 * (rand() * 2 - 1) * Math.exp(-t * 80))
      if (rand() < 0.12) add(b * beat + (s * beat) / 4, 0.15, (t) => 0.5 * (rand() * 2 - 1) * Math.exp(-t * 25))
    }
  }
  return out
}

/** The song as a camera hears it: a stretch from `from` for `seconds` (after `before` seconds of nothing), quieter, muffled, with a room echo and noise (louder in bursts, like talk) at `snr` dB. */
function take(source: Float32Array, from: number, seconds: number, snr: number, seed = 2, before = 0): Float32Array {
  const rand = random(seed)
  const start = Math.round(from * SYNC_RATE)
  const lead = Math.round(before * SYNC_RATE)
  const clip = new Float32Array(Math.round(seconds * SYNC_RATE) + lead)
  for (let i = 0; i < clip.length - lead; i++) clip[lead + i] = 0.3 * (source[start + i] ?? 0)
  const heard = filtfilt(clip, [butterworth('lowpass', 2500, SYNC_RATE), butterworth('highpass', 120, SYNC_RATE)])
  let power = 0
  for (const v of heard) power += v * v
  const noise = Math.sqrt(power / heard.length / Math.pow(10, snr / 10))
  // The room: an echo 23 ms later.
  const echo = Math.round(0.023 * SYNC_RATE)
  for (let i = heard.length - 1; i >= echo; i--) heard[i]! += 0.45 * heard[i - echo]!
  // Noise, louder in bursts at random (people talking).
  let burst = 1
  for (let i = 0; i < heard.length; i++) {
    if (i % 2000 === 0) burst = rand() < 0.3 ? 2.2 : 0.6
    heard[i]! += noise * burst * (rand() * 2 - 1) * Math.sqrt(3)
  }
  return heard
}

describe('syncing takes to the song by their sound (W5.1)', () => {
  const music = song()
  const songSound = syncSound(music)

  it('the FFT gives back what it was given', () => {
    const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + (i % 5))
    const im = new Float64Array(64)
    const before = Array.from(re)
    fft(re, im)
    fft(re, im, true)
    re.forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 9))
  })

  it('finds a take within a frame of where it is, through a muffled microphone and noise', () => {
    for (const [from, seconds, snr] of [
      [12.34, 20, 10],
      [3.217, 40, 3],
      [31.5, 12, 0]
    ] as const) {
      const match = findSync(songSound, syncSound(take(music, from, seconds, snr, Math.round(from * 7))))
      expect(match.confidence).toBe('sure')
      // To well under a millisecond (a frame is 40 ms at 25 fps).
      expect(Math.abs(match.offset - from)).toBeLessThan(0.001)
    }
  })

  it('a take that starts before the song gets a negative offset', () => {
    const match = findSync(songSound, syncSound(take(music, 0, 15, 10, 5, 2.5)))
    expect(match.confidence).toBe('sure')
    expect(Math.abs(match.offset - -2.5)).toBeLessThan(0.001)
  })

  it('noise alone, or another song, isn’t matched', () => {
    const rand = random(9)
    const noise = Float32Array.from({ length: 20 * SYNC_RATE }, () => rand() * 2 - 1)
    expect(findSync(songSound, syncSound(noise)).confidence).toBe('none')
    const other = take(song(25, 77, 97), 0, 25, 20, 3)
    expect(findSync(songSound, syncSound(other)).confidence).not.toBe('sure')
  })

  it('a stretch the song repeats exactly can’t be placed for sure, and the other place is offered', () => {
    // The same 8 s twice (a repeated chorus), and a take of just that.
    const chorus = music.slice(10 * SYNC_RATE, 18 * SYNC_RATE)
    const repeated = new Float32Array(music)
    repeated.set(chorus, 40 * SYNC_RATE)
    const match = findSync(syncSound(repeated), syncSound(take(repeated, 10, 8, 10, 4)))
    expect(match.confidence).not.toBe('sure')
    const places = [match.offset, match.alternative].map((v) => Math.round(v ?? -1))
    expect(places.sort((a, b) => a - b)).toEqual([10, 40])
  })
})

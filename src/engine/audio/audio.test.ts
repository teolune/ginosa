import { describe, expect, it } from 'vitest'
import { ANALYSIS_RATE, ANALYSIS_SAMPLE_RATE, analyseAudio, analyseBand, customBandWindow, packAnalysis, strongHits, unpackAnalysis } from './analysis'
import { DETECT_LISTEN } from '../timeline/rack'

const SR = ANALYSIS_SAMPLE_RATE

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Pattern = 'four' | 'halftime' | 'dnb' | 'kickhat'

/** Synthetic drums: kicks, snares and hats at known times (beats in a 4-beat bar). */
function drums(bpm: number, seconds: number, offset: number, pattern: Pattern, seed = 1): { pcm: Float32Array; kicks: number[] } {
  const pcm = new Float32Array(Math.round(seconds * SR))
  const random = rng(seed)
  const beat = 60 / bpm
  const kicks: number[] = []
  const kick = (t0: number, gain: number) => {
    kicks.push(t0)
    let phase = 0
    for (let i = Math.round(t0 * SR); i < Math.min(pcm.length, Math.round((t0 + 0.4) * SR)); i++) {
      const t = i / SR - t0
      phase += (2 * Math.PI * (48 + 80 * Math.exp(-t / 0.03))) / SR
      pcm[i] = pcm[i]! + gain * Math.sin(phase) * Math.exp(-t / 0.12)
    }
  }
  const noise = (t0: number, gain: number, decay: number, bright: boolean) => {
    let last = 0
    for (let i = Math.round(t0 * SR); i < Math.min(pcm.length, Math.round((t0 + decay * 6) * SR)); i++) {
      const t = i / SR - t0
      const n = random() * 2 - 1
      const v = bright ? n - last : n
      last = n
      pcm[i] = pcm[i]! + gain * v * Math.exp(-t / decay)
    }
  }
  const kicksAt: Record<Pattern, number[]> = { four: [0, 1, 2, 3], halftime: [0, 1.5], dnb: [0, 2.5], kickhat: [0, 1, 2, 3] }
  const snaresAt: Record<Pattern, number[]> = { four: [1, 3], halftime: [2], dnb: [1, 3], kickhat: [] }
  for (let bar = 0; offset + bar * 4 * beat < seconds; bar++) {
    const start = offset + bar * 4 * beat
    for (const k of kicksAt[pattern]) kick(start + k * beat, k === 0 ? 0.9 : 0.6)
    for (const s of snaresAt[pattern]) noise(start + s * beat, 0.35, 0.05, false)
    for (let h = 0; h < 8; h++) noise(start + (h + (pattern === 'kickhat' ? 0.5 : 0)) * 0.5 * beat, 0.12, 0.012, true)
  }
  return { pcm, kicks }
}

const tone = (freq: number, seconds: number, amp = 0.5, from = 0) => {
  const pcm = new Float32Array(Math.round(seconds * SR))
  for (let i = Math.round(from * SR); i < pcm.length; i++) pcm[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR)
  return pcm
}

describe('audio analysis', () => {
  it('splits sound into bands, with RMS levels', () => {
    // Zero-phase Linkwitz–Riley: low-pass |H| = 1 / (1 + (f/fc)^4), high-pass the rest, and the two sum to 1.
    const lp = (f: number, fc: number) => 1 / (1 + (f / fc) ** 4)
    const hp = (f: number, fc: number) => 1 - lp(f, fc)
    // A window that isn't a whole number of a low tone's cycles ripples, so levels are averaged over a second.
    const mean = (x: Float32Array) => x.slice(ANALYSIS_RATE, ANALYSIS_RATE * 2).reduce((a, b) => a + b, 0) / ANALYSIS_RATE
    const rms = 0.5 / Math.SQRT2
    const a = analyseAudio(tone(40, 3))
    expect(mean(a.bands.sub.level)).toBeCloseTo(rms * hp(40, 20) * lp(40, 60), 3)
    expect(mean(a.bands.bass.level)).toBeCloseTo(rms * hp(40, 60) * lp(40, 250), 2)
    expect(mean(a.bands.mid.level) / mean(a.bands.sub.level)).toBeLessThan(0.001)
    const b = analyseAudio(tone(1000, 3))
    expect(mean(b.bands.mid.level)).toBeCloseTo(rms * hp(1000, 500) * lp(1000, 2000), 3)
    expect(mean(b.bands.bass.level) / mean(b.bands.mid.level)).toBeLessThan(0.01)
    expect(mean(b.loudness)).toBeCloseTo(rms, 3)
    expect(mean(b.peak)).toBeCloseTo(0.5, 2)
  })

  it('has no filter delay: a band reaches half its level where the sound starts', () => {
    const band = analyseBand(tone(100, 3, 0.5, 1.2), 60, 250, 20)
    const plateau = band.level[ANALYSIS_RATE * 2]!
    const half = band.level.findIndex((v) => v >= plateau / 2) / ANALYSIS_RATE
    expect(Math.abs(half - 1.2)).toBeLessThan(0.006)
  })

  it('finds hits where the drums hit', () => {
    const { pcm, kicks } = drums(100, 12, 0.25, 'four')
    const a = analyseAudio(pcm)
    const hits = a.bands.sub.hits.map((h) => h / ANALYSIS_RATE)
    const matched = kicks.filter((k) => hits.some((h) => Math.abs(h - k) < 0.015))
    expect(matched.length).toBeGreaterThanOrEqual(kicks.length - 1)
    expect(a.bands.high.transientMax).toBeGreaterThan(3)
  })

  it('keeps everything through storage', () => {
    const a = analyseAudio(drums(120, 6, 0, 'four').pcm)
    const b = unpackAnalysis(packAnalysis(a))!
    expect(b.frames).toBe(a.frames)
    expect(Array.from(b.bands.bass.level)).toEqual(Array.from(a.bands.bass.level))
    expect(b.tempo).toEqual(a.tempo)
    expect(b.bands.high.hits).toEqual(a.bands.high.hits)
  })
})

describe('tempo detection', () => {
  const cases: Array<{ bpm: number; pattern: Pattern; offset: number; accept: number[] }> = [
    { bpm: 128, pattern: 'four', offset: 0.37, accept: [128] },
    { bpm: 120, pattern: 'kickhat', offset: 0, accept: [120] },
    { bpm: 97.3, pattern: 'four', offset: 1.13, accept: [97.3] },
    { bpm: 87, pattern: 'halftime', offset: 0.5, accept: [87, 174] },
    { bpm: 174, pattern: 'dnb', offset: 0.2, accept: [174, 87] }
  ]
  for (const c of cases) {
    it(`finds ${c.bpm} BPM (${c.pattern}) and its downbeat`, () => {
      const { pcm } = drums(c.bpm, 60, c.offset, c.pattern, Math.round(c.bpm))
      const t = analyseAudio(pcm).tempo!
      const ok = c.accept.some((bpm) => Math.abs(t.bpm - bpm) <= 0.02)
      expect(ok, `detected ${t.bpm}`).toBe(true)
      if (Math.abs(t.bpm - c.bpm) <= 0.02 && c.pattern !== 'halftime' && c.pattern !== 'dnb') {
        // The bar starts where the pattern's first beat is.
        const bar = (4 * 60) / c.bpm
        const error = ((((t.downbeat - c.offset) % bar) + bar * 1.5) % bar) - bar / 2
        expect(Math.abs(error), `downbeat ${t.downbeat}`).toBeLessThan(0.006)
      }
    })
  }

  it('says nothing about sound shorter than 4 seconds', () => {
    expect(analyseAudio(drums(120, 3, 0, 'four').pcm).tempo).toBeNull()
  })
})

describe('strong hits (Automatic Detection)', () => {
  it('keeps the loud hits and drops quieter sounds that leak into the band', () => {
    const level = new Float32Array(2000)
    const hits = [100, 200, 300, 400, 500, 600, 700, 800]
    hits.forEach((h, i) => (level[h + 2] = i % 2 ? 1 : 0.3))
    expect(strongHits({ hits, level }, 0.45)).toEqual([200, 400, 600, 800])
    expect(strongHits({ hits, level }, 0.25)).toEqual(hits)
    expect(strongHits({ hits, level }, 0)).toEqual(hits)
    expect(strongHits({ hits: [], level }, 0.45)).toEqual([])
  })

  it('compares a hit with the loud hits around it, so a quiet intro keeps its hits', () => {
    const level = new Float32Array(6000)
    const hits: number[] = []
    for (let i = 0; i < 20; i++) {
      hits.push(100 + i * 50)
      level[101 + i * 50] = 0.1
    }
    for (let i = 0; i < 20; i++) {
      hits.push(3000 + i * 50)
      level[3001 + i * 50] = 1
    }
    expect(strongHits({ hits, level }, 0.45)).toEqual(hits)
    // Against the whole song instead, the intro would drop out.
    expect(strongHits({ hits, level }, 0.45, 6000)).toEqual(hits.slice(20))
  })

  it('finds the snare on 2 and 4 in the clap band, and the hi-hats on every 8th in theirs', () => {
    const { pcm } = drums(120, 8, 0, 'four')
    const beats = (hits: number[]) => hits.map((h) => (h / ANALYSIS_RATE) * 2)
    // Within 15 ms (0.03 of a beat at 120 BPM) of where they were played.
    const onGrid = (b: number, every: number) => Math.abs(b * every - Math.round(b * every)) < 0.03 * every
    const clap = DETECT_LISTEN.clap
    const claps = beats(strongHits(analyseBand(pcm, clap.low, clap.high, customBandWindow(clap.low)), clap.gate))
    expect(claps.length).toBeGreaterThanOrEqual(7)
    expect(claps.every((b) => onGrid(b, 1) && Math.round(b) % 2 === 1)).toBe(true)
    const hat = DETECT_LISTEN.hihat
    const hats = beats(strongHits(analyseBand(pcm, hat.low, hat.high, customBandWindow(hat.low)), hat.gate))
    expect(hats.length).toBeGreaterThanOrEqual(28)
    expect(hats.every((b) => onGrid(b, 2))).toBe(true)
    const kick = DETECT_LISTEN.kick
    const kicks = beats(strongHits(analyseBand(pcm, kick.low, kick.high, customBandWindow(kick.low)), kick.gate))
    expect(kicks.length).toBeGreaterThanOrEqual(15)
    expect(kicks.every((b) => onGrid(b, 1))).toBe(true)
  })
})

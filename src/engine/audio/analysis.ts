import { blockStats, butterworth, centredRms, filtfilt, maxOf, riseDb, type Biquad } from './dsp'
import { estimateTempo, type TempoEstimate } from './tempo'

/**
 * Audio analysis (M8): what a source's sound is doing, 200 times a second.
 *   - energy in six bands (zero-phase Linkwitz–Riley crossovers), plus custom ranges
 *   - loudness (RMS) and peak level
 *   - transient strength per band (how fast its level is rising, in dB) and hit events
 *   - an onset signal and the tempo found from it
 * Everything is computed offline over the whole sound, so a frame always gets the same
 * values: what reacts in playback is exactly what exports.
 */

export const ANALYSIS_VERSION = 1
/** Sources are rendered at this rate for analysis. */
export const ANALYSIS_SAMPLE_RATE = 48_000
/** Frames per second of every analysis signal. */
export const ANALYSIS_RATE = 200
const HOP = ANALYSIS_SAMPLE_RATE / ANALYSIS_RATE
const BLOCK = HOP / 2

export type BandId = 'sub' | 'bass' | 'lowMid' | 'mid' | 'highMid' | 'high'

export interface BandSpec {
  id: BandId
  label: string
  low: number
  high: number
  /** RMS window, ms: longer for low bands, whose waves are long. */
  window: number
}

export const BANDS: readonly BandSpec[] = [
  { id: 'sub', label: 'Sub', low: 20, high: 60, window: 50 },
  { id: 'bass', label: 'Bass', low: 60, high: 250, window: 20 },
  { id: 'lowMid', label: 'Low-mid', low: 250, high: 500, window: 10 },
  { id: 'mid', label: 'Mid', low: 500, high: 2000, window: 10 },
  { id: 'highMid', label: 'High-mid', low: 2000, high: 6000, window: 10 },
  { id: 'high', label: 'High', low: 6000, high: 20000, window: 10 }
]

export interface BandAnalysis {
  /** RMS level (linear amplitude). */
  level: Float32Array
  /** Rise in dB over the last 10 ms (0 when falling). */
  transient: Float32Array
  /** Hit events, as (fractional) frame positions. */
  hits: number[]
  /** Loudest level and strongest transient, for scaling to 0–1. */
  max: number
  transientMax: number
}

export interface AudioAnalysis {
  version: number
  rate: number
  frames: number
  bands: Record<BandId, BandAnalysis>
  /** RMS of the whole sound over 20 ms. */
  loudness: Float32Array
  loudnessMax: number
  /** Peak level over each 5 ms. */
  peak: Float32Array
  peakMax: number
  /** Sum of the band transients: what beat tracking listens to. */
  onset: Float32Array
  /** Hits in the whole sound (from the onset signal). */
  hits: number[]
  tempo: TempoEstimate | null
}

function bandFilters(low: number, high: number): Biquad[] {
  const filters: Biquad[] = []
  if (low > 0) filters.push(butterworth('highpass', low, ANALYSIS_SAMPLE_RATE))
  if (high < ANALYSIS_SAMPLE_RATE / 2) filters.push(butterworth('lowpass', high, ANALYSIS_SAMPLE_RATE))
  return filters
}

/** Half-window in half-frame blocks for an RMS window of `ms`. */
function halfBlocks(ms: number): number {
  return Math.max(1, Math.round((ms / 1000) * ANALYSIS_SAMPLE_RATE / BLOCK / 2))
}

/**
 * Hit events: local maxima of a transient signal within ±40 ms that rise at least 3 dB
 * and a quarter of the strongest rise, placed between frames by fitting a parabola.
 */
export function pickHits(transient: Float32Array): number[] {
  const max = maxOf(transient)
  const threshold = Math.max(3, max * 0.25)
  const reach = 8
  const hits: number[] = []
  for (let i = 1; i < transient.length - 1; i++) {
    const v = transient[i]!
    if (v < threshold) continue
    let isPeak = true
    for (let j = Math.max(0, i - reach); j <= Math.min(transient.length - 1, i + reach); j++) {
      if (transient[j]! > v || (transient[j]! === v && j < i)) {
        isPeak = false
        break
      }
    }
    if (!isPeak) continue
    const a = transient[i - 1]!
    const c = transient[i + 1]!
    const curve = a - 2 * v + c
    hits.push(curve < 0 ? i + (0.5 * (a - c)) / curve : i)
  }
  return hits
}

/**
 * Where hits really start. A band's level smears in time (a low band needs a long window,
 * and filters ring), so each band hit is moved to the sharpest rise of the whole sound's
 * 5 ms level within 40 ms, when there is one.
 */
function alignHits(hits: number[], wideRise: Float32Array | null): number[] {
  if (!wideRise) return hits
  return hits.map((h) => {
    const centre = Math.round(h)
    let best = -1
    for (let i = Math.max(1, centre - 8); i <= Math.min(wideRise.length - 2, centre + 8); i++) if (best < 0 || wideRise[i]! > wideRise[best]!) best = i
    if (best < 0 || wideRise[best]! < 3) return h
    const a = wideRise[best - 1]!
    const v = wideRise[best]!
    const c = wideRise[best + 1]!
    const curve = a - 2 * v + c
    return curve < 0 ? best + (0.5 * (a - c)) / curve : best
  })
}

/** The whole sound's level over 5 ms and how fast it rises: the sharpest timing there is. */
function wideOnset(pcm: Float32Array): Float32Array {
  const frames = Math.ceil(pcm.length / HOP)
  const { power } = blockStats(pcm, BLOCK)
  return riseDb(centredRms(power, BLOCK, frames, 1), 1, 40)
}

/** One frequency range of a sound: level, transients and hits. */
export function analyseBand(pcm: Float32Array, low: number, high: number, windowMs: number, wideRise: Float32Array | null = wideOnset(pcm)): BandAnalysis {
  const frames = Math.ceil(pcm.length / HOP)
  const filtered = filtfilt(pcm, bandFilters(low, high))
  const { power } = blockStats(filtered, BLOCK)
  const level = centredRms(power, BLOCK, frames, halfBlocks(windowMs))
  const transient = riseDb(level, 2)
  return { level, transient, hits: alignHits(pickHits(transient), wideRise), max: maxOf(level), transientMax: maxOf(transient) }
}

/** Analyses a mono sound at ANALYSIS_SAMPLE_RATE. `progress` is called with 0–1 as bands finish. */
export function analyseAudio(pcm: Float32Array, progress: (done: number) => void = () => undefined): AudioAnalysis {
  const frames = Math.ceil(pcm.length / HOP)
  const bands = {} as Record<BandId, BandAnalysis>
  const wideRise = wideOnset(pcm)
  BANDS.forEach((band, i) => {
    bands[band.id] = analyseBand(pcm, band.low, band.high, band.window, wideRise)
    progress((i + 1) / (BANDS.length + 2))
  })
  const { power, peak: blockPeak } = blockStats(pcm, BLOCK)
  const loudness = centredRms(power, BLOCK, frames, halfBlocks(20))
  const peak = new Float32Array(frames)
  for (let i = 0; i < frames; i++) peak[i] = Math.max(blockPeak[2 * i - 1] ?? 0, blockPeak[2 * i] ?? 0)
  const onset = new Float32Array(frames)
  for (const band of BANDS) {
    const t = bands[band.id].transient
    for (let i = 0; i < frames; i++) onset[i] = onset[i]! + t[i]!
  }
  progress((BANDS.length + 1) / (BANDS.length + 2))
  const tempo = estimateTempo(onset, bands.bass.level, bands.sub.level, ANALYSIS_RATE)
  progress(1)
  return {
    version: ANALYSIS_VERSION,
    rate: ANALYSIS_RATE,
    frames,
    bands,
    loudness,
    loudnessMax: maxOf(loudness),
    peak,
    peakMax: maxOf(peak),
    onset,
    hits: alignHits(pickHits(onset), wideRise),
    tempo
  }
}

// ---- Storage: a small binary format (JSON header, then the signals as Float32) ---------

const ARRAYS = (a: AudioAnalysis): Array<[string, Float32Array]> => [
  ...BANDS.flatMap((b): Array<[string, Float32Array]> => [
    [`${b.id}.level`, a.bands[b.id].level],
    [`${b.id}.transient`, a.bands[b.id].transient]
  ]),
  ['loudness', a.loudness],
  ['peak', a.peak],
  ['onset', a.onset]
]

export function packAnalysis(a: AudioAnalysis): ArrayBuffer {
  const arrays = ARRAYS(a)
  const header = JSON.stringify({
    version: a.version,
    rate: a.rate,
    frames: a.frames,
    bands: Object.fromEntries(BANDS.map((b) => [b.id, { hits: a.bands[b.id].hits, max: a.bands[b.id].max, transientMax: a.bands[b.id].transientMax }])),
    loudnessMax: a.loudnessMax,
    peakMax: a.peakMax,
    hits: a.hits,
    tempo: a.tempo,
    arrays: arrays.map(([name]) => name)
  })
  const text = new TextEncoder().encode(header)
  const headerBytes = Math.ceil((text.length + 4) / 4) * 4
  const out = new ArrayBuffer(headerBytes + arrays.length * a.frames * 4)
  new DataView(out).setUint32(0, text.length, true)
  new Uint8Array(out, 4, text.length).set(text)
  arrays.forEach(([, data], i) => new Float32Array(out, headerBytes + i * a.frames * 4, a.frames).set(data))
  return out
}

export function unpackAnalysis(buffer: ArrayBuffer): AudioAnalysis | null {
  try {
    const length = new DataView(buffer).getUint32(0, true)
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as {
      version: number
      rate: number
      frames: number
      bands: Record<BandId, { hits: number[]; max: number; transientMax: number }>
      loudnessMax: number
      peakMax: number
      hits: number[]
      tempo: TempoEstimate | null
      arrays: string[]
    }
    if (header.version !== ANALYSIS_VERSION) return null
    const headerBytes = Math.ceil((length + 4) / 4) * 4
    const arrays = new Map(header.arrays.map((name, i) => [name, new Float32Array(buffer.slice(headerBytes + i * header.frames * 4, headerBytes + (i + 1) * header.frames * 4))]))
    const get = (name: string) => {
      const data = arrays.get(name)
      if (!data || data.length !== header.frames) throw new Error(`missing ${name}`)
      return data
    }
    const bands = Object.fromEntries(
      BANDS.map((b) => [b.id, { level: get(`${b.id}.level`), transient: get(`${b.id}.transient`), hits: header.bands[b.id].hits, max: header.bands[b.id].max, transientMax: header.bands[b.id].transientMax }])
    ) as Record<BandId, BandAnalysis>
    return {
      version: header.version,
      rate: header.rate,
      frames: header.frames,
      bands,
      loudness: get('loudness'),
      loudnessMax: header.loudnessMax,
      peak: get('peak'),
      peakMax: header.peakMax,
      onset: get('onset'),
      hits: header.hits,
      tempo: header.tempo
    }
  } catch {
    return null
  }
}

/** A single band on its own (a custom range), stored the same way. */
export function packBand(b: BandAnalysis): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify({ version: ANALYSIS_VERSION, frames: b.level.length, hits: b.hits, max: b.max, transientMax: b.transientMax }))
  const headerBytes = Math.ceil((header.length + 4) / 4) * 4
  const out = new ArrayBuffer(headerBytes + b.level.length * 8)
  new DataView(out).setUint32(0, header.length, true)
  new Uint8Array(out, 4, header.length).set(header)
  new Float32Array(out, headerBytes, b.level.length).set(b.level)
  new Float32Array(out, headerBytes + b.level.length * 4, b.level.length).set(b.transient)
  return out
}

export function unpackBand(buffer: ArrayBuffer): BandAnalysis | null {
  try {
    const length = new DataView(buffer).getUint32(0, true)
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as { version: number; frames: number; hits: number[]; max: number; transientMax: number }
    if (h.version !== ANALYSIS_VERSION) return null
    const headerBytes = Math.ceil((length + 4) / 4) * 4
    const level = new Float32Array(buffer.slice(headerBytes, headerBytes + h.frames * 4))
    const transient = new Float32Array(buffer.slice(headerBytes + h.frames * 4, headerBytes + h.frames * 8))
    if (level.length !== h.frames || transient.length !== h.frames) return null
    return { level, transient, hits: h.hits, max: h.max, transientMax: h.transientMax }
  } catch {
    return null
  }
}

/** Custom bands use the window of the built-in band their low edge falls in. */
export function customBandWindow(low: number): number {
  return (BANDS.find((b) => low >= b.low && low < b.high) ?? BANDS[BANDS.length - 1]!).window
}

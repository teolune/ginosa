import { sampleAt } from './dsp'

/**
 * Tempo detection from an onset signal (M8). Constant tempo: the song's beats are found
 * as one grid (BPM and phase) that best lines up with its onsets over the whole sound,
 * then the bar's first beat is the one with the most low-end attack (kick drums).
 *   1. Autocorrelation of the onset signal, scored with a harmonic comb and a gentle
 *      preference for 80–160 BPM, picks the tempo (half- and double-tempo answers are
 *      common; ×2 and ÷2 in the app fix them, and the other likely tempos are listed).
 *   2. Every onset is folded onto one beat's length; the tempo and phase where the folded
 *      onsets pile up highest are kept, searched coarse then fine (to 0.001 BPM), so a
 *      small tempo error, which smears the pile over a whole song, can't survive.
 *   3. The bar starts on the beat, of four, with the loudest low end (the kick on "one").
 */

export interface TempoEstimate {
  bpm: number
  /** Seconds from the start of the sound to the first beat that starts a bar. */
  downbeat: number
  beatsPerBar: number
  /** How clearly the beat stands out, 0–1. */
  confidence: number
  /** Other likely tempos (best first), for the ×2 / ÷2 and a list to choose from. */
  candidates: Array<{ bpm: number; score: number }>
}

const MIN_BPM = 50
const MAX_BPM = 220
/** Onset peaks come this many frames after the attack (calibrated in the tests on synthetic drums). */
export const ONSET_DELAY_FRAMES = 0

function movingMeanRemoved(x: Float32Array, half: number): Float32Array {
  const prefix = new Float64Array(x.length + 1)
  for (let i = 0; i < x.length; i++) prefix[i + 1] = prefix[i]! + x[i]!
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - half)
    const hi = Math.min(x.length, i + half + 1)
    out[i] = x[i]! - (prefix[hi]! - prefix[lo]!) / (hi - lo)
  }
  return out
}

function autocorrelation(x: Float32Array, maxLag: number): Float64Array {
  const ac = new Float64Array(maxLag + 1)
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0
    const n = x.length - lag
    for (let i = 0; i < n; i++) sum += x[i]! * x[i + lag]!
    ac[lag] = n > 0 ? sum / n : 0
  }
  return ac
}

/** How strongly the onsets pile up when folded onto a beat of `period` frames: the best phase and its height. */
function fold(onset: Float32Array, period: number, bins: number): { phase: number; height: number; mean: number } {
  const hist = new Float64Array(bins)
  for (let i = 0; i < onset.length; i++) {
    const v = onset[i]!
    if (v === 0) continue
    const p = (i % period) / period
    const at = p * bins
    const b = Math.floor(at)
    const f = at - b
    hist[b % bins] = hist[b % bins]! + v * (1 - f)
    hist[(b + 1) % bins] = hist[(b + 1) % bins]! + v * f
  }
  // Smooth over about ±1 frame, so onsets that wander slightly still pile up together.
  const width = Math.max(1, Math.round(bins / period))
  const smooth = new Float64Array(bins)
  for (let b = 0; b < bins; b++) {
    let sum = 0
    for (let d = -width; d <= width; d++) sum += hist[(b + d + bins) % bins]! * (width + 1 - Math.abs(d))
    smooth[b] = sum
  }
  let best = 0
  let mean = 0
  for (let b = 0; b < bins; b++) {
    mean += smooth[b]!
    if (smooth[b]! > smooth[best]!) best = b
  }
  // Between bins: a parabola through the peak and its neighbours.
  const a = smooth[(best - 1 + bins) % bins]!
  const c = smooth[(best + 1) % bins]!
  const v = smooth[best]!
  const curve = a - 2 * v + c
  const offset = curve < 0 ? (0.5 * (a - c)) / curve : 0
  return { phase: (((best + offset) / bins) * period + period) % period, height: v, mean: mean / bins }
}

export function estimateTempo(onset: Float32Array, bassLevel: Float32Array, subLevel: Float32Array, rate: number): TempoEstimate | null {
  if (onset.length < rate * 4) return null
  const centred = movingMeanRemoved(onset, Math.round(rate / 2))
  const maxLag = Math.ceil((60 * rate) / MIN_BPM) * 4
  const ac = autocorrelation(centred, Math.min(maxLag, onset.length - 1))
  const acAt = (lag: number) => (lag >= ac.length - 1 ? 0 : sampleAt(ac, lag))

  // 1. Tempo candidates from the autocorrelation.
  const scored: Array<{ bpm: number; score: number }> = []
  for (let bpm = MIN_BPM; bpm <= MAX_BPM + 1e-9; bpm += 0.25) {
    const lag = (60 * rate) / bpm
    let comb = 0
    for (let m = 1; m <= 4; m++) comb += acAt(m * lag) / m
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2)
    scored.push({ bpm, score: Math.max(0, comb) * prior })
  }
  const peaks = scored.filter((s, i) => s.score > 0 && s.score >= (scored[i - 1]?.score ?? 0) && s.score >= (scored[i + 1]?.score ?? 0))
  peaks.sort((a, b) => b.score - a.score)
  if (peaks.length === 0) return null

  // 2. Fold the onsets to pin down tempo and phase, coarse then fine, for the top candidates.
  const refine = (center: number) => {
    let best = { bpm: center, phase: 0, height: -1, mean: 0 }
    const search = (from: number, to: number, step: number, binsPerFrame: number) => {
      for (let bpm = from; bpm <= to + 1e-9; bpm += step) {
        const period = (60 * rate) / bpm
        const f = fold(onset, period, Math.max(8, Math.round(period * binsPerFrame)))
        if (f.height > best.height) best = { bpm, ...f }
      }
    }
    search(center - 1, center + 1, 0.02, 2)
    const coarse = best.bpm
    search(coarse - 0.03, coarse + 0.03, 0.001, 4)
    return best
  }
  const top = refine(peaks[0]!.bpm)
  const bpm = Math.round(top.bpm * 1000) / 1000
  const period = (60 * rate) / top.bpm
  const phase = top.phase - ONSET_DELAY_FRAMES

  // 3. The bar's first beat: the one, of four, with the loudest low end just after it (the kick on "one").
  const beatsPerBar = 4
  const low = (frame: number) => {
    let best = 0
    for (let d = 0; d <= Math.round(rate * 0.06); d++) best = Math.max(best, sampleAt(bassLevel, frame + d) + sampleAt(subLevel, frame + d))
    return best
  }
  const accents = new Array<number>(beatsPerBar).fill(0)
  for (let n = 0; phase + n * period < onset.length; n++) accents[n % beatsPerBar] = accents[n % beatsPerBar]! + low(phase + n * period)
  const which = accents.indexOf(Math.max(...accents))
  const barLength = period * beatsPerBar
  const downbeatFrame = (((phase + which * period) % barLength) + barLength) % barLength
  const confidence = Math.max(0, Math.min(1, top.mean > 0 ? (top.height - top.mean) / top.height : 0))
  const candidates = peaks.slice(0, 5).map((p) => ({ bpm: p.bpm, score: Math.round((p.score / peaks[0]!.score) * 1000) / 1000 }))
  candidates[0] = { bpm, score: 1 }
  return { bpm, downbeat: downbeatFrame / rate, beatsPerBar, confidence: Math.round(confidence * 1000) / 1000, candidates }
}

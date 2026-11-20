import { butterworth, filtfilt } from './dsp'

/**
 * Syncing a take to the song by its sound (W5.1, decision 134). A take filmed while the song
 * played back carries the song's own recording in its sound: quieter, coloured by a speaker, a
 * room and a microphone, with talk and noise on top. So the take's sound is slid along the
 * song's and compared sample by sample (a cross-correlation, through FFTs), with each frequency
 * given nearly equal weight (GCC-PHAT with β 0.8: the colouring of the speaker, room and
 * microphone doesn't matter, and the peak comes out sharp even though music repeats its rhythm
 * every beat). The best match is refined between samples by a parabola through the peak. How
 * sure it is: the peak against the correlation's spread elsewhere, and against the best other
 * peak more than 0.1 s away (a song can repeat a stretch exactly, a chorus pasted twice: then
 * it can't be sure, and the other place is offered).
 */

/** The sample rate sync works at (both sounds are read at this rate). */
export const SYNC_RATE = 8000
/** How much each frequency keeps its own strength (0: none, PHAT; 1: plain correlation). */
const BETA = 0.2
/** The overlap a match needs, in seconds (or all of the shorter sound, if it's shorter). */
const MIN_OVERLAP = 4
/**
 * Sure: the peak stands 15 spreads above the rest and twice as high as any other. In the tests,
 * takes of the song through a muffled microphone, a room echo and noise as loud as the song
 * score 120–300; noise alone and another song about 5–6. Between 8 and 15 it's offered, flagged.
 */
const SURE_SCORE = 15
const SURE_LEAD = 2

/**
 * A sound made ready for syncing: band-limited to 100 Hz–3.5 kHz (no rumble, no hiss above the
 * song), and faded in and out over a quarter of a second, so the two sounds' abrupt starts and
 * ends don't match each other (they would, at no offset, whatever the sounds).
 */
export function syncSound(samples: Float32Array): Float32Array {
  const out = filtfilt(samples, [butterworth('highpass', 100, SYNC_RATE), butterworth('lowpass', 3500, SYNC_RATE)])
  const fade = Math.min(Math.round(0.25 * SYNC_RATE), Math.floor(out.length / 2))
  for (let i = 0; i < fade; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade)
    out[i]! *= g
    out[out.length - 1 - i]! *= g
  }
  return out
}

/** An in-place radix-2 FFT (`re`, `im` a power of two long); `inverse` divides by the length. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    for (let start = 0; start < n; start += size) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < size / 2; k++) {
        const a = start + k
        const b = a + size / 2
        const tr = re[b]! * cr - im[b]! * ci
        const ti = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - tr
        im[b] = im[a]! - ti
        re[a] = re[a]! + tr
        im[a] = im[a]! + ti
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) {
    re[i] = re[i]! / n
    im[i] = im[i]! / n
  }
}

export interface SyncMatch {
  /** Where the take's start is in the song, in seconds (negative: the take starts before the song). */
  offset: number
  /** How far the match stands out: standard deviations above the average position. */
  score: number
  /** The match against the best other match more than 0.25 s away (1: just as good). */
  lead: number
  /** The best other match's offset, when it comes close (a repeated chorus, say). */
  alternative: number | null
  confidence: 'sure' | 'unsure' | 'none'
}

/**
 * Where `take` (mono at SYNC_RATE, through syncSound) lines up with `song`. Positions where they
 * overlap by less than MIN_OVERLAP seconds aren't considered.
 */
export function findSync(song: Float32Array, take: Float32Array): SyncMatch {
  const step = 1 / SYNC_RATE
  const none: SyncMatch = { offset: 0, score: 0, lead: 1, alternative: null, confidence: 'none' }
  if (song.length < 2 || take.length < 2) return none
  let n = 1
  while (n < song.length + take.length) n <<= 1
  const ar = new Float64Array(n)
  const ai = new Float64Array(n)
  const br = new Float64Array(n)
  const bi = new Float64Array(n)
  ar.set(song)
  br.set(take)
  fft(ar, ai)
  fft(br, bi)
  // song × conjugate(take), each frequency scaled towards equal strength; lag L (the take starting L samples into the song) lands at index L mod n.
  let biggest = 0
  for (let i = 0; i < n; i++) {
    const r = ar[i]! * br[i]! + ai[i]! * bi[i]!
    const im = ai[i]! * br[i]! - ar[i]! * bi[i]!
    ar[i] = r
    ai[i] = im
    biggest = Math.max(biggest, Math.hypot(r, im))
  }
  const floor = biggest * 1e-9
  for (let i = 0; i < n; i++) {
    const w = Math.pow(Math.hypot(ar[i]!, ai[i]!) + floor, 1 - BETA)
    ar[i] = ar[i]! / w
    ai[i] = ai[i]! / w
  }
  fft(ar, ai, true)
  const minOverlap = Math.min(Math.round(MIN_OVERLAP * SYNC_RATE), song.length, take.length)
  const from = -(take.length - minOverlap)
  const to = song.length - minOverlap
  const at = (lag: number) => ar[(lag + n) % n]!
  let best = from
  let sum = 0
  let squares = 0
  let count = 0
  for (let lag = from; lag <= to; lag++) {
    const v = at(lag)
    if (v > at(best)) best = lag
    sum += v
    squares += v * v
    count++
  }
  if (count < 3) return none
  const mean = sum / count
  const spread = Math.sqrt(Math.max(1e-30, squares / count - mean * mean))
  const peak = at(best)
  const score = (peak - mean) / spread
  // The best other match, away from this one (echoes within 0.1 s are the same match).
  const away = Math.round(0.1 * SYNC_RATE)
  let other: number | null = null
  for (let lag = from; lag <= to; lag++) if (Math.abs(lag - best) > away && (other === null || at(lag) > at(other))) other = lag
  const lead = other !== null && at(other) - mean > 0 ? (peak - mean) / (at(other) - mean) : Infinity
  // Between samples: a parabola through the peak and its neighbours.
  let fraction = 0
  if (best > from && best < to) {
    const a = at(best - 1)
    const c = at(best + 1)
    const d = a - 2 * peak + c
    if (d < 0) fraction = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d))
  }
  const confidence: SyncMatch['confidence'] = score >= SURE_SCORE && lead >= SURE_LEAD ? 'sure' : score >= 8 ? 'unsure' : 'none'
  return { offset: (best + fraction) * step, score, lead, alternative: lead < SURE_LEAD && other !== null ? other * step : null, confidence }
}

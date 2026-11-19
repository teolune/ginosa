/**
 * Scoring detected hits against the true ones (W4.1, the detection bench): the F-measure used
 * for drum transcription. A found hit counts when it's within `tolerance` seconds of a true hit
 * that no other found hit has taken; each true hit counts once.
 */

/** ±30 ms for drum hits: tighter than the usual 50 ms, as a 16th at 140 BPM is 107 ms. */
export const HIT_TOLERANCE = 0.03
/** ±50 ms for bass note starts, the usual tolerance for notes (decision 125): sampled basses can sound 20–40 ms after their note. */
export const NOTE_TOLERANCE = 0.05

export interface HitScore {
  /** True hits, found hits, and the found ones that matched a true one. */
  truth: number
  found: number
  matched: number
  /** Matched / found (1 when nothing was found): how many found hits are real. */
  precision: number
  /** Matched / truth (1 when there was nothing to find): how many real hits were found. */
  recall: number
  /** Their harmonic mean, 0–1. */
  f: number
  /** Mean of found − true over the matches, in ms (positive: found late), or null with no matches. */
  meanOffsetMs: number | null
}

function score(truth: number, found: number, matched: number, offsetSum: number): HitScore {
  const precision = found ? matched / found : 1
  const recall = truth ? matched / truth : 1
  const f = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  return { truth, found, matched, precision, recall, f, meanOffsetMs: matched ? (offsetSum / matched) * 1000 : null }
}

/** Times in seconds (or 16ths with tolerance 0 for cubes); neither list needs to be sorted. */
export function scoreHits(found: readonly number[], truth: readonly number[], tolerance = HIT_TOLERANCE): HitScore {
  const f = [...found].sort((a, b) => a - b)
  const t = [...truth].sort((a, b) => a - b)
  // Every true hit's window is the same width, so taking them in order and giving each the
  // earliest found hit still inside its window is a maximum matching (a found hit too early
  // for one true hit is too early for every later one).
  let j = 0
  let matched = 0
  let offsetSum = 0
  for (const time of t) {
    while (j < f.length && f[j]! < time - tolerance - 1e-9) j++
    if (j < f.length && f[j]! <= time + tolerance + 1e-9) {
      matched++
      offsetSum += f[j]! - time
      j++
    }
  }
  return score(t.length, f.length, matched, offsetSum)
}

/** Several songs' scores as one (every hit counts the same, whichever song it's in). */
export function combineScores(scores: readonly HitScore[]): HitScore {
  let truth = 0
  let found = 0
  let matched = 0
  let offsetSum = 0
  for (const s of scores) {
    truth += s.truth
    found += s.found
    matched += s.matched
    offsetSum += s.meanOffsetMs === null ? 0 : (s.meanOffsetMs / 1000) * s.matched
  }
  return score(truth, found, matched, offsetSum)
}

/** A score rounded for reports. */
export function roundScore(s: HitScore): HitScore {
  const r = (v: number) => Math.round(v * 1000) / 1000
  return { ...s, precision: r(s.precision), recall: r(s.recall), f: r(s.f), meanOffsetMs: s.meanOffsetMs === null ? null : Math.round(s.meanOffsetMs * 10) / 10 }
}

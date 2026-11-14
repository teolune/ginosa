import { describe, expect, it } from 'vitest'
import { combineScores, scoreHits } from './hit-score'

describe('Hit scoring (the detection bench)', () => {
  it('scores perfect, empty and missed detections', () => {
    expect(scoreHits([0, 0.5, 1], [0, 0.5, 1])).toMatchObject({ matched: 3, precision: 1, recall: 1, f: 1 })
    expect(scoreHits([], [])).toMatchObject({ precision: 1, recall: 1, f: 1, meanOffsetMs: null })
    expect(scoreHits([], [0, 1])).toMatchObject({ precision: 1, recall: 0, f: 0 })
    expect(scoreHits([0, 1], [])).toMatchObject({ precision: 0, recall: 1, f: 0 })
  })

  it('counts a hit within ±30 ms, each true hit once, and reports how late hits are', () => {
    const s = scoreHits([0.02, 0.5, 0.531, 1.0, 1.01], [0, 0.5, 1])
    // 0.02 matches 0; 0.531 is 31 ms late (an extra); 1.01 is a second hit on 1 (an extra).
    expect(s).toMatchObject({ truth: 3, found: 5, matched: 3 })
    expect(s.precision).toBeCloseTo(0.6)
    expect(s.recall).toBe(1)
    expect(s.f).toBeCloseTo(0.75)
    expect(s.meanOffsetMs).toBeCloseTo(20 / 3)
    // Order doesn't matter.
    expect(scoreHits([1.01, 0.531, 1.0, 0.5, 0.02], [1, 0, 0.5])).toEqual(s)
  })

  it('finds the most matches where windows overlap, unlike nearest-first', () => {
    // Nearest-first would give 0.02 to 0.04 (20 ms) and leave 0 unmatched.
    expect(scoreHits([0.02, 0.065], [0, 0.04]).matched).toBe(2)
    expect(scoreHits([0.025, 0.075], [0, 0.05]).matched).toBe(2)
  })

  it('scores cubes exactly with tolerance 0, and combines songs hit by hit', () => {
    expect(scoreHits([0, 4, 9], [0, 4, 8], 0)).toMatchObject({ matched: 2, f: 2 / 3 })
    const all = combineScores([scoreHits([0, 1], [0, 1]), scoreHits([0.01], [0, 1, 2, 3])])
    expect(all).toMatchObject({ truth: 6, found: 3, matched: 3, precision: 1, recall: 0.5 })
    expect(all.meanOffsetMs).toBeCloseTo(10 / 3)
  })
})

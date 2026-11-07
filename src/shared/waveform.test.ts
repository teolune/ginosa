import { describe, expect, it } from 'vitest'
import { PeakWriter, levelFor, peakRange, readWaveform, WAVEFORM_PEAKS_PER_SECOND, WAVEFORM_SAMPLE_RATE } from './waveform'

/** One second of a 100 Hz sine at half volume, then a second of silence. */
function sound(): Float32Array {
  const out = new Float32Array(WAVEFORM_SAMPLE_RATE * 2)
  for (let i = 0; i < WAVEFORM_SAMPLE_RATE; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * 100 * i) / WAVEFORM_SAMPLE_RATE)
  return out
}

function file(chunk: number): ArrayBuffer {
  const writer = new PeakWriter()
  const samples = sound()
  for (let at = 0; at < samples.length; at += chunk) writer.add(samples.subarray(at, at + chunk))
  const bytes = writer.finish()
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('waveform peaks (zoomable)', () => {
  it('keeps a peak for every 10 samples, whatever pieces the sound arrives in', () => {
    const one = file(WAVEFORM_SAMPLE_RATE * 2)
    expect(new Uint8Array(file(7))).toEqual(new Uint8Array(one))
    const view = new DataView(one)
    expect(view.getUint32(0, true)).toBe(WAVEFORM_PEAKS_PER_SECOND)
    expect(view.getUint32(4, true)).toBe(2 * WAVEFORM_PEAKS_PER_SECOND)
  })

  it('makes coarser levels, a quarter each, down to about one peak a second', () => {
    const wave = readWaveform(file(4096))
    expect(wave.duration).toBe(2)
    expect(wave.levels.map((l) => l.rate)).toEqual([4800, 1200, 300, 75, 18.75, 4.6875, 1.171875])
    // Every level agrees about the whole of each second.
    for (const level of wave.levels) {
      const [lo, hi] = peakRange(level, 0, 1)!
      expect(lo).toBeCloseTo(-0.5, 3)
      expect(hi).toBeCloseTo(0.5, 3)
      // The silent second, wherever a level's peaks are short enough to tell.
      if (level.rate >= 4) expect(peakRange(level, 1.25, 1.8)).toEqual([0, 0])
    }
  })

  it('shows the shape of the sound up close: a tenth of a cycle near the crest stays near the crest', () => {
    const fine = readWaveform(file(4096)).levels[0]!
    // 100 Hz: the crest is at 2.5 ms. 10 samples there are all between 0.49 and 0.5.
    const [lo, hi] = peakRange(fine, 0.0025, 0.0025 + 1 / WAVEFORM_PEAKS_PER_SECOND)!
    expect(lo).toBeGreaterThan(0.49)
    expect(hi).toBeCloseTo(0.5, 3)
    // Where it crosses zero (5 ms) it's steepest: 10 samples span 0.065 of the 1.0 from trough to crest.
    const [a, b] = peakRange(fine, 0.005, 0.005 + 1 / WAVEFORM_PEAKS_PER_SECOND)!
    expect(b - a).toBeGreaterThan(0.05)
    expect(b - a).toBeLessThan(0.08)
    expect(peakRange(fine, 3, 4)).toBeNull()
  })

  it('picks the coarsest level that still has a peak per column', () => {
    const wave = readWaveform(file(4096))
    expect(levelFor(wave, 1 / 4800).rate).toBe(4800)
    expect(levelFor(wave, 1 / 2400).rate).toBe(4800)
    expect(levelFor(wave, 1 / 1000).rate).toBe(1200)
    expect(levelFor(wave, 0.02).rate).toBe(75)
    expect(levelFor(wave, 10).rate).toBe(1.171875)
    // Closer than the finest level: the finest.
    expect(levelFor(wave, 1e-5).rate).toBe(4800)
  })
})

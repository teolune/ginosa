import { describe, expect, it } from 'vitest'
import {
  AUDIO_SAMPLE_RATES,
  FRAME_RATES,
  MAX_EXACT_SECONDS,
  TICKS_PER_SECOND,
  formatTimecode,
  frameToTicks,
  isExactFrameRate,
  nearestStandardRate,
  samplesToTicks,
  secondsToTicks,
  ticksPerFrame,
  ticksToFrame,
  ticksToSamples
} from './time'

describe('tick rate', () => {
  it('divides evenly by every standard frame rate', () => {
    for (const [name, rate] of Object.entries(FRAME_RATES)) {
      expect(isExactFrameRate(rate), name).toBe(true)
    }
  })

  it('divides evenly by every supported audio sample rate', () => {
    for (const sampleRate of AUDIO_SAMPLE_RATES) {
      expect(Number.isInteger(TICKS_PER_SECOND / sampleRate), String(sampleRate)).toBe(true)
    }
  })

  it('holds timelines of at least nine hours exactly', () => {
    expect(MAX_EXACT_SECONDS).toBeGreaterThanOrEqual(9 * 3600)
  })

  it('has the known 23.976 frame length', () => {
    expect(ticksPerFrame(FRAME_RATES['23.976'])).toBe(10_594_584_000)
  })
})

describe('frame conversion', () => {
  it('round-trips frame numbers at every rate', () => {
    for (const rate of Object.values(FRAME_RATES)) {
      for (const frame of [0, 1, 23, 24, 1799, 86_399, 500_000]) {
        expect(ticksToFrame(frameToTicks(frame, rate), rate)).toBe(frame)
      }
    }
  })

  it('floors a time inside a frame to that frame', () => {
    const rate = FRAME_RATES['24']
    const inside = frameToTicks(10, rate) + ticksPerFrame(rate) / 2
    expect(ticksToFrame(inside, rate)).toBe(10)
    expect(ticksToFrame(inside, rate, 'round')).toBe(11)
  })

  it('maps one second of 48 kHz audio to exactly one second', () => {
    expect(samplesToTicks(48_000, 48_000)).toBe(TICKS_PER_SECOND)
    expect(ticksToSamples(secondsToTicks(2.5), 48_000)).toBe(120_000)
  })
})

describe('timecode', () => {
  it('formats 24 fps timecode', () => {
    const rate = FRAME_RATES['24']
    expect(formatTimecode(0, rate)).toBe('00:00:00:00')
    expect(formatTimecode(frameToTicks(23, rate), rate)).toBe('00:00:00:23')
    expect(formatTimecode(frameToTicks(24, rate), rate)).toBe('00:00:01:00')
    expect(formatTimecode(frameToTicks(24 * 3661 + 5, rate), rate)).toBe('01:01:01:05')
  })

  it('counts 23.976 at a nominal 24 frames per second', () => {
    const rate = FRAME_RATES['23.976']
    expect(formatTimecode(frameToTicks(24, rate), rate)).toBe('00:00:01:00')
  })
})

describe('nearestStandardRate', () => {
  it('snaps measured rates from real files', () => {
    expect(nearestStandardRate(23.976023)).toEqual(FRAME_RATES['23.976'])
    expect(nearestStandardRate(29.97003)).toEqual(FRAME_RATES['29.97'])
    expect(nearestStandardRate(25.0001)).toEqual(FRAME_RATES['25'])
  })

  it('rejects rates far from any standard', () => {
    expect(nearestStandardRate(17.3)).toBeNull()
  })
})

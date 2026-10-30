/**
 * Timeline time. All engine times are integer ticks at Premiere's tick rate,
 * which divides evenly by every common frame rate and audio sample rate.
 * A JS number holds ticks exactly for timelines up to about 9.8 hours.
 */

export const TICKS_PER_SECOND = 254_016_000_000

/** Integer number of ticks. */
export type Ticks = number

/** A frame rate as an exact fraction, e.g. 24000/1001 for 23.976. */
export interface FrameRate {
  num: number
  den: number
}

export const FRAME_RATES = {
  '23.976': { num: 24000, den: 1001 },
  '24': { num: 24, den: 1 },
  '25': { num: 25, den: 1 },
  '29.97': { num: 30000, den: 1001 },
  '30': { num: 30, den: 1 },
  '50': { num: 50, den: 1 },
  '59.94': { num: 60000, den: 1001 },
  '60': { num: 60, den: 1 }
} as const satisfies Record<string, FrameRate>

export type FrameRateName = keyof typeof FRAME_RATES

export const AUDIO_SAMPLE_RATES = [44_100, 48_000, 96_000] as const

/** Longest timeline whose tick count stays an exact integer in a JS number. */
export const MAX_EXACT_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / TICKS_PER_SECOND)

export function frameRateValue(rate: FrameRate): number {
  return rate.num / rate.den
}

/** Ticks in one frame. Exact (an integer) for every rate in FRAME_RATES. */
export function ticksPerFrame(rate: FrameRate): Ticks {
  return (TICKS_PER_SECOND * rate.den) / rate.num
}

export function isExactFrameRate(rate: FrameRate): boolean {
  return Number.isInteger(ticksPerFrame(rate))
}

export function frameToTicks(frame: number, rate: FrameRate): Ticks {
  return frame * ticksPerFrame(rate)
}

/** Frame containing `ticks` (floor), or the nearest frame boundary with 'round'. */
export function ticksToFrame(ticks: Ticks, rate: FrameRate, mode: 'floor' | 'round' = 'floor'): number {
  const exact = ticks / ticksPerFrame(rate)
  return mode === 'floor' ? Math.floor(exact + 1e-9) : Math.round(exact)
}

export function secondsToTicks(seconds: number): Ticks {
  return Math.round(seconds * TICKS_PER_SECOND)
}

export function ticksToSeconds(ticks: Ticks): number {
  return ticks / TICKS_PER_SECOND
}

export function samplesToTicks(samples: number, sampleRate: number): Ticks {
  return (samples * TICKS_PER_SECOND) / sampleRate
}

export function ticksToSamples(ticks: Ticks, sampleRate: number): number {
  return Math.floor((ticks * sampleRate) / TICKS_PER_SECOND + 1e-9)
}

/** Nominal frames per second used for timecode counting (24 for 23.976, 30 for 29.97). */
export function timecodeBase(rate: FrameRate): number {
  return Math.round(frameRateValue(rate))
}

/**
 * Non-drop-frame timecode HH:MM:SS:FF, counted at the nominal rate (as Premiere does
 * for 23.976 and for 29.97 NDF). Drop-frame display arrives with sequence settings in M3.
 */
export function formatTimecode(ticks: Ticks, rate: FrameRate): string {
  const base = timecodeBase(rate)
  const totalFrames = Math.max(0, ticksToFrame(ticks, rate))
  const frames = totalFrames % base
  const totalSeconds = Math.floor(totalFrames / base)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`
}

/** Snaps a measured frame rate (e.g. 23.9760001 from a file) to the closest standard rate. */
export function nearestStandardRate(measured: number, tolerance = 0.01): FrameRate | null {
  let best: FrameRate | null = null
  let bestError = Infinity
  for (const rate of Object.values(FRAME_RATES)) {
    const error = Math.abs(frameRateValue(rate) - measured)
    if (error < bestError) {
      best = rate
      bestError = error
    }
  }
  return best && bestError <= tolerance * frameRateValue(best) ? best : null
}

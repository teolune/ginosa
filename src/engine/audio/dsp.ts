/**
 * Small signal-processing helpers for audio analysis. Analysis is offline, so filters
 * run forwards and then backwards (zero phase): a band's energy lines up exactly with
 * the sound, with no filter delay.
 */

export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** A 2nd-order Butterworth low- or high-pass (RBJ cookbook, Q = 1/√2). Run forwards and backwards it becomes a 4th-order Linkwitz–Riley. */
export function butterworth(kind: 'lowpass' | 'highpass', frequency: number, sampleRate: number): Biquad {
  const w = (2 * Math.PI * Math.min(frequency, sampleRate * 0.49)) / sampleRate
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  const b1 = kind === 'lowpass' ? 1 - cos : -(1 + cos)
  const b0 = kind === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 }
}

/** Runs a biquad over `x` in place (transposed direct form II), forwards or backwards. */
export function filterInPlace(x: Float32Array, f: Biquad, backwards = false): void {
  let z1 = 0
  let z2 = 0
  const n = x.length
  for (let k = 0; k < n; k++) {
    const i = backwards ? n - 1 - k : k
    const input = x[i]!
    const out = f.b0 * input + z1
    z1 = f.b1 * input - f.a1 * out + z2
    z2 = f.b2 * input - f.a2 * out
    x[i] = out
  }
}

/** Zero-phase filtering: every filter forwards, then every filter backwards, on a copy. */
export function filtfilt(x: Float32Array, filters: Biquad[]): Float32Array {
  const y = new Float32Array(x)
  for (const f of filters) filterInPlace(y, f, false)
  for (const f of filters) filterInPlace(y, f, true)
  return y
}

/** Sums of squares and peaks per block of `size` samples. */
export function blockStats(x: Float32Array, size: number): { power: Float64Array; peak: Float32Array } {
  const blocks = Math.ceil(x.length / size)
  const power = new Float64Array(blocks)
  const peak = new Float32Array(blocks)
  for (let b = 0; b < blocks; b++) {
    let sum = 0
    let max = 0
    const end = Math.min(x.length, (b + 1) * size)
    for (let i = b * size; i < end; i++) {
      const v = x[i]!
      sum += v * v
      const a = v < 0 ? -v : v
      if (a > max) max = a
    }
    power[b] = sum
    peak[b] = max
  }
  return { power, peak }
}

/**
 * RMS centred on each frame: frame i sits at block 2i (blocks are half a frame), and its
 * window spans `half` blocks each side.
 */
export function centredRms(power: Float64Array, blockSize: number, frames: number, half: number): Float32Array {
  const out = new Float32Array(frames)
  const prefix = new Float64Array(power.length + 1)
  for (let b = 0; b < power.length; b++) prefix[b + 1] = prefix[b]! + power[b]!
  for (let i = 0; i < frames; i++) {
    const lo = Math.max(0, 2 * i - half)
    const hi = Math.min(power.length, 2 * i + half)
    const n = (hi - lo) * blockSize
    out[i] = n > 0 ? Math.sqrt((prefix[hi]! - prefix[lo]!) / n) : 0
  }
  return out
}

/** Rise in dB over `lag` frames, half-wave rectified, with a floor `range` dB below the loudest value. */
export function riseDb(env: Float32Array, lag: number, range = 60): Float32Array {
  let max = 0
  for (const v of env) if (v > max) max = v
  const floor = max > 0 ? max * Math.pow(10, -range / 20) : 1e-9
  const out = new Float32Array(env.length)
  for (let i = lag; i < env.length; i++) {
    const rise = 20 * Math.log10((env[i]! + floor) / (env[i - lag]! + floor))
    out[i] = rise > 0 ? rise : 0
  }
  return out
}

export function maxOf(x: ArrayLike<number>): number {
  let max = 0
  for (let i = 0; i < x.length; i++) if (x[i]! > max) max = x[i]!
  return max
}

/** Linear interpolation into a signal sampled at whole indexes (0 outside it). */
export function sampleAt(x: ArrayLike<number>, position: number): number {
  if (position < 0 || position > x.length - 1) return 0
  const i = Math.floor(position)
  const f = position - i
  return f === 0 ? x[i]! : x[i]! * (1 - f) + x[i + 1]! * f
}

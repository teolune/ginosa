/**
 * Basic Correction's white balance and tone ranges (version 2, 4 Nov 2026), shared by the
 * reference, the manifest's migration and (as constants) shader.wgsl.
 *
 * Temperature moves the white point along the colour of real light: −100 to +100 is a full
 * blue (CTB) to a full orange (CTO) gel, ±131 mireds from daylight (6504 K): about 3,500 K at
 * +100 and 44,000 K at −100. The gains are log2 polynomials in t = temperature / 100, fitted
 * to the Planckian locus (blackbody spectra through the CIE 1931 observer, as linear sRGB
 * relative to 6504 K, grey's luminance kept) to within 0.0006 stops.
 *
 * Tint is ±1 stop of green against red and blue at ±100 (a full minus-green / plus-green gel).
 */

export const TEMPERATURE_LOG2_GAINS = {
  r: [0.62554, -0.01658, -0.05028, 0.01949],
  g: [-0.06357, -0.07285, 0.00165, 0.00628],
  b: [-1.20192, -0.14377, 0.03516, -0.02803]
} as const

/** Stops of green against red and blue at Tint ±100. */
export const TINT_STOPS = 1

/** Highlights and Shadows at ±100: OKLab lightness moved by up to this much at 2/3 and 1/3. */
export const HIGHLIGHTS_SHADOWS_REACH = 0.296
/** The largest single bump that keeps the tone curve rising (1 / 6.75 is the limit). */
export const BUMP_LIMIT = 0.148
/** Whites and Blacks at ±100: white or black moved by this much lightness. */
export const WHITES_BLACKS_REACH = 0.25

const poly = (c: readonly number[], t: number) => t * (c[0]! + t * (c[1]! + t * (c[2]! + t * c[3]!)))

/** Log2 gains on linear R, G, B for a temperature (−100 to 100), before grey's luminance is restored. */
export function temperatureLog2(temperature: number): [number, number, number] {
  const t = temperature / 100
  return [poly(TEMPERATURE_LOG2_GAINS.r, t), poly(TEMPERATURE_LOG2_GAINS.g, t), poly(TEMPERATURE_LOG2_GAINS.b, t)]
}

/** Red against blue, in stops, for a temperature. Rises steadily from −1.57 to +1.92. */
export function warmthStops(temperature: number): number {
  const [r, , b] = temperatureLog2(temperature)
  return r - b
}

/**
 * Version 1 values in version 2 units, so saved projects look the same. Version 1 was
 * gentler: Temperature ±100 was ±0.3 stops on red and blue (0.6 stops apart), Tint ±0.45
 * stops of green, Highlights/Shadows ±0.12 and Whites/Blacks ±0.1 of lightness.
 */
export function migrateFromV1(param: string, value: number): number {
  switch (param) {
    case 'temperature': {
      // Same red-to-blue balance. (Version 1 moved red and blue equally, real light moves blue
      // more and green a little, so the warmth is the same and the hue a touch more golden.)
      const target = (0.6 * value) / 100
      let lo = -100
      let hi = 100
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2
        if (warmthStops(mid) < target) lo = mid
        else hi = mid
      }
      return Math.round(((lo + hi) / 2) * 1000) / 1000
    }
    case 'tint':
      return (value * 0.45) / TINT_STOPS
    case 'highlights':
    case 'shadows':
      return (value * 0.12) / HIGHLIGHTS_SHADOWS_REACH
    case 'whites':
    case 'blacks':
      return (value * 0.1) / WHITES_BLACKS_REACH
    default:
      return value
  }
}

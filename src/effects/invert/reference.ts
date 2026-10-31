import { fromOklab, toDisplay, toLinear, toOklab } from '../../engine/effects/colour-spaces'

/** The CPU version of shader.wgsl, for tests: display R'G'B' (0–1) in, display out. */
export function invertReference(rgb: readonly [number, number, number], params: { amount: number; channel: string; space: string }): [number, number, number] {
  const c = rgb.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number]
  let out: [number, number, number] = [...c]
  const masks: Record<string, [number, number, number]> = { rgb: [1, 1, 1], red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1] }
  const mask = masks[params.channel]
  if (mask) {
    if (params.space === 'linear') out = toDisplay(toLinear(c).map((v, i) => (mask[i] ? 1 - v : v)) as [number, number, number])
    else out = c.map((v, i) => (mask[i] ? 1 - v : v)) as [number, number, number]
  } else if (params.channel === 'hue') {
    const [h, s, l] = rgbToHsl(c)
    out = hslToRgb([h + 0.5, s, l])
  } else {
    const lab = toOklab(toLinear(c))
    const flipped: [number, number, number] = params.channel === 'luminance' ? [1 - lab[0], lab[1], lab[2]] : [lab[0], -lab[1], -lab[2]]
    out = toDisplay(fromOklab(flipped).map((v) => Math.min(1, Math.max(0, v))) as [number, number, number])
  }
  const t = params.amount / 100
  return c.map((v, i) => v + (out[i]! - v) * t) as [number, number, number]
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const hi = Math.max(r, g, b)
  const lo = Math.min(r, g, b)
  const l = (hi + lo) / 2
  const d = hi - lo
  if (d <= 1e-6) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (hi === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (hi === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToRgb([h0, s, l]: [number, number, number]): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const h = (h0 - Math.floor(h0)) * 6
  const x = c * (1 - Math.abs((h % 2) - 1))
  const rgb: [number, number, number] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  return rgb.map((v) => v + l - c / 2) as [number, number, number]
}

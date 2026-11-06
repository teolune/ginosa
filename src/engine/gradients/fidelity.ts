import { GRADIENT_METHODS, type GradientMethod } from './gradient'

/**
 * The Photoshop fidelity check (M13). You run docs/m13/grey-ramp.png (one column per level,
 * 0–255) or docs/m13/colour-chart.png (16 patches) through a Gradient Map in Photoshop and
 * export PNGs named after what you used, into Reference Materials/Gradients:
 *
 *   "<gradient name> - <Method>.png"               e.g. "Kiwi - Classic.png"
 *   "<gradient name> - <Method> - <Smoothness>%.png" e.g. "Kiwi - Classic - 0%.png"
 *   … with " - chart" for the colour chart          e.g. "Kiwi - Classic - chart.png"
 *
 * The check finds the gradient in your .grd files there, draws the same thing and compares.
 */

export interface RenderName {
  gradient: string
  method: GradientMethod
  /** 0–1, when the file name gives one (otherwise the gradient's own). */
  smoothness: number | null
  input: 'ramp' | 'chart'
}

export function parseRenderName(file: string): RenderName | null {
  const base = (file.split('/').pop() ?? file).replace(/\.png$/i, '')
  const parts = base.split(' - ').map((p) => p.trim())
  const at = parts.findIndex((p) => GRADIENT_METHODS.some((m) => m.label.toLowerCase() === p.toLowerCase()))
  if (at < 1) return null
  const method = GRADIENT_METHODS.find((m) => m.label.toLowerCase() === parts[at]!.toLowerCase())!.id
  let smoothness: number | null = null
  let input: RenderName['input'] = 'ramp'
  for (const p of parts.slice(at + 1)) {
    const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(p)
    if (m) smoothness = Math.min(1, Number(m[1]) / 100)
    else if (p.toLowerCase() === 'chart') input = 'chart'
    else return null
  }
  return { gradient: parts.slice(0, at).join(' - '), method, smoothness, input }
}

/** The chart's 16 patches (0–255), four to a row, 64 px each. */
export const CHART: ReadonlyArray<[number, number, number]> = [
  [230, 40, 30], [30, 200, 60], [40, 70, 220], [240, 240, 240],
  [20, 20, 20], [128, 128, 128], [200, 150, 60], [90, 30, 120],
  [224, 172, 140], [5, 5, 8], [255, 255, 255], [0, 0, 0],
  [60, 180, 200], [250, 120, 180], [10, 20, 60], [250, 240, 150]
]

export const RAMP_SIZE = { width: 256, height: 64 }
export const CHART_SIZE = { width: 256, height: 256 }

/** Where to read each sample in a render, and the colour that went in there (0–255). */
export function samplePoints(input: RenderName['input']): Array<{ x: number; y: number; colour: [number, number, number] }> {
  if (input === 'ramp') return Array.from({ length: 256 }, (_, x) => ({ x, y: 32, colour: [x, x, x] }))
  return CHART.map((colour, i) => ({ x: (i % 4) * 64 + 32, y: Math.floor(i / 4) * 64 + 32, colour: [...colour] }))
}

export interface Comparison {
  /** Mean absolute difference, in levels (0–255), over every sample and channel. */
  mean: number
  max: number
  worst: string
}

export function compareLevels(expected: ReadonlyArray<readonly number[]>, got: ReadonlyArray<readonly number[]>, label: (i: number) => string): Comparison {
  let sum = 0
  let n = 0
  let max = 0
  let worst = ''
  expected.forEach((e, i) => {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(e[k]! - got[i]![k]!)
      sum += d
      n++
      if (d > max) (max = d), (worst = `${label(i)}: Photoshop ${got[i]!.slice(0, 3).join(', ')}, ginosa ${e.slice(0, 3).join(', ')}`)
    }
  })
  return { mean: n ? sum / n : 0, max, worst }
}

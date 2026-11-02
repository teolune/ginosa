import { curveTable, tableValue } from '../../engine/effects/curves'

/** The CPU version of shader.wgsl, for tests: display R'G'B' (0–1) in, display out. Reads the same baked tables. */
export function curvesReference(rgb: readonly [number, number, number], params: { master: string; red: string; green: string; blue: string }): [number, number, number] {
  const master = curveTable(params.master)
  const channels = [curveTable(params.red), curveTable(params.green), curveTable(params.blue)]
  return rgb.map((v, i) => tableValue(master, tableValue(channels[i]!, v))) as [number, number, number]
}

import { sampleCube, type CubeLut } from './cube'
import { effectById } from '../../effects/registry'
import type { Sequence } from '../project/model'

/**
 * Look LUTs (decision 77): a creative .cube applied as an effect, on display values (as
 * Premiere's Lumetri Creative Look and Resolve apply look LUTs), with a Strength.
 *
 * On the GPU a look LUT is always a 3D texture over 0–1: a 1D LUT, or one with another
 * domain, is resampled into one first (`unitCube`), so the shader needs one kind only.
 */

/** Lattice size for 1D LUTs turned into cubes (a 1D curve is exact at the lattice points, straight between). */
export const ONE_D_CUBE_SIZE = 65

/** The LUT as an N³ cube over 0–1 on every axis, red fastest (the .cube order). */
export function unitCube(lut: CubeLut): { size: number; data: Float32Array } {
  const unitDomain = [0, 1, 2].every((i) => lut.domainMin[i] === 0 && lut.domainMax[i] === 1)
  if (lut.kind === '3d' && unitDomain) return { size: lut.size, data: lut.data }
  const n = lut.kind === '3d' ? lut.size : ONE_D_CUBE_SIZE
  const data = new Float32Array(n * n * n * 3)
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) data.set(sampleCube(lut, [r / (n - 1), g / (n - 1), b / (n - 1)]), ((b * n + g) * n + r) * 3)
  return { size: n, data }
}

/** Trilinear lookup in a unit cube (what the GPU's filtering does). */
export function cubeAt(cube: { size: number; data: Float32Array }, rgb: readonly [number, number, number]): [number, number, number] {
  return sampleCube({ kind: '3d', size: cube.size, data: cube.data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] } as CubeLut, [rgb[0], rgb[1], rgb[2]])
}

/**
 * The Look LUT effect on one colour (display values): the LUT's change, scaled by Strength
 * (100% is the LUT itself; above 100% goes further, below fades it). Values past white keep
 * their distance above it, so super-whites survive.
 */
export function lookReference(cube: { size: number; data: Float32Array } | null, rgb: readonly [number, number, number], strength: number): [number, number, number] {
  if (!cube) return [rgb[0], rgb[1], rgb[2]]
  const c = rgb.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number]
  const l = cubeAt(cube, c)
  return [0, 1, 2].map((i) => rgb[i]! + (l[i]! - c[i]!) * (strength / 100)) as [number, number, number]
}

/** Every look LUT file the sequence uses (values and keyframes), so export and rendering can load them first. */
export function lookLutFiles(sequence: Sequence): string[] {
  const files = new Set<string>()
  for (const clip of sequence.clips)
    for (const effect of clip.effects) {
      const manifest = effectById(effect.effectId)
      if (!manifest || !effect.enabled) continue
      for (const spec of manifest.params) {
        if (spec.type !== 'lut') continue
        const value = effect.params[spec.id]
        if (typeof value === 'string' && value) files.add(value)
        for (const k of effect.keyframes[spec.id] ?? []) if (typeof k.value === 'string' && k.value) files.add(k.value)
      }
    }
  return [...files]
}

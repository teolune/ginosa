import type { EffectManifest } from '../../engine/effects/types'
import shader from './shader.wgsl?raw'

/**
 * Look LUT (decision 77): a creative .cube look on any clip or adjustment layer, with a
 * Strength, as Lumetri's Creative Look. It works on display values (Rec.709, gamma-encoded),
 * which is what look LUTs are made for; put it after any log conversion (that's the media's
 * Input LUT or colour setting). The LUT is copied into the project's luts folder, so the
 * project carries it. Maths in engine/colour/look-lut.ts.
 */
const lookLut: EffectManifest = {
  id: 'look-lut',
  name: 'Look LUT',
  category: 'Colour & Light',
  description: 'Applies a .cube look (from Premiere, Resolve, a LUT pack…) with a Strength slider.',
  version: 1,
  colourSpace: 'display',
  time: 'per-frame',
  params: [
    { id: 'lut', label: 'LUT', type: 'lut', default: '', help: 'A .cube file (3D or 1D). Choosing one copies it into the project’s luts folder.' },
    { id: 'strength', label: 'Strength', type: 'number', default: 100, min: 0, max: 200, unit: '%', decimals: 1, help: '100% is the LUT as made; less fades it towards the original, more pushes it further.' }
  ],
  shader
}

export default lookLut

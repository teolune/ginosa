import { compareLevels, parseRenderName, samplePoints, CHART_SIZE, RAMP_SIZE } from '@engine/gradients/fidelity'
import { readGrd } from '@engine/gradients/grd'
import { formatGradient, gradientNotes, starterGradients, type Gradient } from '@engine/gradients/gradient'
import { gradientMapReference, type GradientMapParams } from '../../../effects/gradient-map/reference'
import { effectById } from '../../../effects/registry'

/**
 * M13's done-when: your Photoshop renders of the grey ramp (or colour chart) through Gradient
 * Map, in Reference Materials/Gradients, against ginosa's Gradient Map with the same gradient
 * (from your .grd files there), method and smoothness. Target: under 1 level on average for
 * gradients with RGB, HSB, Lab or grayscale stops. See engine/gradients/fidelity.ts for names.
 */
export async function runGradientFidelity() {
  const { libraries, renders } = await window.ginosa.snapshot.referenceGradients()
  const gradients = new Map<string, { gradient: Gradient; file: string }>()
  const problems: string[] = []
  for (const lib of libraries) {
    try {
      for (const e of readGrd(lib.bytes).entries) if (!gradients.has(e.gradient.name)) gradients.set(e.gradient.name, { gradient: e.gradient, file: lib.name })
    } catch (error) {
      problems.push(`${lib.name} couldn't be read: ${(error as Error).message}`)
    }
  }
  const results: Array<Record<string, unknown>> = []
  for (const render of renders) results.push(await judge(render, gradients))
  // The check checking itself: ginosa's own ramp through Copper, saved as a PNG and judged
  // like a Photoshop render, must come out exact.
  const copper = starterGradients()[4]!
  const own = await ownRender(copper, 'perceptual')
  const selfCheck = await judge({ name: 'Copper - Perceptual.png', bytes: own }, new Map([['Copper', { gradient: copper, file: '(built in)' }]]))
  const judged = results.filter((r) => r['pass'] === true || r['pass'] === false)
  return {
    verdict: selfCheck['meanLevels'] !== 0 ? 'fail' : renders.length === 0 ? 'waiting' : judged.length === 0 ? 'nothing to judge' : judged.every((r) => r['pass']) ? 'pass' : 'fail',
    advice: renders.length === 0 ? 'Put Photoshop renders of docs/m13/grey-ramp.png in Reference Materials/Gradients (see docs/M13-try-this.md)' : undefined,
    selfCheck,
    libraries: libraries.map((l) => l.name),
    gradients: gradients.size,
    problems,
    results
  }
}

function defaults(): GradientMapParams {
  return Object.fromEntries(effectById('gradient-map')!.params.map((p) => [p.id, p.default])) as unknown as GradientMapParams
}

/** ginosa's Gradient Map of the grey ramp, as PNG bytes. */
async function ownRender(gradient: Gradient, method: GradientMapParams['method']): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(RAMP_SIZE.width, RAMP_SIZE.height)
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })!
  const image = ctx.createImageData(RAMP_SIZE.width, RAMP_SIZE.height)
  const params = { ...defaults(), gradient: formatGradient(gradient), method }
  for (let x = 0; x < 256; x++) {
    const c = gradientMapReference([x / 255, x / 255, x / 255], params).map((v) => Math.round(v * 255))
    for (let y = 0; y < RAMP_SIZE.height; y++) image.data.set([c[0]!, c[1]!, c[2]!, 255], (y * RAMP_SIZE.width + x) * 4)
  }
  ctx.putImageData(image, 0, 0)
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
}

async function judge(render: { name: string; bytes: Uint8Array }, gradients: Map<string, { gradient: Gradient; file: string }>): Promise<Record<string, unknown>> {
  {
    const name = parseRenderName(render.name)
    if (!name) return { file: render.name, skipped: 'name not understood: use "<gradient> - <Classic|Perceptual|Linear|Smooth>[ - <n>%][ - chart].png"' }
    const found = gradients.get(name.gradient)
    if (!found) return { file: render.name, skipped: `no gradient called "${name.gradient}" in the .grd files next to it` }
    const gradient = name.smoothness !== null && found.gradient.kind === 'solid' ? { ...found.gradient, smoothness: name.smoothness } : found.gradient
    const bitmap = await createImageBitmap(new Blob([render.bytes as BlobPart], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    const size = name.input === 'ramp' ? RAMP_SIZE : CHART_SIZE
    if (bitmap.width !== size.width || bitmap.height !== size.height) return { file: render.name, skipped: `it's ${bitmap.width} × ${bitmap.height}; export at 100% (${size.width} × ${size.height})` }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })!
    ctx.drawImage(bitmap, 0, 0)
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    const points = samplePoints(name.input)
    const params = { ...defaults(), gradient: formatGradient(gradient), method: name.method }
    const expected = points.map((p) => gradientMapReference(p.colour.map((v) => v / 255) as [number, number, number], params).map((v) => Math.round(v * 255)))
    const got = points.map((p) => Array.from(pixels.subarray((p.y * bitmap.width + p.x) * 4, (p.y * bitmap.width + p.x) * 4 + 3)))
    const comparison = compareLevels(expected, got, (i) => (name.input === 'ramp' ? `level ${i}` : `patch ${i + 1}`))
    const notes = gradientNotes(gradient)
    return {
      file: render.name,
      gradient: name.gradient,
      from: found.file,
      method: name.method,
      smoothness: gradient.kind === 'solid' ? Math.round(gradient.smoothness * 100) : null,
      meanLevels: Math.round(comparison.mean * 100) / 100,
      maxLevels: comparison.max,
      worst: comparison.worst,
      exact: notes.length === 0,
      notes,
      pass: notes.length > 0 ? null : comparison.mean < 1
    }
  }
}

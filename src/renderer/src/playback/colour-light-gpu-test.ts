import type { ParamValue } from '@engine/effects/types'
import { BASIC_DEFAULTS, basicCorrectionReference, type BasicCorrectionParams } from '../../../effects/basic-correction/reference'
import { curvesReference } from '../../../effects/curves/reference'
import { levelsReference } from '../../../effects/levels/reference'
import { mosaicReference, type RefImage } from '../../../effects/mosaic/reference'
import { effectById } from '../../../effects/registry'
import { IDENTITY_CURVE } from '@engine/effects/curves'
import { getGpu } from '../gpu/shared'
import { Compositor, type CompositeStep, type GpuEffect } from './compositor'

/**
 * M10's effects on the GPU against their CPU references (src/effects/<id>/reference.ts):
 * Basic Correction, Curves and Levels on 16 known colours, Mosaic on a 480 × 270 image of
 * known pixels (small and big cells, centre pixels, soft edges, off), then each effect's
 * time on a 4K frame.
 */

type Rgb = [number, number, number]
const COLOURS: Rgb[] = [
  [230, 40, 30], [30, 200, 60], [40, 70, 220], [240, 240, 240], [20, 20, 20], [128, 128, 128],
  [200, 150, 60], [90, 30, 120], [224, 172, 140], [5, 5, 8], [255, 255, 255], [0, 0, 0],
  [60, 180, 200], [250, 120, 180], [10, 20, 60], [250, 240, 150]
].map((c) => c.map((v) => v / 255) as Rgb)

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exponent = (h >> 10) & 0x1f
  const fraction = h & 0x3ff
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
}

/** The whole (rgba16float) texture read back at once. */
async function readAll(device: GPUDevice, texture: GPUTexture): Promise<(x: number, y: number) => number[]> {
  const row = Math.ceil((texture.width * 8) / 256) * 256
  const buffer = device.createBuffer({ size: row * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [texture.width, texture.height])
  device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const half = new Uint16Array(buffer.getMappedRange().slice(0))
  buffer.destroy()
  return (x, y) => [0, 1, 2, 3].map((i) => halfToFloat(half[(y * row) / 2 + x * 4 + i]!))
}

export async function runColourLightGpuTest() {
  const { device } = await getGpu()
  const compositor = new Compositor(device)
  const checks: Array<{ name: string; error: number; limit: number; where?: string }> = []

  const fx = (id: string, params: Record<string, ParamValue>, mix = 1): GpuEffect => {
    const manifest = effectById(id)!
    const defaults = Object.fromEntries(manifest.params.map((p) => [p.id, p.default]))
    return { manifest, params: { ...defaults, ...params } as Record<string, ParamValue>, mix, blend: 'normal', mask: null }
  }
  const clip = (texture: GPUTexture, width: number, height: number, effects: GpuEffect[]): CompositeStep => ({
    source: { kind: 'image', texture },
    inverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    width,
    height,
    rotation: 0,
    opacity: 1,
    blend: 'normal',
    colour: { undoMacDisplay: false, conversion: { kind: 'none' } },
    effects
  })

  // ---- Colour: 16 patches, 64 px each.
  const W = COLOURS.length * 64
  const H = 64
  compositor.resize(W, H)
  const patches = new OffscreenCanvas(W, H)
  const ctx = patches.getContext('2d')!
  COLOURS.forEach((c, i) => {
    ctx.fillStyle = `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`
    ctx.fillRect(i * 64, 0, 64, H)
  })
  const colourImage = compositor.imageTexture(await createImageBitmap(patches))
  const colourCheck = async (name: string, effects: GpuEffect[], expected: Rgb[], limit = 0.004) => {
    const read = await readAll(device, compositor.render([clip(colourImage, W, H, effects)], 1))
    let error = 0
    let where = ''
    COLOURS.forEach((_, i) => {
      const got = read(i * 64 + 32, 32)
      for (let k = 0; k < 3; k++) {
        const e = Math.abs(got[k]! - expected[i]![k]!)
        if (e > error) (error = e), (where = `patch ${i} channel ${k}: got ${got[k]!.toFixed(4)}, expected ${expected[i]![k]!.toFixed(4)}`)
      }
    })
    checks.push({ name, error: Math.round(error * 10000) / 10000, limit, where })
  }

  const basicCases: Array<Partial<BasicCorrectionParams>> = [
    {}, { exposure: 1 }, { exposure: -1.5 }, { temperature: 70 }, { temperature: -50 }, { tint: 60 }, { tint: -45, temperature: 30 },
    { brightness: 60 }, { brightness: -60 }, { contrast: 80 }, { contrast: -80 }, { highlights: -100 }, { highlights: 70 }, { shadows: 100 }, { shadows: -60 },
    { whites: 100 }, { whites: -70 }, { blacks: 100 }, { blacks: -100 }, { saturation: 0 }, { saturation: 180 }, { vibrance: 100 }, { vibrance: -100 },
    { hue: 90 }, { hue: -135 },
    { temperature: 25, exposure: 0.4, contrast: 30, highlights: -40, shadows: 30, saturation: 120, vibrance: 30, hue: 10 }
  ]
  for (const p of basicCases) {
    const params = { ...BASIC_DEFAULTS, ...p }
    await colourCheck(`basic ${JSON.stringify(p)}`, [fx('basic-correction', p as Record<string, ParamValue>)], COLOURS.map((c) => basicCorrectionReference(c, params)))
  }

  const identity = { master: IDENTITY_CURVE, red: IDENTITY_CURVE, green: IDENTITY_CURVE, blue: IDENTITY_CURVE }
  const curveCases: Array<Partial<typeof identity>> = [
    {},
    { master: '0,0 0.25,0.18 0.75,0.85 1,1' },
    { red: '0,0.1 0.5,0.6 1,1', blue: '0,1 1,0' },
    { green: '0,0 0.2,0.5 0.4,0.1 0.6,0.9 0.8,0.3 1,1', master: '0.1,0 0.9,1' },
    { master: Array.from({ length: 16 }, (_, i) => `${(i / 15).toFixed(4)},${(0.5 + 0.45 * Math.sin(i)).toFixed(4)}`).join(' ') }
  ]
  for (const p of curveCases) {
    const params = { ...identity, ...p }
    await colourCheck(`curves ${JSON.stringify(p)}`, [fx('curves', p)], COLOURS.map((c) => curvesReference(c, params)))
  }

  const levelCases: Array<Record<string, number>> = [
    {}, { inBlack: 30, inWhite: 220, gamma: 1.4 }, { outBlack: 20, outWhite: 235 }, { redGamma: 0.6, blueOutWhite: 180, greenInBlack: 60 },
    { inBlack: 128, inWhite: 128 }, { gamma: 9.99 }, { gamma: 0.1, redInWhite: 100 }
  ]
  for (const p of levelCases) await colourCheck(`levels ${JSON.stringify(p)}`, [fx('levels', p)], COLOURS.map((c) => levelsReference(c, p)))

  // A stack: Basic → Curves → Levels, each the reference of the one before.
  const look = { temperature: -20, contrast: 25, saturation: 130 }
  const lookCurve = { master: '0,0.05 0.5,0.55 1,0.95' }
  const lookLevels = { inBlack: 10, gamma: 1.1 }
  await colourCheck(
    'stack basic → curves → levels',
    [fx('basic-correction', look), fx('curves', lookCurve), fx('levels', lookLevels)],
    COLOURS.map((c) => levelsReference(curvesReference(basicCorrectionReference(c, { ...BASIC_DEFAULTS, ...look }), { ...identity, ...lookCurve }), lookLevels))
  )
  colourImage.destroy()

  // ---- Mosaic: a 480 × 270 image of known, busy pixels.
  const MW = 480
  const MH = 270
  compositor.resize(MW, MH)
  const bytes = new Uint8ClampedArray(MW * MH * 4)
  const rgba = new Float32Array(MW * MH * 4)
  for (let y = 0; y < MH; y++)
    for (let x = 0; x < MW; x++) {
      const i = (y * MW + x) * 4
      const v = [(x * 7 + y * 13) % 256, (x * 3 + y * 29 + ((x * y) >> 5)) % 256, (((x ^ y) * 5) + 40) % 256, 255]
      bytes.set(v, i)
      rgba.set(v.map((n) => n / 255), i)
    }
  const noiseCanvas = new OffscreenCanvas(MW, MH)
  noiseCanvas.getContext('2d')!.putImageData(new ImageData(bytes, MW, MH), 0, 0)
  const noise = compositor.imageTexture(await createImageBitmap(noiseCanvas))
  const ref: RefImage = { width: MW, height: MH, rgba }
  // Every 7th pixel each way (about 2,600 pixels), plus each corner.
  const points: Array<[number, number]> = [[0, 0], [MW - 1, 0], [0, MH - 1], [MW - 1, MH - 1]]
  for (let y = 3; y < MH; y += 7) for (let x = 2; x < MW; x += 7) points.push([x, y])
  const mosaicCheck = async (name: string, params: Record<string, ParamValue>, limit = 0.004, mix = 1) => {
    const read = await readAll(device, compositor.render([clip(noise, MW, MH, [fx('mosaic', params, mix)])], 1))
    const expected = mosaicReference(ref, { ...(Object.fromEntries(effectById('mosaic')!.params.map((p) => [p.id, p.default])) as Record<string, ParamValue>), ...params })
    let error = 0
    let where = ''
    let flips = 0
    for (const [x, y] of points) {
      const got = read(x, y)
      const want = expected(x, y)
      const src = Array.from(rgba.slice((y * MW + x) * 4, (y * MW + x) * 4 + 3))
      const e = Math.max(...[0, 1, 2].map((k) => Math.abs(got[k]! - (src[k]! + (want[k]! - src[k]!) * mix))))
      if (e > 0.05) flips++
      if (e > error) (error = e), (where = `(${x}, ${y}): got ${got.slice(0, 3).map((v) => v.toFixed(3))}, expected ${want.slice(0, 3).map((v) => v.toFixed(3))}`)
    }
    checks.push({ name, error: Math.round(error * 10000) / 10000, limit, where: flips ? `${where}; ${flips} pixels off by more than 0.05` : where })
  }
  await mosaicCheck('mosaic 10% average (exact cells)', { cellSize: 10 })
  await mosaicCheck('mosaic 6.3% aspect 1.7 average', { cellSize: 6.3, aspect: 1.7 })
  await mosaicCheck('mosaic 10% aspect 0.4 centre pixel', { cellSize: 10, aspect: 0.4, sample: 'centre' })
  await mosaicCheck('mosaic 7.3% softness 60%', { cellSize: 7.3, softness: 60 })
  await mosaicCheck('mosaic 12% softness 100%', { cellSize: 12, softness: 100 })
  await mosaicCheck('mosaic 2.5% (cell edges through pixels)', { cellSize: 2.5 })
  await mosaicCheck('mosaic 40%', { cellSize: 40 })
  await mosaicCheck('mosaic 100% aspect 4 (one cell)', { cellSize: 100, aspect: 4 })
  await mosaicCheck('mosaic off under a pixel', { cellSize: 0.2 })
  await mosaicCheck('mosaic 10% at 40% mix', { cellSize: 10 }, 0.004, 0.4)
  noise.destroy()

  // ---- Speed: each effect alone on a 4K frame (the GPU's time, 20 frames each).
  compositor.resize(3840, 2160)
  const big = new OffscreenCanvas(3840, 2160)
  const bctx = big.getContext('2d')!
  const gradient = bctx.createLinearGradient(0, 0, 3840, 2160)
  gradient.addColorStop(0, '#203050')
  gradient.addColorStop(0.5, '#e0a070')
  gradient.addColorStop(1, '#40c0a0')
  bctx.fillStyle = gradient
  bctx.fillRect(0, 0, 3840, 2160)
  const frame4k = compositor.imageTexture(await createImageBitmap(big))
  const timing: Record<string, number> = {}
  const speedCases: Array<[string, GpuEffect[]]> = [
    ['no effect', []],
    ['basic correction', [fx('basic-correction', { temperature: 20, contrast: 30, vibrance: 40, hue: 5 })]],
    ['curves', [fx('curves', { master: '0,0 0.25,0.18 0.75,0.85 1,1' })]],
    ['levels', [fx('levels', { inBlack: 20, gamma: 1.2 })]],
    ['mosaic 1%', [fx('mosaic', { cellSize: 1 })]],
    ['mosaic 5%', [fx('mosaic', { cellSize: 5 })]],
    ['mosaic 20% softness 50%', [fx('mosaic', { cellSize: 20, softness: 50 })]],
    ['mosaic 100% aspect 4 (one cell)', [fx('mosaic', { cellSize: 100, aspect: 4 })]]
  ]
  for (const [name, effects] of speedCases) {
    compositor.render([clip(frame4k, 3840, 2160, effects)], 1)
    await device.queue.onSubmittedWorkDone()
    const start = performance.now()
    for (let i = 0; i < 20; i++) compositor.render([clip(frame4k, 3840, 2160, effects)], 1)
    await device.queue.onSubmittedWorkDone()
    timing[name] = Math.round(((performance.now() - start) / 20) * 100) / 100
  }
  frame4k.destroy()
  compositor.destroy()
  const failed = checks.filter((c) => !(c.error <= c.limit))
  return { verdict: failed.length === 0 ? 'pass' : 'fail', checked: checks.length, failed, worst: Math.max(...checks.map((c) => c.error)), msPer4kFrame: timing, checks }
}

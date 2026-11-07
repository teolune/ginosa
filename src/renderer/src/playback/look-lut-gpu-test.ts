import type { ParamValue } from '@engine/effects/types'
import { parseCube } from '@engine/colour/cube'
import { lookReference, unitCube } from '@engine/colour/look-lut'
import { hsbToRgb } from '@engine/gradients/colour'
import { effectById } from '../../../effects/registry'
import { getGpu } from '../gpu/shared'
import { Compositor, type CompositeStep, type GpuEffect, type GpuLut } from './compositor'

/**
 * Look LUTs (decision 77) on the GPU against the CPU reference (engine/colour/look-lut.ts):
 * made-up 3D and 1D LUTs, one with its own domain, at several strengths, then every .cube in
 * your Reference Materials/Look LUTs (read only), on a grey ramp, 16 colours and a hue sweep.
 */

type Rgb = [number, number, number]

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exponent = (h >> 10) & 0x1f
  const fraction = h & 0x3ff
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
}

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

/** A .cube made from a function, for the made-up LUTs. */
function cubeText(size: number, f: (r: number, g: number, b: number) => Rgb, extra = '', kind: '3d' | '1d' = '3d'): string {
  const lines = [`TITLE "test"`, kind === '3d' ? `LUT_3D_SIZE ${size}` : `LUT_1D_SIZE ${size}`, extra]
  if (kind === '1d') for (let i = 0; i < size; i++) lines.push(f(i / (size - 1), i / (size - 1), i / (size - 1)).map((v) => v.toFixed(6)).join(' '))
  else for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push(f(r / (size - 1), g / (size - 1), b / (size - 1)).map((v) => v.toFixed(6)).join(' '))
  return lines.join('\n')
}

const COLOURS: Rgb[] = [
  [230, 40, 30], [30, 200, 60], [40, 70, 220], [240, 240, 240], [20, 20, 20], [128, 128, 128],
  [200, 150, 60], [90, 30, 120], [224, 172, 140], [5, 5, 8], [255, 255, 255], [0, 0, 0],
  [60, 180, 200], [250, 120, 180], [10, 20, 60], [250, 240, 150]
].map((c) => c.map((v) => v / 255) as Rgb)

export async function runLookLutGpuTest() {
  const { device } = await getGpu()
  const compositor = new Compositor(device)
  const manifest = effectById('look-lut')!
  const checks: Array<{ name: string; error: number; limit: number; where?: string }> = []

  // The image: a 256-level grey ramp, 16 colours, and 64 hues at full and half saturation (4 px each).
  const inputs: Rgb[] = [
    ...Array.from({ length: 256 }, (_, x) => [x / 255, x / 255, x / 255] as Rgb),
    ...COLOURS,
    ...Array.from({ length: 64 }, (_, i) => hsbToRgb((i / 64) * 360, 100, 90)),
    ...Array.from({ length: 64 }, (_, i) => hsbToRgb((i / 64) * 360, 45, 70))
  ].map((c) => c.map((v) => Math.round(v * 255) / 255) as Rgb)
  const W = inputs.length * 2
  const H = 4
  compositor.resize(W, H)
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d')!
  inputs.forEach((c, i) => {
    ctx.fillStyle = `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`
    ctx.fillRect(i * 2, 0, 2, H)
  })
  const image = compositor.imageTexture(await createImageBitmap(canvas))
  const clip = (effects: GpuEffect[]): CompositeStep => ({
    source: { kind: 'image', texture: image },
    inverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    width: W,
    height: H,
    rotation: 0,
    opacity: 1,
    blend: 'normal',
    colour: { undoMacDisplay: false, conversion: { kind: 'none' } },
    effects
  })
  const fx = (lut: GpuLut | null, strength: number, mix = 1): GpuEffect => ({ manifest, params: { lut: lut ? 'test.cube' : '', strength } as Record<string, ParamValue>, mix, blend: 'normal', mask: null, lut })
  const upload = (text: string) => {
    const cube = unitCube(parseCube(text))
    return { cube, gpu: compositor.lutTexture(cube.size, cube.data, [0, 0, 0], [1, 1, 1]) }
  }

  /** Within 0.004 of the reference, plus its slope × the 16-bit input's precision (as the Gradient Map test). */
  const check = async (name: string, effect: GpuEffect, expected: (c: Rgb) => Rgb) => {
    const read = await readAll(device, compositor.render([clip([effect])], 1))
    let worst = 0
    let where = ''
    inputs.forEach((c, i) => {
      const got = read(i * 2 + 1, 2)
      const want = expected(c)
      const up = expected(c.map((v) => Math.min(1, v + 0.002)) as Rgb)
      const down = expected(c.map((v) => Math.max(0, v - 0.002)) as Rgb)
      for (let k = 0; k < 3; k++) {
        const slope = Math.max(Math.abs(up[k]! - want[k]!), Math.abs(want[k]! - down[k]!)) / 0.002
        const allowed = 0.004 + slope * 0.0006
        const share = Math.abs(got[k]! - want[k]!) / allowed
        if (share > worst) (worst = share), (where = `input ${c.map((v) => Math.round(v * 255)).join(',')} channel ${k}: got ${got[k]!.toFixed(4)}, expected ${want[k]!.toFixed(4)}`)
      }
    })
    checks.push({ name, error: Math.round(worst * 1000) / 1000, limit: 1, where })
  }

  await check('no LUT chosen: unchanged', fx(null, 100), (c) => c)
  // A warm, contrasty look with channel mixing (17³).
  const warm = upload(cubeText(17, (r, g, b) => [Math.min(1, 0.9 * r ** 0.85 + 0.1 * g), 0.95 * g ** 1.05 + 0.03, 0.15 * r + 0.75 * b ** 1.2]))
  for (const strength of [100, 50, 0, 160]) await check(`17³ warm look at ${strength}%`, fx(warm.gpu, strength), (c) => lookReference(warm.cube, c, strength))
  await check('17³ warm look, mix 40%', fx(warm.gpu, 100, 0.4), (c) => lookReference(warm.cube, c, 100).map((v, k) => c[k]! + (v - c[k]!) * 0.4) as Rgb)
  // A 1D LUT (a film-ish toe and shoulder), turned into a 65³ cube.
  const curve = upload(cubeText(1024, (r, g, b) => [r, g, b].map((v) => 1 / (1 + Math.exp(-7 * (v - 0.5))) * 1.06 - 0.03) as Rgb, '', '1d'))
  await check('1D LUT (1024 entries)', fx(curve.gpu, 100), (c) => lookReference(curve.cube, c, 100))
  // A LUT with its own domain (inputs 0.1–0.9 cover the cube; outside holds the edge).
  const domain = upload(cubeText(9, (r, g, b) => [g, b, r], 'DOMAIN_MIN 0.1 0.1 0.1\nDOMAIN_MAX 0.9 0.9 0.9'))
  await check('domain 0.1–0.9, channels swapped', fx(domain.gpu, 100), (c) => lookReference(domain.cube, c, 100))

  // Your look LUTs, read from Reference Materials/Look LUTs (never changed).
  const yours = await window.ginosa.snapshot.referenceLooks()
  const problems: string[] = []
  for (const file of yours) {
    try {
      const lut = upload(file.text)
      await check(`yours: ${file.name} (${lut.cube.size}³)`, fx(lut.gpu, 100), (c) => lookReference(lut.cube, c, 100))
      lut.gpu.texture.destroy()
    } catch (error) {
      problems.push(`${file.name}: ${(error as Error).message}`)
    }
  }
  image.destroy()

  // Speed: a 33³ look on a 4K frame.
  compositor.resize(3840, 2160)
  const big = new OffscreenCanvas(3840, 2160)
  const bctx = big.getContext('2d')!
  const g = bctx.createLinearGradient(0, 0, 3840, 2160)
  g.addColorStop(0, '#203050')
  g.addColorStop(0.5, '#e0a070')
  g.addColorStop(1, '#40c0a0')
  bctx.fillStyle = g
  bctx.fillRect(0, 0, 3840, 2160)
  const frame4k = compositor.imageTexture(await createImageBitmap(big))
  const look33 = upload(cubeText(33, (r, gg, b) => [r ** 0.9, gg, b ** 1.1]))
  const timing: Record<string, number> = {}
  for (const [name, effects] of [
    ['no effect', []],
    ['look LUT 33³', [fx(look33.gpu, 80)]]
  ] as Array<[string, GpuEffect[]]>) {
    const step: CompositeStep = { ...clip(effects), source: { kind: 'image', texture: frame4k }, width: 3840, height: 2160 }
    compositor.render([step], 1)
    await device.queue.onSubmittedWorkDone()
    const start = performance.now()
    for (let i = 0; i < 20; i++) compositor.render([step], 1)
    await device.queue.onSubmittedWorkDone()
    timing[name] = Math.round(((performance.now() - start) / 20) * 100) / 100
  }
  frame4k.destroy()
  compositor.destroy()
  const failed = checks.filter((c) => !(c.error <= c.limit))
  return { verdict: failed.length === 0 && problems.length === 0 ? 'pass' : 'fail', checked: checks.length, yours: yours.length, failed, problems, worst: Math.max(...checks.map((c) => c.error)), msPer4kFrame: timing, checks }
}

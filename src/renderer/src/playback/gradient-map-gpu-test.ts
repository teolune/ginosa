import type { ParamValue } from '@engine/effects/types'
import { blendRgb } from '@engine/effects/blend'
import { formatGradient, solid, starterGradients, type SolidGradient } from '@engine/gradients/gradient'
import type { BlendMode } from '@engine/project/model'
import { gradientMapReference, type GradientMapParams } from '../../../effects/gradient-map/reference'
import { effectById } from '../../../effects/registry'
import { getGpu } from '../gpu/shared'
import { Compositor, type CompositeStep, type GpuEffect } from './compositor'

/**
 * M13: Gradient Map on the GPU against its CPU reference (src/effects/gradient-map/reference.ts):
 * a 256-level grey ramp and 16 known colours through each method, midpoints, smoothness,
 * Reverse, Input Range, Offset / Repeat / Edges, Morph, opacity stops and blend modes, then
 * its time on a 4K frame.
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

export async function runGradientMapGpuTest() {
  const { device } = await getGpu()
  const compositor = new Compositor(device)
  const checks: Array<{ name: string; error: number; limit: number; where?: string }> = []
  const manifest = effectById('gradient-map')!
  const defaults = Object.fromEntries(manifest.params.map((p) => [p.id, p.default])) as unknown as GradientMapParams

  const fx = (params: Partial<GradientMapParams>, blend: BlendMode = 'normal', mix = 1): GpuEffect => ({ manifest, params: { ...defaults, ...params } as unknown as Record<string, ParamValue>, mix, blend, mask: null })
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

  // One image: a 256-level grey ramp (one column per level), then 16 colour patches of 8 px.
  const W = 256 + COLOURS.length * 8
  const H = 8
  compositor.resize(W, H)
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d')!
  const inputs: Rgb[] = []
  for (let x = 0; x < 256; x++) {
    ctx.fillStyle = `rgb(${x},${x},${x})`
    ctx.fillRect(x, 0, 1, H)
    inputs.push([x / 255, x / 255, x / 255])
  }
  COLOURS.forEach((c, i) => {
    ctx.fillStyle = `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`
    ctx.fillRect(256 + i * 8, 0, 8, H)
  })
  const xs = [...Array.from({ length: 256 }, (_, x) => x), ...COLOURS.map((_, i) => 256 + i * 8 + 4)]
  inputs.push(...COLOURS)
  const image = compositor.imageTexture(await createImageBitmap(canvas))

  /**
   * Each pixel within `limit` of the reference, plus what the picture's own precision moves:
   * the effect reads a 16-bit float image (about 0.0006 either way near white), and a steep map
   * (Repeat 4 through a contrasty gradient) multiplies that by its slope. The report gives the
   * error as a share of the allowance (1 = right at it).
   */
  const INPUT_PRECISION = 0.0006
  const check = async (name: string, effect: GpuEffect, expected: (c: Rgb) => Rgb, limit = 0.004) => {
    const read = await readAll(device, compositor.render([clip(image, W, H, [effect])], 1))
    let worst = 0
    let where = ''
    xs.forEach((x, i) => {
      const got = read(x, 4)
      const c = inputs[i]!
      const want = expected(c)
      const up = expected(c.map((v) => Math.min(1, v + 0.002)) as Rgb)
      const down = expected(c.map((v) => Math.max(0, v - 0.002)) as Rgb)
      for (let k = 0; k < 3; k++) {
        const slope = Math.max(Math.abs(up[k]! - want[k]!), Math.abs(want[k]! - down[k]!)) / 0.002
        const allowed = limit + slope * INPUT_PRECISION
        const share = Math.abs(got[k]! - want[k]!) / allowed
        if (share > worst) (worst = share), (where = `${x < 256 ? `level ${x}` : `patch ${(x - 260) / 8}`} channel ${k}: got ${got[k]!.toFixed(4)}, expected ${want[k]!.toFixed(4)} (allowed ±${allowed.toFixed(4)})`)
      }
    })
    checks.push({ name, error: Math.round(worst * 1000) / 1000, limit: 1, where })
  }

  const starters = starterGradients()
  const brY = formatGradient(starters[3]!)
  const copper = formatGradient(starters[4]!)
  const sharp: SolidGradient = { ...starters[3]!, smoothness: 0 }
  sharp.colourStops = sharp.colourStops.map((s, i) => (i === 1 ? { ...s, midpoint: 0.2 } : i === 2 ? { ...s, midpoint: 0.85 } : s))
  const fade = solid('Fade', [[0, [0.1, 0.2, 0.9]], [1, [1, 0.8, 0.1]]])
  fade.opacityStops = [{ location: 0, midpoint: 0.5, opacity: 1 }, { location: 0.6, midpoint: 0.3, opacity: 0.2 }, { location: 1, midpoint: 0.5, opacity: 0 }]
  const cases: Array<[string, Partial<GradientMapParams>]> = [
    ['black, white (the default)', {}],
    ['blue, red, yellow, Classic', { gradient: brY }],
    ['blue, red, yellow, Perceptual', { gradient: brY, method: 'perceptual' }],
    ['blue, red, yellow, Linear', { gradient: brY, method: 'linear' }],
    ['blue, red, yellow, Smooth', { gradient: brY, method: 'smooth' }],
    ['copper (four stops)', { gradient: copper }],
    ['midpoints 20% / 85%, smoothness 0%', { gradient: formatGradient(sharp) }],
    ['reverse', { gradient: brY, reverse: true }],
    ['input range 20–70%', { gradient: brY, inputBlack: 20, inputWhite: 70 }],
    ['input range backwards', { gradient: brY, inputBlack: 80, inputWhite: 10 }],
    ['offset 35%, wrap', { gradient: brY, offset: 35 }],
    ['offset −60%, clamp', { gradient: brY, offset: -60, edges: 'clamp' }],
    ['repeat 3.5, mirror', { gradient: copper, repeat: 3.5, edges: 'mirror' }],
    ['repeat 4, wrap', { gradient: copper, repeat: 4 }],
    ['morph 40% to copper', { gradient: brY, gradientB: copper, morph: 40 }],
    ['opacity stops ignored (as Photoshop)', { gradient: formatGradient(fade) }],
    ['opacity stops used', { gradient: formatGradient(fade), opacityStops: true }]
  ]
  for (const [name, p] of cases) await check(name, fx(p), (c) => gradientMapReference(c, { ...defaults, ...p }))

  // Blend modes get the gradient's colour to blend with (here Soft Light and Color, Photoshop staples).
  for (const mode of ['soft-light', 'overlay', 'color'] as BlendMode[]) {
    await check(`blend ${mode}`, fx({ gradient: brY }, mode), (c) => blendRgb(c, gradientMapReference(c, { ...defaults, gradient: brY }), mode))
  }
  await check('mix 50%', fx({ gradient: brY }, 'normal', 0.5), (c) => gradientMapReference(c, { ...defaults, gradient: brY }).map((v, k) => c[k]! + (v - c[k]!) * 0.5) as Rgb)
  // Dither: a level at most either way, and on average nothing.
  {
    const read = await readAll(device, compositor.render([clip(image, W, H, [fx({ dither: true })])], 1))
    let worst = 0
    let where = ''
    let sum = 0
    let n = 0
    for (let x = 0; x < 256; x++)
      for (let y = 0; y < H; y++) {
        const d = read(x, y)[0]! - gradientMapReference([x / 255, x / 255, x / 255], defaults)[0]
        if (Math.abs(d) > worst) (worst = Math.abs(d)), (where = `(${x}, ${y}): got ${read(x, y).map((v) => v.toFixed(4)).join(', ')}`)
        sum += d
        n++
      }
    checks.push({ name: 'dither within a level', error: Math.round((worst / (1 / 255 + 0.002)) * 1000) / 1000, limit: 1, where })
    checks.push({ name: 'dither averages out', error: Math.round((Math.abs(sum / n) / 0.0015) * 1000) / 1000, limit: 1 })
  }
  image.destroy()

  // ---- Speed on a 4K frame (20 frames each).
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
  const timing: Record<string, number> = {}
  for (const [name, effects] of [
    ['no effect', []],
    ['gradient map', [fx({ gradient: brY })]],
    ['gradient map, morph and dither', [fx({ gradient: brY, gradientB: copper, morph: 50, dither: true })]]
  ] as Array<[string, GpuEffect[]]>) {
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

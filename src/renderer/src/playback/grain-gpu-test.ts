import type { EffectClock, ParamValue } from '@engine/effects/types'
import { grainReference } from '../../../effects/grain/reference'
import { effectById } from '../../../effects/registry'
import { getGpu } from '../gpu/shared'
import { Compositor, type CompositeStep, type GpuEffect } from './compositor'
import { effectShaderSource, prepassShaderSource } from './effect-shader'

/**
 * M11: Grain on the GPU against its CPU maths (src/effects/grain/reference.ts), pixel by
 * pixel: a 960 × 540 image of known pixels (a grey ramp over colour bands), every setting
 * that changes the maths, several clocks (frames, beats before and after the downbeat),
 * then Grain's time on a 4K frame.
 */

type Rgb = [number, number, number]
const W = 960
const H = 540

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
  return (x, y) => [0, 1, 2].map((i) => halfToFloat(half[(y * row) / 2 + x * 4 + i]!))
}

export async function runGrainGpuTest() {
  const { device } = await getGpu()
  const compositor = new Compositor(device)
  compositor.resize(W, H)
  const manifest = effectById('grain')!
  // Shader compile messages, so a broken shader fails loudly rather than drawing nothing.
  const shaderErrors: string[] = []
  for (const [name, code] of [['main', effectShaderSource(manifest)], ['lattice', prepassShaderSource(manifest, 0)]] as const) {
    const info = await device.createShaderModule({ code }).getCompilationInfo()
    for (const m of info.messages) if (m.type === 'error') shaderErrors.push(`${name} ${m.lineNum}:${m.linePos} ${m.message} :: ${code.split('\n')[m.lineNum - 1]?.trim()}`)
  }
  if (shaderErrors.length) return { verdict: 'fail', shaderErrors }
  const defaults = Object.fromEntries(manifest.params.map((p) => [p.id, p.default])) as Record<string, ParamValue>
  // Top half: a grey ramp, black to white. Bottom half: six colour bands.
  const bands: Rgb[] = [[200, 40, 30], [40, 160, 70], [40, 70, 200], [230, 200, 120], [90, 40, 120], [20, 25, 30]]
  const bytes = new Uint8ClampedArray(W * H * 4)
  const src = (x: number, y: number): Rgb => {
    const i = (y * W + x) * 4
    return [bytes[i]! / 255, bytes[i + 1]! / 255, bytes[i + 2]! / 255]
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = y < H / 2 ? [Math.round((x / (W - 1)) * 255), Math.round((x / (W - 1)) * 255), Math.round((x / (W - 1)) * 255)] : bands[Math.floor((x * bands.length) / W)]!
      bytes.set([...v, 255], (y * W + x) * 4)
    }
  const canvas = new OffscreenCanvas(W, H)
  canvas.getContext('2d')!.putImageData(new ImageData(bytes, W, H), 0, 0)
  const image = compositor.imageTexture(await createImageBitmap(canvas))
  const clip = (effects: GpuEffect[], width = W, height = H, texture = image): CompositeStep => ({
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
  const grain = (params: Record<string, ParamValue>, clock: EffectClock, mix = 1): GpuEffect => ({ manifest, params: { ...defaults, ...params }, mix, blend: 'normal', mask: null, clock })
  const at = (frame: number, beat = frame * 0.08): EffectClock => ({ frame, beat, beatsPerFrame: 0.08, beatsPerBar: 4 })
  const points: Array<[number, number]> = []
  for (let y = 3; y < H; y += 7) for (let x = 2; x < W; x += 7) points.push([x, y])
  points.push([0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1])

  const checks: Array<{ name: string; error: number; limit: number; where: string }> = []
  const check = async (name: string, params: Record<string, ParamValue>, clock: EffectClock, mix = 1, limit = 0.004) => {
    const read = await readAll(device, compositor.render([clip([grain(params, clock, mix)])], 1))
    const reference = grainReference({ width: W, height: H }, { ...defaults, ...params }, clock)
    let error = 0
    let where = ''
    for (const [x, y] of points) {
      const input = src(x, y)
      const want = reference.output(x, y, input).map((v, k) => input[k]! + (v - input[k]!) * mix)
      const got = read(x, y)
      for (let k = 0; k < 3; k++) {
        const e = Math.abs(got[k]! - want[k]!)
        if (e > error) (error = e), (where = `(${x}, ${y}) channel ${k}: got ${got[k]!.toFixed(4)}, expected ${want[k]!.toFixed(4)}`)
      }
    }
    checks.push({ name, error: Math.round(error * 10000) / 10000, limit, where })
  }

  await check('defaults (colour, Film), frame 0', {}, at(0))
  await check('mono, Film 40%, size 3, softness 0, frame 17', { grainType: 'mono', amount: 40, size: 3, softness: 0 }, at(17))
  await check('colour 100%, sizes 60/100/220%, softness 100%', { colourAmount: 100, redSize: 60, greenSize: 100, blueSize: 220, softness: 100, amount: 35 }, at(5))
  // Digital can push dark pixels to just above or below zero light, where the display curve is
  // steepest: a 10⁻⁵ difference in light (f32 against f64) shows as up to 0.007 there.
  await check('Digital 30%', { composite: 'digital', amount: 30 }, at(9), 1, 0.008)
  await check('Grain layer 60%', { composite: 'layer', amount: 60 }, at(2))
  await check('every 3 frames, boil 37%, frame 25', { refresh: 'frames', every: 3, boil: 37, amount: 40 }, at(25))
  await check('on 1/16 notes, beat 13.37', { refresh: 'note', note: '1/16', amount: 40 }, at(167, 13.37))
  await check('on 1 bar, before the downbeat (beat −3.3)', { refresh: 'note', note: '1 bar', amount: 40, boil: 60 }, at(0, -3.3))
  await check('seed 123, frame 100000', { seed: 123, amount: 40 }, at(100000))
  await check('size 0.5 (finer than a pixel)', { size: 0.5, amount: 40 }, at(3))
  await check('shadows only, 200%', { shadows: 200, midtones: 0, highlights: 0, amount: 40 }, at(4))
  await check('Super 8-like at 50% mix', { size: 2.8, softness: 55, amount: 34, colourAmount: 50, redSize: 110, blueSize: 150 }, at(6), 0.5)

  // Two renders of one frame are identical; consecutive frames differ.
  const twice = await Promise.all([0, 1].map(async () => (await readAll(device, compositor.render([clip([grain({ amount: 40 }, at(7))])], 1)))(480, 135)))
  checks.push({ name: 'the same frame twice is identical', error: Math.max(...twice[0]!.map((v, k) => Math.abs(v - twice[1]![k]!))), limit: 0, where: '' })

  // Speed: Grain alone on a 4K frame (the GPU's time, 20 frames each).
  compositor.resize(3840, 2160)
  const big = new OffscreenCanvas(3840, 2160)
  const ctx = big.getContext('2d')!
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, 3840, 2160)
  const frame4k = compositor.imageTexture(await createImageBitmap(big))
  const timing: Record<string, number> = {}
  const cases: Array<[string, Record<string, ParamValue>]> = [
    ['no effect', {}],
    ['mono, size 1.2', { grainType: 'mono' }],
    ['colour (defaults)', {}],
    ['colour 100%, boil 50%', { colourAmount: 100, boil: 50 }],
    ['Super 8 (size 2.8)', { size: 2.8, colourAmount: 50 }],
    ['size 0.5', { size: 0.5 }]
  ]
  for (const [name, params] of cases) {
    const effects = name === 'no effect' ? [] : [grain(params, at(12))]
    compositor.render([clip(effects, 3840, 2160, frame4k)], 1)
    await device.queue.onSubmittedWorkDone()
    const start = performance.now()
    for (let i = 0; i < 20; i++) compositor.render([clip(name === 'no effect' ? [] : [grain(params, at(12 + i))], 3840, 2160, frame4k)], 1)
    await device.queue.onSubmittedWorkDone()
    timing[name] = Math.round(((performance.now() - start) / 20) * 100) / 100
  }
  frame4k.destroy()
  image.destroy()
  compositor.destroy()
  const failed = checks.filter((c) => !(c.error <= c.limit))
  return { verdict: failed.length === 0 ? 'pass' : 'fail', checked: checks.length, points: points.length, failed, worst: Math.max(...checks.map((c) => c.error)), msPer4kFrame: timing, checks }
}

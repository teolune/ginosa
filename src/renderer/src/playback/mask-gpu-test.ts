import type { ParamValue } from '@engine/effects/types'
import { luma, maskAlpha, newShape, packMask, resolveMask, type ResolvedShape } from '@engine/masks/masks'
import type { MaskShape } from '@engine/masks/types'
import { applyAffine, inverseMotion, invertAffine, type Affine } from '@engine/timeline/motion'
import { effectById } from '../../../effects/registry'
import { getGpu } from '../gpu/shared'
import { Compositor, type CompositeStep, type GpuEffect, type GpuMask } from './compositor'

/**
 * Shared masks on the GPU against the CPU reference (maskAlpha), over every pixel: Invert
 * through masks of every kind and mode, on a clip at frame size, on a clip moved by its
 * Motion (the mask stays put on the frame), and on adjustment layers at full and half
 * playback resolution.
 */

const W = 480
const H = 270
const frame = { width: W, height: H }
/** The test image: a grey ramp, black at the left to white at the right (columns are exact 8-bit values). */
const column = (i: number) => Math.round((255 * Math.min(W - 1, Math.max(0, i))) / (W - 1)) / 255

async function rampImage(compositor: Compositor): Promise<GPUTexture> {
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d')!
  for (let i = 0; i < W; i++) {
    const v = Math.round(column(i) * 255)
    ctx.fillStyle = `rgb(${v},${v},${v})`
    ctx.fillRect(i, 0, 1, H)
  }
  return compositor.imageTexture(await createImageBitmap(canvas))
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (m / 1024)
  if (e === 31) return m ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + m / 1024)
}

/** Red channel of a whole rgba16float texture. */
async function readRed(device: GPUDevice, texture: GPUTexture): Promise<Float32Array> {
  const { width, height } = texture
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height])
  device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const half = new Uint16Array(buffer.getMappedRange())
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = halfToFloat(half[y * (bytesPerRow / 2) + x * 4]!)
  buffer.unmap()
  buffer.destroy()
  return out
}

let n = 0
const shape = (kind: MaskShape['kind'], changes: Partial<MaskShape>): MaskShape => ({ ...newShape(`s${++n}`, kind, frame), ...changes })

/** A rotated, rounded, feathered rectangle, minus an ellipse, plus the frame's edges. */
const MASK_A = resolveMask(
  {
    id: 'a',
    name: 'A',
    shapes: [
      shape('rectangle', { position: [230, 140], size: [260, 150], rotation: 25, roundness: 30, feather: 24 }),
      shape('ellipse', { mode: 'subtract', position: [260, 130], size: [90, 60], feather: 8, rotation: -10 }),
      shape('edge', { width: 18, feather: 10 })
    ]
  },
  0
)

/** A bezier pen path, scaled and rotated, kept only where the image is between 30% and 75% bright (soft), at 80% opacity. */
const k = 0.5523 * 90
const MASK_B = resolveMask(
  {
    id: 'b',
    name: 'B',
    shapes: [
      shape('path', {
        position: [250, 135],
        scale: 120,
        rotation: 15,
        feather: 6,
        expansion: 4,
        points: [
          { x: 90, y: 0, inX: 0, inY: -k, outX: 0, outY: k },
          { x: 0, y: 60, inX: k, inY: 0, outX: -k, outY: 0 },
          { x: -90, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
          { x: 0, y: -90, inX: -k, inY: 0, outX: k, outY: 0 }
        ]
      }),
      shape('luminance', { mode: 'intersect', low: 30, high: 75, softness: 8, opacity: 80 })
    ]
  },
  0
)

export async function runMaskGpuTest() {
  const { device } = await getGpu()
  const compositor = new Compositor(device)
  const image = await rampImage(compositor)
  const identity: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const gpuMask = (shapes: ResolvedShape[], invert = false): GpuMask => ({ ...packMask(shapes), invert, frame })
  const invertFx = (mask: GpuMask | null): GpuEffect => {
    const manifest = effectById('invert')!
    return { manifest, params: Object.fromEntries(manifest.params.map((p) => [p.id, p.default])) as Record<string, ParamValue>, mix: 1, blend: 'normal', mask }
  }
  const clip = (effects: GpuEffect[], inverse: Affine = identity): CompositeStep => ({
    source: { kind: 'image', texture: image },
    inverse,
    width: W,
    height: H,
    rotation: 0,
    opacity: 1,
    blend: 'normal',
    colour: { undoMacDisplay: false, conversion: { kind: 'none' } },
    effects
  })
  const checks: Array<{ name: string; error: number; limit: number; pixels: number }> = []

  /** Renders at `scale` and compares every pixel `expected` returns a value for. */
  const compare = async (name: string, steps: CompositeStep[], scale: number, expected: (x: number, y: number) => number | null, limit = 0.004) => {
    const w = Math.round(W * scale)
    const h = Math.round(H * scale)
    compositor.resize(w, h)
    const got = await readRed(device, compositor.render(steps, scale))
    let worst = 0
    let pixels = 0
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const want = expected(x + 0.5, y + 0.5)
        if (want === null) continue
        pixels++
        worst = Math.max(worst, Math.abs(got[y * w + x]! - want))
      }
    checks.push({ name, error: Math.round(worst * 10000) / 10000, limit, pixels })
  }
  const inverted = (v: number, a: number) => v + (1 - 2 * v) * a

  // A clip at frame size: processed pixels are frame pixels.
  await compare('clip, rectangle − ellipse + edge', [clip([invertFx(gpuMask(MASK_A))])], 1, (x, y) => {
    const v = column(Math.floor(x))
    return inverted(v, maskAlpha(MASK_A, x, y, v, frame))
  })
  await compare('clip, same mask inverted', [clip([invertFx(gpuMask(MASK_A, true))])], 1, (x, y) => {
    const v = column(Math.floor(x))
    return inverted(v, 1 - maskAlpha(MASK_A, x, y, v, frame))
  })
  await compare('clip, bezier path ∩ luminance range', [clip([invertFx(gpuMask(MASK_B))])], 1, (x, y) => {
    const v = column(Math.floor(x))
    return inverted(v, maskAlpha(MASK_B, x, y, luma(v, v, v), frame))
  })

  // A clip moved by its Motion: its effect runs on its own pixels, but the mask is where it was drawn on the frame.
  const motion = { positionX: 260, positionY: 150, scale: 70, scaleWidth: 100, rotation: 20, anchorX: W / 2, anchorY: H / 2 }
  const inverse = inverseMotion(motion)!
  const toFrame = invertAffine(inverse)!
  const processed = (i: number, j: number) => {
    const v = column(i)
    const f = applyAffine(toFrame, i + 0.5, j + 0.5)
    return inverted(v, maskAlpha(MASK_B, f.x, f.y, v, frame, Math.sqrt(Math.abs(toFrame.a * toFrame.d - toFrame.b * toFrame.c))))
  }
  await compare('moved clip: the mask stays on the frame', [clip([invertFx(gpuMask(MASK_B))], inverse)], 1, (x, y) => {
    const p = applyAffine(inverse, x, y)
    // Inside the clip (away from its soft edge): bilinear between the processed pixels.
    if (p.x < 1.5 || p.y < 1.5 || p.x > W - 1.5 || p.y > H - 1.5) return null
    const i = Math.floor(p.x - 0.5)
    const j = Math.floor(p.y - 0.5)
    const fx = p.x - 0.5 - i
    const fy = p.y - 0.5 - j
    return (processed(i, j) * (1 - fx) + processed(i + 1, j) * fx) * (1 - fy) + (processed(i, j + 1) * (1 - fx) + processed(i + 1, j + 1) * fx) * fy
  })

  // Adjustment layers: the layer's own mask (and its effects' masks), at full and half resolution.
  const below = (x: number, scale: number) => {
    // The ramp drawn at `scale`: bilinear between columns.
    const p = x / scale - 0.5
    const i = Math.floor(p)
    const t = p - i
    return column(i) * (1 - t) + column(i + 1) * t
  }
  for (const scale of [1, 0.5]) {
    const adjust: CompositeStep = { kind: 'adjustment', effects: [invertFx(null)], opacity: 1, blend: 'normal', mask: gpuMask(MASK_A) }
    await compare(`adjustment layer mask at ${scale === 1 ? 'full' : 'half'} resolution`, [clip([]), adjust], scale, (x, y) => {
      const v = below(x, scale)
      return inverted(v, maskAlpha(MASK_A, x / scale, y / scale, v, frame, 1 / scale))
    })
  }
  const both: CompositeStep = { kind: 'adjustment', effects: [invertFx(gpuMask(MASK_B))], opacity: 0.7, blend: 'normal', mask: gpuMask(MASK_A, true) }
  await compare('adjustment: effect mask and layer mask (inverted) at 70%', [clip([]), both], 1, (x, y) => {
    const v = below(x, 1)
    const effected = inverted(v, maskAlpha(MASK_B, x, y, v, frame))
    return v + (effected - v) * 0.7 * (1 - maskAlpha(MASK_A, x, y, v, frame))
  })

  // How long a heavy mask takes on a 4K frame (every pixel visits every path edge).
  const heavy = gpuMask([...MASK_A, ...MASK_B])
  compositor.resize(3840, 2160)
  const steps = [clip([]), { kind: 'adjustment', effects: [invertFx(heavy)], opacity: 1, blend: 'normal', mask: heavy } as CompositeStep]
  await device.queue.onSubmittedWorkDone()
  const started = performance.now()
  for (let i = 0; i < 10; i++) compositor.render(steps, 8)
  await device.queue.onSubmittedWorkDone()
  const msPerFrame4k = Math.round(((performance.now() - started) / 10) * 100) / 100

  image.destroy()
  compositor.destroy()
  const failed = checks.filter((c) => !(c.error <= c.limit))
  return { verdict: failed.length === 0 ? 'pass' : 'fail', checked: checks.length, failed, worst: Math.max(...checks.map((c) => c.error)), checks, edges: heavy.data.length / 4 - 4 * heavy.parts, msPerFrame4k }
}

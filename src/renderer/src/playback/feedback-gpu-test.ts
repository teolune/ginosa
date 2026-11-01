import type { ParamValue } from '@engine/effects/types'
import { effectById } from '../../../effects/registry'
import { feedbackReference, type FeedbackParams } from '../../../effects/feedback/reference'
import { getGpu } from '../gpu/shared'
import { Compositor, type CompositeStep, type GpuEffect } from './compositor'
import { TemporalStore } from './temporal'

/**
 * Feedback on the GPU against its CPU reference, frame after frame (M9): moving blocks
 * on a 160 × 90 image, through Feedback with zoom and rotation, in each mode; then the
 * state store's checkpoints and catch-up (a frame rendered after a jump must equal the
 * same frame rendered in sequence), and playback's approximation after a dropped frame.
 */

const W = 160
const H = 90

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (m / 1024)
  if (e === 31) return m ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + m / 1024)
}

async function readRgba(device: GPUDevice, texture: GPUTexture): Promise<Float32Array> {
  const { width, height } = texture
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height])
  device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const half = new Uint16Array(buffer.getMappedRange())
  const out = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let i = 0; i < width * 4; i++) out[y * width * 4 + i] = halfToFloat(half[y * (bytesPerRow / 2) + i]!)
  buffer.unmap()
  buffer.destroy()
  return out
}

/** Frame n of the input: three coloured blocks moving in different directions (exact 8-bit values). */
function inputFrame(n: number): { rgba: Uint8ClampedArray<ArrayBuffer>; float: Float32Array } {
  const rgba = new Uint8ClampedArray(W * H * 4)
  const blocks = [
    { x: 10 + n * 3, y: 20, w: 18, h: 14, c: [230, 60, 40] },
    { x: 120 - n * 2, y: 50 + (n % 7), w: 12, h: 22, c: [40, 210, 120] },
    { x: 70, y: 70 - n, w: 26, h: 8, c: [60, 90, 240] }
  ]
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      rgba[i] = 12
      rgba[i + 1] = 12
      rgba[i + 2] = 18
      rgba[i + 3] = 255
      for (const b of blocks) if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) rgba.set([...b.c, 255], i)
    }
  return { rgba, float: Float32Array.from(rgba, (v) => v / 255) }
}

export async function runFeedbackGpuTest() {
  const { device } = await getGpu()
  const compositor = new Compositor(device)
  compositor.resize(W, H)
  const manifest = effectById('feedback')!
  const checks: Array<{ name: string; error: number; limit: number }> = []
  const textures: GPUTexture[] = []
  const frameTexture = async (n: number) => {
    const { rgba } = inputFrame(n)
    const texture = compositor.imageTexture(await createImageBitmap(new ImageData(rgba, W, H)))
    textures.push(texture)
    return texture
  }
  const inputs: GPUTexture[] = []
  for (let n = 0; n < 60; n++) inputs.push(await frameTexture(n))
  const step = (n: number, effect: GpuEffect): CompositeStep => ({
    source: { kind: 'image', texture: inputs[n]! },
    inverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    width: W,
    height: H,
    rotation: 0,
    opacity: 1,
    blend: 'normal',
    colour: { undoMacDisplay: false, conversion: { kind: 'none' } },
    effects: [effect]
  })
  const fx = (p: FeedbackParams, store: TemporalStore, n: number, key = 'k'): GpuEffect => ({
    manifest,
    params: { amount: p.amount, zoom: p.zoom, rotation: p.rotation, centre: p.centre, mode: p.mode } as Record<string, ParamValue>,
    mix: 1,
    blend: 'normal',
    mask: null,
    state: store.state('clip:fx', key, n)
  })
  const worst = (a: Float32Array, b: Float32Array) => {
    let e = 0
    for (let i = 0; i < a.length; i++) if (i % 4 !== 3) e = Math.max(e, Math.abs(a[i]! - b[i]!))
    return e
  }

  // 1. Every mode, 24 frames each, against the reference.
  for (const mode of ['over', 'add', 'screen', 'lighten'] as const) {
    const p: FeedbackParams = { amount: 85, zoom: 103, rotation: 4, centre: [W * 0.55, H * 0.45], mode }
    const store = new TemporalStore(device, 25)
    let cpu: Float32Array | null = null
    let e = 0
    for (let n = 0; n < 24; n++) {
      cpu = feedbackReference(inputFrame(n).float, cpu, W, H, p)
      const gpu = await readRgba(device, compositor.render([step(n, fx(p, store, n))], 1))
      // The composite is opaque over black, so compare colour only (add can go past 1 in both).
      e = Math.max(e, worst(gpu, cpu))
    }
    checks.push({ name: `${mode}, zoom 103%, rotation 4°, 24 frames`, error: Math.round(e * 10000) / 10000, limit: 0.01 })
    store.clear()
  }

  // 2. Checkpoints and catch-up: frames 0–59 in order, then a jump back to 40.
  const p: FeedbackParams = { amount: 90, zoom: 101, rotation: -2, centre: [W / 2, H / 2], mode: 'over' }
  const store = new TemporalStore(device, 25)
  const inOrder: Float32Array[] = []
  for (let n = 0; n < 60; n++) inOrder.push(await readRgba(device, compositor.render([step(n, fx(p, store, n))], 1)))
  const kept = store.checkpoints()
  checks.push({ name: 'checkpoints kept at frames 25 and 50', error: kept === 2 ? 0 : 1, limit: 0 })
  const from = store.needs('clip:fx', 'k', 40)
  checks.push({ name: `a jump to frame 40 replays from frame 26 (got ${from})`, error: from === 26 ? 0 : 1, limit: 0 })
  for (let n = from!; n < 40; n++) compositor.render([step(n, fx(p, store, n))], 1)
  const jumped = await readRgba(device, compositor.render([step(40, fx(p, store, 40))], 1))
  checks.push({ name: 'frame 40 after the jump equals frame 40 in order', error: worst(jumped, inOrder[40]!), limit: 0 })
  // Frame 40 again after 41: it's kept, so it's shown as it was (not run again).
  const again41 = await readRgba(device, compositor.render([step(41, fx(p, store, 41))], 1))
  checks.push({ name: 'frame 41 after the jump equals frame 41 in order', error: worst(again41, inOrder[41]!), limit: 0 })
  const kept40 = await readRgba(device, compositor.render([step(40, fx(p, store, 40))], 1))
  checks.push({ name: 'frame 40 shown again from what was kept', error: worst(kept40, inOrder[40]!), limit: 0 })
  const kept50 = await readRgba(device, compositor.render([step(50, fx(p, store, 50))], 1))
  checks.push({ name: 'checkpoint frame 50 shown from the checkpoint', error: worst(kept50, inOrder[50]!), limit: 0 })
  checks.push({ name: 'no state was missing in exact mode', error: store.stats.missed, limit: 0 })
  // A different key (an edit) starts again from the reset.
  checks.push({ name: 'an edit (new key) replays from the reset', error: store.needs('clip:fx', 'edited', 30) === 0 ? 0 : 1, limit: 0 })

  // 3. Live playback after a dropped frame carries on from the older state, marked approximate.
  store.mode = 'live'
  const before = store.stats.approximate
  compositor.render([step(44, fx(p, store, 44))], 1)
  checks.push({ name: 'a dropped frame in playback is approximate', error: store.stats.approximate === before + 1 ? 0 : 1, limit: 0 })
  checks.push({ name: 'an approximate state is never used for an exact frame', error: store.needs('clip:fx', 'k', 45) !== null ? 0 : 1, limit: 0 })
  store.mode = 'exact'
  const bytes = store.bytes()
  store.clear()

  textures.forEach((t) => t.destroy())
  compositor.destroy()
  const failed = checks.filter((c) => !(c.error <= c.limit))
  return { verdict: failed.length === 0 ? 'pass' : 'fail', checked: checks.length, failed, checks, stateBytesAt160x90: bytes }
}

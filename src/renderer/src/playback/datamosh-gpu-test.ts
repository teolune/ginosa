import type { EffectClock, ParamValue } from '@engine/effects/types'
import { effectById } from '../../../effects/registry'
import { getGpu } from '../gpu/shared'
import { Compositor, type CompositeLayer, type CompositeStep, type GpuEffect } from './compositor'
import { TemporalStore } from './temporal'

/**
 * Datamosh (M14) on the GPU, frame after frame, on 960 × 540 pictures whose motion is known
 * exactly (whole-pixel shifts of a textured pattern):
 *  - a moving picture through Datamosh comes out as itself (the motion found moves the buffer
 *    exactly as the picture moved), and at Speed 50% half as far;
 *  - Push slides a still picture; Freeze holds; Leak lets the real frame back (evenly, or
 *    about that share of whole blocks); Momentum carries motion on after it stops; Bloom holds it;
 *  - resets: every beat, and the Reset Trigger as it crosses 50%, give the real frame;
 *  - the state (the buffer, the kept luma pyramid and motion) survives a jump: frame 40
 *    after catching up from a checkpoint equals frame 40 in order;
 *  - Residual 100% follows a fade on a still picture (the change is added, as a P-frame adds
 *    it), where without it the picture holds; Intra Blocks 50% refreshes the blocks of a new,
 *    unrelated picture (a cut), and leaves well-matched moving blocks alone;
 *  - motion transfer: a still picture moved by another track's motion, as a clip's effect and
 *    on an adjustment layer; held when that track is empty; and measured where the source shows
 *    on screen (a clip at half size sees the motion twice as large in its own pixels);
 *  - its time on a 1080p frame.
 */

const W = 960
const H = 540
const PAD = 240

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

/** A textured pattern bigger than the frame (value noise at three scales, a field per channel), 8-bit. */
function pattern(seed: number): { data: Uint8ClampedArray; width: number; height: number } {
  const width = W + 2 * PAD
  const height = H + 2 * PAD
  const hash = (x: number, y: number, s: number) => {
    let h = (x * 374761393 + y * 668265263 + s * 2246822519) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  const noise = (x: number, y: number, cell: number, s: number) => {
    const gx = x / cell
    const gy = y / cell
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const a = hash(x0, y0, s) + (hash(x0 + 1, y0, s) - hash(x0, y0, s)) * sx
    const b = hash(x0, y0 + 1, s) + (hash(x0 + 1, y0 + 1, s) - hash(x0, y0 + 1, s)) * sx
    return a + (b - a) * sy
  }
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        const v = 0.5 * noise(x, y, 40, seed * 10 + c) + 0.3 * noise(x, y, 13, seed * 10 + c + 3) + 0.2 * noise(x, y, 5, seed * 10 + c + 6)
        data[i + c] = Math.round(Math.min(1, Math.max(0, (v - 0.5) * 1.8 + 0.5)) * 255)
      }
      data[i + 3] = 255
    }
  return { data, width, height }
}

type Pattern = ReturnType<typeof pattern>

/** The frame-sized window of a pattern, its top-left at (PAD + ox, PAD + oy): the picture moved by (−ox, −oy). */
function crop(p: Pattern, ox: number, oy: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    const from = ((y + PAD + oy) * p.width + PAD + ox) * 4
    out.set(p.data.subarray(from, from + W * 4), y * W * 4)
  }
  return out
}

/** Mean and worst difference (0–1) over the colour of the frame's middle, away from the edges blocks are pulled in from. */
function compare(gpu: Float32Array, want: Uint8ClampedArray, margin = 80): { mean: number; worst: number } {
  let sum = 0
  let n = 0
  let worst = 0
  for (let y = margin; y < H - margin; y++)
    for (let x = margin; x < W - margin; x++)
      for (let c = 0; c < 3; c++) {
        const i = (y * W + x) * 4 + c
        const e = Math.abs(gpu[i]! - want[i]! / 255)
        sum += e
        n++
        if (e > worst) worst = e
      }
  return { mean: sum / n, worst }
}

export async function runDatamoshGpuTest() {
  const { device } = await getGpu()
  const compositor = new Compositor(device)
  compositor.resize(W, H)
  const manifest = effectById('datamosh')!
  const defaults = Object.fromEntries(manifest.params.map((p) => [p.id, p.default])) as Record<string, ParamValue>
  const checks: Array<{ name: string; error: number; limit: number; detail?: string }> = []
  const A = pattern(1)
  const B = pattern(2)
  const textures = new Map<string, GPUTexture>()
  const texture = async (key: string, rgba: Uint8ClampedArray<ArrayBuffer>) => {
    let t = textures.get(key)
    if (!t) {
      t = compositor.imageTexture(await createImageBitmap(new ImageData(rgba, W, H)))
      textures.set(key, t)
    }
    return t
  }
  const clock = (n: number): EffectClock => ({ frame: n, beat: n * 0.08, beatsPerFrame: 0.08, beatsPerBar: 4 })
  const run = async (name: string, frames: number, input: (n: number) => [string, Uint8ClampedArray<ArrayBuffer>], params: Record<string, ParamValue> | ((n: number) => Record<string, ParamValue>), store = new TemporalStore(device, 25), read = true) => {
    const out: Float32Array[] = []
    for (let n = 0; n < frames; n++) {
      const [key, rgba] = input(n)
      const p = typeof params === 'function' ? params(n) : params
      const effect: GpuEffect = { manifest, params: { ...defaults, ...p }, mix: 1, blend: 'normal', mask: null, state: store.state(`clip:${name}`, 'k', n), clock: clock(n), sinceCut: n }
      const step: CompositeStep = { source: { kind: 'image', texture: await texture(key, rgba) }, inverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, width: W, height: H, rotation: 0, opacity: 1, blend: 'normal', colour: { undoMacDisplay: false, conversion: { kind: 'none' } }, effects: [effect] }
      const result = compositor.render([step], 1)
      out.push(read ? await readRgba(device, result) : new Float32Array(0))
    }
    return { out, store }
  }
  const push = (name: string, r: { mean: number; worst: number }, limit = 0.01, detail = '') =>
    checks.push({ name, error: Math.round(r.mean * 10000) / 10000, limit, detail: `${detail}worst pixel ${r.worst.toFixed(3)}` })
  const v = [6, -2] as const
  const moving = (pat: Pattern, tag: string) => (n: number): [string, Uint8ClampedArray<ArrayBuffer>] => [`${tag}${n}`, crop(pat, -n * v[0], -n * v[1])]

  // 0. The motion found on frame 1 (Show: Motion): every block should be fetched from 6 left, 2 down.
  {
    const { out } = await run('vectors', 2, moving(B, 'B'), { view: 'motion' })
    let wrong = 0
    let total = 0
    const examples: string[] = []
    for (let by = 10; by < H / 8 - 10; by++)
      for (let bx = 10; bx < W / 8 - 10; bx++) {
        const i = ((by * 8 + 4) * W + bx * 8 + 4) * 4
        const d = [(0.5 - out[1]![i]!) * 64, (0.5 - out[1]![i + 1]!) * 64]
        total++
        if (Math.abs(d[0]! + 6) > 0.1 || Math.abs(d[1]! - 2) > 0.1) {
          wrong++
          if (examples.length < 6) examples.push(`block ${bx},${by}: ${d.map((x) => x.toFixed(1)).join(', ')}`)
        }
      }
    checks.push({ name: 'frame 1: blocks whose motion was found exactly', error: Math.round((wrong / total) * 1000) / 1000, limit: 0.01, detail: `${wrong} of ${total} wrong. ${examples.join('; ')}` })
  }
  // 1. A picture moving 6 px right and 2 up each frame comes out as itself.
  {
    const { out } = await run('follow', 11, moving(B, 'B'), {})
    for (const n of [1, 5, 10]) push(`moving picture, frame ${n}: the buffer moves with it`, compare(out[n]!, crop(B, -n * v[0], -n * v[1])))
  }
  // 2. Speed 50%: half as far.
  {
    const { out } = await run('speed', 9, moving(B, 'B'), { speed: 50 })
    push('Speed 50%, frame 8: moved half as far (24 px, not 48)', compare(out[8]!, crop(B, -8 * 3, 8)))
  }
  // 3. Push X 4 (2 px a frame at 540 high) slides a still picture right.
  {
    const still = (): [string, Uint8ClampedArray<ArrayBuffer>] => ['A', crop(A, 0, 0)]
    const { out } = await run('push', 9, still, { pushX: 4 })
    push('Push X 4 on a still picture, frame 8: 16 px to the right', compare(out[8]!, crop(A, -16, 0)))
  }
  // 4. Freeze 5: frames 1–5 hold frame 0, then the motion pushes it.
  {
    const { out } = await run('freeze', 10, moving(B, 'B'), { freeze: 5 })
    push('Freeze 5, frame 5: still frame 0', compare(out[5]!, crop(B, 0, 0)))
    push('Freeze 5, frame 9: frame 0 moved by 4 frames of motion', compare(out[9]!, crop(B, -4 * v[0], -4 * v[1])))
  }
  // 5. Leak 100%: the real frame; Leak 50% in blocks: about half the blocks are the real frame.
  {
    const { out } = await run('leak', 6, moving(B, 'B'), { leak: 100 })
    push('Leak 100%, frame 5: the real frame', compare(out[5]!, crop(B, -5 * v[0], -5 * v[1]), 0))
    const blocks = await run('leakblocks', 6, moving(B, 'B'), { leak: 50, leakStyle: 'blocks', freeze: 1000 })
    // Block size 16 at 540 high is 8 px: count 8 × 8 blocks that equal the real frame 5.
    const real = crop(B, -5 * v[0], -5 * v[1])
    let fresh = 0
    let total = 0
    for (let by = 0; by < Math.floor(H / 8); by++)
      for (let bx = 0; bx < Math.floor(W / 8); bx++) {
        let e = 0
        for (let y = by * 8; y < by * 8 + 8; y++) for (let x = bx * 8; x < bx * 8 + 8; x++) for (let c = 0; c < 3; c++) e = Math.max(e, Math.abs(blocks.out[5]![(y * W + x) * 4 + c]! - real[(y * W + x) * 4 + c]! / 255))
        if (e < 0.004) fresh++
        total++
      }
    const share = fresh / total
    checks.push({ name: 'Leak 50% in blocks: about half the blocks refreshed', error: Math.round(Math.abs(share - 0.5) * 1000) / 1000, limit: 0.05, detail: `${(share * 100).toFixed(1)}% of ${total} blocks` })
  }
  // 6. Momentum 90%: after the picture stops (frame 6), the buffer keeps moving; with none, it stops.
  {
    const stops = (n: number): [string, Uint8ClampedArray<ArrayBuffer>] => (n <= 6 ? moving(B, 'B')(n) : ['B6', crop(B, -6 * v[0], -6 * v[1])])
    const without = await run('nomomentum', 12, stops, {})
    const withM = await run('momentum', 12, stops, { momentum: 90 })
    const still = compare(without.out[11]!, crop(B, -6 * v[0], -6 * v[1]))
    push('no momentum: stops when the picture stops', still)
    const drift = compare(withM.out[11]!, crop(B, -6 * v[0], -6 * v[1]))
    checks.push({ name: 'Momentum 90%: still moving 5 frames after the picture stopped', error: drift.mean > 0.03 ? 0 : 1, limit: 0, detail: `differs from the stopped picture by ${drift.mean.toFixed(3)}` })
  }
  // 7. Bloom: triggered on frame 4 for 4 frames, the motion of frame 4 repeats after the picture stops.
  {
    const stops = (n: number): [string, Uint8ClampedArray<ArrayBuffer>] => (n <= 4 ? moving(B, 'B')(n) : ['B4', crop(B, -4 * v[0], -4 * v[1])])
    const { out } = await run('bloom', 10, stops, (n) => ({ bloomTrigger: n === 4 ? 100 : 0, bloomFrames: 4 }))
    // Frames 4–7 hold the motion: the buffer moves 7 frames' worth though the picture stopped after 4.
    push('Bloom on frame 4 for 4 frames: frame 8 has moved 3 frames past where the picture stopped', compare(out[8]!, crop(B, -7 * v[0], -7 * v[1])))
    push('… and then it stops: frame 9 equals frame 8', compare(out[9]!, Uint8ClampedArray.from(out[8]!, (x) => x * 255)))
  }
  // 8. Resets: every beat (0.08 beats a frame: frames 13 and 25), and the Reset Trigger (frame 7).
  {
    const { out } = await run('beats', 26, moving(B, 'B'), { every: 'beat', freeze: 1000 })
    push('Reset Every beat: frame 13 is the real frame', compare(out[13]!, crop(B, -13 * v[0], -13 * v[1]), 0))
    push('… and frame 20 holds frame 13 (frozen)', compare(out[20]!, crop(B, -13 * v[0], -13 * v[1]), 0))
    push('… frame 25 is the real frame again', compare(out[25]!, crop(B, -25 * v[0], -25 * v[1]), 0))
    const t = await run('trigger', 10, moving(B, 'B'), (n) => ({ freeze: 1000, resetTrigger: n === 7 || n === 8 ? 100 : 0 }))
    push('Reset Trigger rising past 50% on frame 7: the real frame', compare(t.out[7]!, crop(B, -7 * v[0], -7 * v[1]), 0))
    push('… staying up on frame 8 doesn’t reset again (frame 9 holds frame 7)', compare(t.out[9]!, crop(B, -7 * v[0], -7 * v[1]), 0))
  }
  // 9. The state survives a jump: frames 0–44 in order, then back to 40 from the checkpoint at 25.
  {
    const params = { momentum: 80, pushX: 3, swirl: 20, wrongMatches: 10, colourDrift: 30 }
    const store = new TemporalStore(device, 25)
    const { out } = await run('jump', 45, moving(B, 'B'), params, store)
    const from = store.needs('clip:jump', 'k', 40)
    checks.push({ name: `a jump to frame 40 replays from frame 26 (got ${from})`, error: from === 26 ? 0 : 1, limit: 0 })
    // Catch up from the checkpoint (frame 25's state, pyramid and motion), then frame 40.
    const replay = new Map<number, Float32Array>()
    for (let n = from!; n <= 40; n++) {
      const [key, rgba] = moving(B, 'B')(n)
      const effect: GpuEffect = { manifest, params: { ...defaults, ...params }, mix: 1, blend: 'normal', mask: null, state: store.state('clip:jump', 'k', n), clock: clock(n), sinceCut: n }
      const result = compositor.render([{ source: { kind: 'image', texture: await texture(key, rgba) }, inverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, width: W, height: H, rotation: 0, opacity: 1, blend: 'normal', colour: { undoMacDisplay: false, conversion: { kind: 'none' } }, effects: [effect] }], 1)
      if (n === 40) replay.set(n, await readRgba(device, result))
    }
    let worst = 0
    for (let i = 0; i < out[40]!.length; i++) if (i % 4 !== 3) worst = Math.max(worst, Math.abs(out[40]![i]! - replay.get(40)![i]!))
    checks.push({ name: 'frame 40 after the jump equals frame 40 in order', error: worst, limit: 0 })
    checks.push({ name: 'state held for the jump (MB)', error: 0, limit: 0, detail: `${Math.round(store.bytes() / 1e6)} MB at 960 × 540` })
    store.clear()
  }

  // 10. Residual: A darkening 4% a frame, without motion. Intra Blocks: B moving, then A (a cut) on frame 5.
  {
    const fade = (n: number): [string, Uint8ClampedArray<ArrayBuffer>] => [`fade${n}`, Uint8ClampedArray.from(crop(A, 0, 0), (v, i) => (i % 4 === 3 ? v : v * (1 - 0.04 * n)))]
    const held = await run('noresidual', 9, fade, {})
    // (Without it, the fade isn't corrected: block matching finds stray motion in it, as an encoder would.)
    const uncorrected = compare(held.out[8]!, fade(8)[1])
    checks.push({ name: 'Residual 0%, a fading still picture: frame 8 isn’t the real frame 8', error: uncorrected.mean > 0.02 ? 0 : 1, limit: 0, detail: `differs from it by ${uncorrected.mean.toFixed(3)}` })
    const followed = await run('residual', 9, fade, { residual: 100 })
    push('Residual 100%: frame 8 follows the fade (the real frame 8)', compare(followed.out[8]!, fade(8)[1]))
    const cut = (n: number): [string, Uint8ClampedArray<ArrayBuffer>] => (n < 5 ? moving(B, 'B')(n) : ['A', crop(A, 0, 0)])
    // Blocks (8 px at 540 high) of frame 5 that are the real frame.
    const refreshed = (out: Float32Array) => {
      const real = crop(A, 0, 0)
      let fresh = 0
      let total = 0
      for (let by = 1; by < Math.floor(H / 8) - 1; by++)
        for (let bx = 1; bx < Math.floor(W / 8) - 1; bx++) {
          let e = 0
          for (let y = by * 8; y < by * 8 + 8; y++) for (let x = bx * 8; x < bx * 8 + 8; x++) for (let c = 0; c < 3; c++) e = Math.max(e, Math.abs(out[(y * W + x) * 4 + c]! - real[(y * W + x) * 4 + c]! / 255))
          if (e < 0.004) fresh++
          total++
        }
      return fresh / total
    }
    const half = await run('intra', 7, cut, { intra: 50 })
    push('Intra Blocks 50%, moving: frame 4 still follows the moving picture', compare(half.out[4]!, crop(B, -4 * v[0], -4 * v[1])))
    const none = refreshed((await run('nointra', 6, cut, {})).out[5]!)
    const some = refreshed(half.out[5]!)
    const all = refreshed((await run('allintra', 6, cut, { intra: 100 })).out[5]!)
    checks.push({ name: 'Intra Blocks on a cut to an unrelated picture: more blocks refreshed as it rises (0%, 50%, 100%)', error: none < 0.05 && some > none + 0.2 && all > 0.95 ? 0 : 1, limit: 0, detail: `${(none * 100).toFixed(1)}%, ${(some * 100).toFixed(1)}%, ${(all * 100).toFixed(1)}% of the blocks are the real frame` })
  }

  // 11. Motion transfer: the still picture A moved by B's motion (a Motion Source track).
  {
    const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
    const layerOf = (t: GPUTexture, inverse = identity): CompositeLayer => ({ source: { kind: 'image', texture: t }, inverse, width: W, height: H, rotation: 0, opacity: 1, blend: 'normal', colour: { undoMacDisplay: false, conversion: { kind: 'none' } } })
    const still = await texture('A', crop(A, 0, 0))
    const transfer = async (name: string, how: 'clip' | 'adjustment' | 'empty' | 'half', frames: number, extra: Record<string, ParamValue> = {}) => {
      const store = new TemporalStore(device, 25)
      const out: Float32Array[] = []
      // Half size: the clip at 50%, centred (sequence pixel → source pixel).
      const half = { a: 2, b: 0, c: 0, d: 2, e: -W / 2, f: -H / 2 }
      for (let n = 0; n < frames; n++) {
        const [key, rgba] = moving(B, 'B')(n)
        const effect: GpuEffect = { manifest, params: { ...defaults, motionSource: 'source-track', ...extra }, mix: 1, blend: 'normal', mask: null, state: store.state(`clip:${name}`, 'k', n), clock: clock(n), sinceCut: n, motionKey: 'transfer' }
        const steps: CompositeStep[] = []
        if (how === 'adjustment') steps.push(layerOf(still))
        if (how !== 'empty') steps.push({ kind: 'motion', key: 'transfer', layer: layerOf(await texture(key, rgba)) })
        if (how === 'adjustment') steps.push({ kind: 'adjustment', effects: [effect], opacity: 1, blend: 'normal', mask: null })
        else steps.push({ ...layerOf(still, how === 'half' ? half : identity), effects: [effect] })
        out.push(await readRgba(device, compositor.render(steps, 1)))
      }
      store.clear()
      return out
    }
    const onClip = await transfer('transferclip', 'clip', 9)
    push('Motion transfer on a clip, frame 8: the still picture moved by the source’s motion', compare(onClip[8]!, crop(A, -8 * v[0], -8 * v[1])))
    const onAdjustment = await transfer('transferadj', 'adjustment', 9)
    push('… on an adjustment layer, frame 8: the same', compare(onAdjustment[8]!, crop(A, -8 * v[0], -8 * v[1])))
    const empty = await transfer('transferempty', 'empty', 9)
    push('… with nothing on the source track, frame 8: the picture holds', compare(empty[8]!, crop(A, 0, 0)))
    // At half size the source moves 6 px a frame on screen: 12 px in the clip's own pixels.
    const halfSize = await transfer('transferhalf', 'half', 2, { view: 'motion' })
    let wrong = 0
    let total = 0
    for (let y = H / 4 + 40; y < (3 * H) / 4 - 40; y += 8)
      for (let x = W / 4 + 40; x < (3 * W) / 4 - 40; x += 8) {
        const i = (y * W + x) * 4
        const d = [(0.5 - halfSize[1]![i]!) * 64, (0.5 - halfSize[1]![i + 1]!) * 64]
        total++
        if (Math.abs(d[0]! + 12) > 0.1 || Math.abs(d[1]! - 4) > 0.1) wrong++
      }
    checks.push({ name: '… on a clip at half size: motion found in its own pixels (12 px, not 6)', error: Math.round((wrong / total) * 1000) / 1000, limit: 0.01, detail: `${wrong} of ${total} samples wrong` })
  }

  // Speed: 1080p, 20 frames after the first.
  compositor.resize(1920, 1080)
  const big = new OffscreenCanvas(1920, 1080)
  const bctx = big.getContext('2d')!
  bctx.drawImage(await createImageBitmap(new ImageData(crop(B, 0, 0), W, H)), 0, 0, 1920, 1080)
  const frame1080 = compositor.imageTexture(await createImageBitmap(big))
  const store = new TemporalStore(device, 25)
  const timing: Record<string, number> = {}
  for (const blockSize of ['4', '16', '32']) {
    const step = (n: number): CompositeStep => ({ source: { kind: 'image', texture: frame1080 }, inverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, width: 1920, height: 1080, rotation: 0, opacity: 1, blend: 'normal', colour: { undoMacDisplay: false, conversion: { kind: 'none' } }, effects: [{ manifest, params: { ...defaults, blockSize }, mix: 1, blend: 'normal', mask: null, state: store.state(`speed${blockSize}`, 'k', n), clock: clock(n), sinceCut: n }] })
    compositor.render([step(0)], 1)
    compositor.render([step(1)], 1)
    await device.queue.onSubmittedWorkDone()
    const start = performance.now()
    for (let n = 2; n < 22; n++) compositor.render([step(n)], 1)
    await device.queue.onSubmittedWorkDone()
    timing[`1080p, ${blockSize} px blocks`] = Math.round(((performance.now() - start) / 20) * 100) / 100
  }
  store.clear()
  frame1080.destroy()
  textures.forEach((t) => t.destroy())
  compositor.destroy()
  const failed = checks.filter((c) => !(c.error <= c.limit))
  return { verdict: failed.length === 0 ? 'pass' : 'fail', checked: checks.length, failed, msPerFrame: timing, checks }
}

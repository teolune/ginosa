import { blendRgb } from '@engine/effects/blend'
import type { ParamValue } from '@engine/effects/types'
import { BLEND_MODES, type BlendMode } from '@engine/project/model'
import { effectById } from '../../../effects/registry'
import { invertReference } from '../../../effects/invert/reference'
import { getGpu } from '../gpu/shared'
import { readPixels } from './colour-probe'
import { Compositor, type CompositeStep, type GpuEffect } from './compositor'

/**
 * The effect pipeline on the GPU against the CPU reference maths: a 640 × 64 image of
 * ten known colours goes straight through the compositor (no decoding), with each
 * effect setting, blend mode and adjustment-layer option, and is read back.
 */

type Rgb = [number, number, number]
const COLOURS: Rgb[] = [
  [230, 40, 30], [30, 200, 60], [40, 70, 220], [240, 240, 240], [20, 20, 20],
  [128, 128, 128], [200, 150, 60], [90, 30, 120], [60, 180, 200], [250, 120, 180]
].map((c) => c.map((v) => v / 255) as Rgb)
const W = 640
const H = 64
const xs = COLOURS.map((_, i) => i * 64 + 32)

async function testImage(compositor: Compositor): Promise<GPUTexture> {
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d')!
  COLOURS.forEach((c, i) => {
    ctx.fillStyle = `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`
    ctx.fillRect(i * 64, 0, 64, H)
  })
  return compositor.imageTexture(await createImageBitmap(canvas))
}

export async function runEffectGpuTest() {
  const { device } = await getGpu()
  const compositor = new Compositor(device)
  compositor.resize(W, H)
  const image = await testImage(compositor)
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const clip = (effects: GpuEffect[] = []): CompositeStep => ({
    source: { kind: 'image', texture: image },
    inverse: identity,
    width: W,
    height: H,
    rotation: 0,
    opacity: 1,
    blend: 'normal',
    colour: { undoMacDisplay: false, conversion: { kind: 'none' } },
    effects
  })
  const fx = (id: string, params: Record<string, ParamValue>, mix = 1, blend: BlendMode = 'normal'): GpuEffect => {
    const manifest = effectById(id)!
    const defaults = Object.fromEntries(manifest.params.map((p) => [p.id, p.type === 'point' ? [p.default[0] * W, p.default[1] * H] : p.default]))
    return { manifest, params: { ...defaults, ...params } as Record<string, ParamValue>, mix, blend, mask: null }
  }
  const render = async (steps: CompositeStep[], y = 32) => readPixels(compositor.render(steps, 1), xs.map((x) => [x, y] as [number, number]))
  const worst = (got: number[][], expected: Rgb[]) => Math.max(...got.flatMap((g, i) => g.map((v, c) => Math.abs(v - expected[i]![c]!))))
  const checks: Array<{ name: string; error: number; limit: number }> = []
  const check = (name: string, got: number[][], expected: Rgb[], limit = 0.004) => checks.push({ name, error: Math.round(worst(got, expected) * 10000) / 10000, limit })

  const base = await render([clip()])
  check('no effect', base, COLOURS)

  for (const space of ['display', 'linear']) {
    for (const channel of ['rgb', 'red', 'green', 'blue', 'luminance', 'hue', 'chroma']) {
      for (const amount of [100, 37]) {
        const got = await render([clip([fx('invert', { channel, space, amount })])])
        check(`invert ${channel} ${space} ${amount}%`, got, COLOURS.map((c) => invertReference(c, { amount, channel, space })))
      }
    }
  }

  // Every blend mode, through an effect: Invert blended onto the original.
  for (const mode of BLEND_MODES.map((m) => m.id)) {
    const got = await render([clip([fx('invert', {}, 1, mode)])])
    check(`blend ${mode}`, got, COLOURS.map((c) => blendRgb(c, invertReference(c, { amount: 100, channel: 'rgb', space: 'display' }), mode)))
  }
  const mixed = await render([clip([fx('invert', {}, 0.3)])])
  check('mix 30%', mixed, COLOURS.map((c) => c.map((v) => v + (1 - v - v) * 0.3) as Rgb))

  // Stacks run top to bottom: Invert then 50% Mix of a second Invert = halfway back.
  const stacked = await render([clip([fx('invert', {}), fx('invert', {}, 0.5)])])
  check('two inverts, the second at 50%', stacked, COLOURS.map(() => [0.5, 0.5, 0.5] as Rgb))

  // Transform: the same image, moved one patch to the right (64 px).
  const moved = await render([clip([fx('transform', { position: [W / 2 + 64, H / 2] })])])
  check('transform position +64 px', moved, COLOURS.map((c, i) => (i === 0 ? [0, 0, 0] : COLOURS[i - 1]!) as Rgb))
  const tiled = await render([clip([fx('transform', { position: [W / 2 + 64, H / 2], edges: 'tile' })])])
  check('transform tile', tiled, COLOURS.map((_, i) => COLOURS[(i + 9) % 10]!))
  const mirrored = await render([clip([fx('transform', { position: [W / 2 + 64, H / 2], edges: 'mirror' })])])
  check('transform mirror', mirrored, COLOURS.map((_, i) => COLOURS[i === 0 ? 0 : i - 1]!))
  const rotated = await render([clip([fx('transform', { rotation: 180 })])])
  check('transform rotate 180°', rotated, COLOURS.map((_, i) => COLOURS[9 - i]!))
  const halved = await render([clip([fx('transform', { scale: 50, sampling: 'nearest' })])])
  // At 50% the image spans x 160–480: patch centres map to source x = 2(x − 320) + 320.
  check('transform scale 50% nearest', halved, xs.map((x) => (x < 160 || x >= 480 ? [0, 0, 0] : COLOURS[Math.floor((2 * (x - 320) + 320) / 64)]!) as Rgb))

  // Adjustment layers: on everything beneath, with opacity and blend mode.
  const adjust = (effects: GpuEffect[], opacity = 1, blend: BlendMode = 'normal'): CompositeStep => ({ kind: 'adjustment', effects, opacity, blend, mask: null })
  const inverted = COLOURS.map((c) => c.map((v) => 1 - v) as Rgb)
  check('adjustment invert', await render([clip(), adjust([fx('invert', {})])]), inverted)
  check('adjustment 40% opacity', await render([clip(), adjust([fx('invert', {})], 0.4)]), COLOURS.map((c) => c.map((v) => v + (1 - 2 * v) * 0.4) as Rgb))
  check('adjustment multiply', await render([clip(), adjust([fx('invert', {})], 1, 'multiply')]), COLOURS.map((c) => c.map((v) => v * (1 - v)) as Rgb))
  // Transparency survives: what a Transform uncovers stays empty (black) whichever way round,
  // since Invert flips colour, not transparency (as in Photoshop and Premiere).
  const shrink = fx('transform', { scale: 50, sampling: 'nearest' })
  const outside = (x: number) => x < 160 || x >= 480
  const shrunk = (x: number) => inverted[Math.floor((2 * (x - 320) + 320) / 64)]!
  check('adjustment invert → transform', await render([clip(), adjust([fx('invert', {}), shrink])]), xs.map((x) => (outside(x) ? [0, 0, 0] : shrunk(x)) as Rgb))
  check('adjustment transform → invert', await render([clip(), adjust([shrink, fx('invert', {})])]), xs.map((x) => (outside(x) ? [0, 0, 0] : shrunk(x)) as Rgb))
  // Order matters for colour effects: red channel then luminance is not luminance then red.
  const red = { channel: 'red' }
  const lum = { channel: 'luminance' }
  const redThenLum = COLOURS.map((c) => invertReference(invertReference(c, { amount: 100, space: 'display', ...red }), { amount: 100, space: 'display', ...lum }))
  const lumThenRed = COLOURS.map((c) => invertReference(invertReference(c, { amount: 100, space: 'display', ...lum }), { amount: 100, space: 'display', ...red }))
  check('adjustment invert red → luminance', await render([clip(), adjust([fx('invert', red), fx('invert', lum)])]), redThenLum)
  check('adjustment invert luminance → red', await render([clip(), adjust([fx('invert', lum), fx('invert', red)])]), lumThenRed)
  const differ = Math.max(...redThenLum.flatMap((c, i) => c.map((v, k) => Math.abs(v - lumThenRed[i]![k]!))))
  checks.push({ name: 'the two orders really differ', error: differ > 0.1 ? 0 : 1, limit: 0.5 })

  image.destroy()
  compositor.destroy()
  const failed = checks.filter((c) => !(c.error <= c.limit))
  return { verdict: failed.length === 0 ? 'pass' : 'fail', checked: checks.length, failed, worst: Math.max(...checks.map((c) => c.error)), checks }
}

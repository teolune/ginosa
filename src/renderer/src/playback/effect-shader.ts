import { blendIndex } from '@engine/effects/blend'
import { DISPLAY_GAMMA } from '@engine/effects/colour-spaces'
import type { EffectClock, EffectManifest, ImageSize, ParamValue } from '@engine/effects/types'
import type { BlendMode } from '@engine/project/model'
import blendSource from './blend.wgsl?raw'
import maskSource from './mask.wgsl?raw'
import type { Affine } from '@engine/timeline/motion'
import { CURVE_SAMPLES, curveTable } from '@engine/effects/curves'

/**
 * Turns an effect's WGSL into a complete render pass: its parameters as a uniform
 * struct, helpers to read the input in the effect's colour space, and the shared
 * controls every effect gets (the result converted back to display values, then
 * blended onto the input with its blend mode and Mix).
 */

const SPACES = { display: 0, linear: 1, oklab: 2 } as const

interface Field {
  name: string
  value(params: Record<string, ParamValue>, pixelScale: number): number
}

function fields(manifest: EffectManifest): Field[] {
  const out: Field[] = []
  for (const spec of manifest.params) {
    const id = spec.id
    switch (spec.type) {
      case 'number':
        out.push({ name: id, value: (p, scale) => Number(p[id] ?? spec.default) * (spec.pixels ? scale : 1) })
        break
      case 'angle':
      case 'steps':
        out.push({ name: id, value: (p) => Number(p[id] ?? spec.default) })
        break
      case 'toggle':
        out.push({ name: id, value: (p) => ((p[id] ?? spec.default) ? 1 : 0) })
        break
      case 'choice':
        out.push({ name: id, value: (p) => Math.max(0, spec.options.findIndex((o) => o.id === (p[id] ?? spec.default))) })
        break
      case 'point':
        out.push({ name: `${id}_x`, value: (p, scale) => ((p[id] as [number, number] | undefined)?.[0] ?? 0) * scale })
        out.push({ name: `${id}_y`, value: (p, scale) => ((p[id] as [number, number] | undefined)?.[1] ?? 0) * scale })
        break
    }
  }
  // Uniform structs are padded to 16 bytes.
  while (out.length === 0 || out.length % 4 !== 0) out.push({ name: `_pad${out.length}`, value: () => 0 })
  return out
}

/** The effect's tables (M10): each curve parameter baked to CURVE_SAMPLES values, in manifest order. Null when it has none. */
export function packData(manifest: EffectManifest, params: Record<string, ParamValue>): Float32Array | null {
  const curves = manifest.params.filter((p) => p.type === 'curve')
  if (curves.length === 0) return null
  const out = new Float32Array(curves.length * CURVE_SAMPLES)
  curves.forEach((spec, i) => out.set(curveTable(String(params[spec.id] ?? spec.default)), i * CURVE_SAMPLES))
  return out
}

export function paramsBytes(manifest: EffectManifest): number {
  return fields(manifest).length * 4
}

/** The effect's parameter values as the uniform buffer expects. Pixel values are scaled to the processing size. */
export function packParams(manifest: EffectManifest, params: Record<string, ParamValue>, pixelScale: number): Float32Array {
  return new Float32Array(fields(manifest).map((f) => f.value(params, pixelScale)))
}

/** Where a pass's mask comes from: how many shapes, and how its pixels map onto the frame the mask is drawn on. */
export interface PassMask {
  parts: number
  invert: boolean
  /** Processed pixel → frame (sequence) pixel. */
  toFrame: Affine
  frame: { width: number; height: number }
}

/** Frame pixels one processed pixel covers (the softest a mask edge gets). */
export function maskAa(toFrame: Affine): number {
  return Math.max(1e-3, Math.sqrt(Math.abs(toFrame.a * toFrame.d - toFrame.b * toFrame.c)))
}

/** A stateful effect's place in time: whether there's a previous frame, and how many frames since its reset. */
export interface PassTemporal {
  hasPrevious: boolean
  frames: number
}

/**
 * The frame uniform: image size, Mix (0–1), blend mode, pixel scale, then the mask's shape
 * count, edge softness, invert and placement, then a stateful effect's place in time, then
 * the size of the image this pass writes and of the earlier pass it reads (M10), then the
 * clock: frame number and beat (M11).
 */
export function packFrame(width: number, height: number, mix: number, blend: BlendMode, pixelScale: number, mask: PassMask | null = null, temporal: PassTemporal | null = null, sizes: { output: ImageSize; prepass: ImageSize | null } | null = null, clock: EffectClock | null = null): Float32Array {
  const m = mask?.toFrame ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  return new Float32Array([
    width, height, mix, blendIndex(blend),
    pixelScale, mask ? mask.parts : 0, mask ? maskAa(m) : 1, mask?.invert ? 1 : 0,
    m.a, m.b, m.c, m.d,
    m.e, m.f, mask?.frame.width ?? width, mask?.frame.height ?? height,
    temporal?.hasPrevious ? 1 : 0, temporal?.frames ?? 0, 0, 0,
    sizes?.output.width ?? width, sizes?.output.height ?? height, sizes?.prepass?.width ?? 1, sizes?.prepass?.height ?? 1,
    clock?.frame ?? 0, clock?.beat ?? 0, clock?.beatsPerFrame ?? 0, clock?.beatsPerBar ?? 4
  ])
}

/** The WGSL every effect pass shares: uniforms, bindings, colour spaces and helpers. */
function prelude(manifest: EffectManifest): string {
  const params = fields(manifest)
    .map((f) => `  ${f.name}: f32,`)
    .join('\n')
  const curves = manifest.params
    .filter((p) => p.type === 'curve')
    .map((p, i) => `const CURVE_${p.id}: u32 = ${i}u;`)
    .join('\n')
  return `
struct EffectFrame {
  size: vec2f,
  mixAmount: f32,
  blendMode: f32,
  pixelScale: f32,
  maskParts: f32,
  maskAa: f32,
  maskInvert: f32,
  toFrame0: vec4f, // a, b, c, d: processed pixel -> frame pixel
  toFrame1: vec4f, // e, f, frame width, frame height
  temporal: vec4f, // has a previous frame (stateful effects), frames since the reset
  passes: vec4f, // the size of the image this pass writes, then of the earlier pass it reads
  clock: vec4f, // sequence frame number, beat on the grid, beats per frame, beats per bar
};

struct EffectParams {
${params}
};

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> frame: EffectFrame;
@group(0) @binding(3) var<uniform> params: EffectParams;
@group(0) @binding(4) var<storage, read> maskData: array<vec4f>;
// Stateful effects: their own output on the frame before (same size as the input).
@group(0) @binding(5) var previousTex: texture_2d<f32>;
// Tables (curves, baked to ${CURVE_SAMPLES} samples each) and the earlier pass's image (M10).
@group(0) @binding(6) var<storage, read> effectData: array<f32>;
@group(0) @binding(7) var prepassTex: texture_2d<f32>;
${curves}

const EFFECT_SPACE: u32 = ${SPACES[manifest.colourSpace]}u;

fn toLinear(c: vec3f) -> vec3f { return sign(c) * pow(abs(c), vec3f(${DISPLAY_GAMMA.toFixed(1)})); }
fn toDisplay(c: vec3f) -> vec3f { return sign(c) * pow(abs(c), vec3f(1.0 / ${DISPLAY_GAMMA.toFixed(1)})); }

// WGSL's pow is undefined for negative bases, so cube roots and cubes keep the sign by hand.
fn cbrtSigned(x: f32) -> f32 { return sign(x) * pow(abs(x), 1.0 / 3.0); }

fn toOklab(c: vec3f) -> vec3f {
  let l = cbrtSigned(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  let m = cbrtSigned(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  let s = cbrtSigned(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return vec3f(
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  );
}

fn fromOklab(c: vec3f) -> vec3f {
  let l0 = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m0 = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s0 = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  let l = l0 * l0 * l0;
  let m = m0 * m0 * m0;
  let s = s0 * s0 * s0;
  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  );
}

fn toSpace(c: vec3f) -> vec3f {
  if (EFFECT_SPACE == 1u) { return toLinear(c); }
  if (EFFECT_SPACE == 2u) { return toOklab(toLinear(c)); }
  return c;
}

fn fromSpace(c: vec3f) -> vec3f {
  if (EFFECT_SPACE == 1u) { return toDisplay(c); }
  if (EFFECT_SPACE == 2u) { return toDisplay(fromOklab(c)); }
  return c;
}

fn imageSize() -> vec2f { return frame.size; }

fn inputLoad(p: vec2i) -> vec4f {
  let c = textureLoad(inputTex, clamp(p, vec2i(0), vec2i(frame.size) - 1), 0);
  return vec4f(toSpace(c.rgb), c.a);
}

fn inputAt(px: vec2f) -> vec4f {
  let c = textureSampleLevel(inputTex, linearSampler, px / frame.size, 0.0);
  return vec4f(toSpace(c.rgb), c.a);
}

fn inputNearest(px: vec2f) -> vec4f { return inputLoad(vec2i(floor(px))); }

// A curve parameter at x (0-1): its table, read linearly between samples.
fn curveAt(index: u32, x: f32) -> f32 {
  let f = clamp(x, 0.0, 1.0) * f32(${CURVE_SAMPLES - 1});
  let i = min(u32(floor(f)), ${CURVE_SAMPLES - 2}u);
  let t = f - f32(i);
  let base = index * ${CURVE_SAMPLES}u + i;
  return mix(effectData[base], effectData[base + 1u], t);
}

// The image this pass writes (the input's size in the main pass), and the earlier pass's.
fn passSize() -> vec2i { return vec2i(frame.passes.xy + 0.5); }
fn prepassSize() -> vec2i { return vec2i(frame.passes.zw + 0.5); }
fn prepassLoad(p: vec2i) -> vec4f { return textureLoad(prepassTex, clamp(p, vec2i(0), prepassSize() - 1), 0); }

// The clock (M11): which sequence frame this is, and where it falls on the beat grid.
fn frameIndex() -> f32 { return frame.clock.x; }
fn beatPosition() -> f32 { return frame.clock.y; }
fn beatsPerFrame() -> f32 { return frame.clock.z; }
fn beatsPerBar() -> f32 { return frame.clock.w; }

fn hasPrevious() -> bool { return frame.temporal.x > 0.5; }
fn framesSinceReset() -> f32 { return frame.temporal.y; }

// The effect's output on the frame before, in its colour space; transparent outside the
// image, and everywhere on the first frame.
fn previousAt(px: vec2f) -> vec4f {
  if (!hasPrevious() || any(px < vec2f(0.0)) || any(px > frame.size)) { return vec4f(0.0); }
  let c = textureSampleLevel(previousTex, linearSampler, px / frame.size, 0.0);
  return vec4f(toSpace(c.rgb), c.a);
}

${blendSource}

${maskSource}

struct VsOut {
  @builtin(position) position: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VsOut;
  out.position = vec4f(corners[index], 0.0, 1.0);
  return out;
}
`
}

/** An earlier pass (M10): its shader writes one value per texel of its own image, in the effect's colour space. */
export function prepassShaderSource(manifest: EffectManifest, index: number): string {
  return `${prelude(manifest)}
// ---- ${manifest.name} pass ${index + 1} (src/effects/${manifest.id}) ----
${manifest.passes?.[index]?.shader ?? 'fn prepass(texel: vec2i) -> vec4f { return vec4f(0.0); }'}
// ----

@fragment
fn fsPrepass(in: VsOut) -> @location(0) vec4f {
  return prepass(vec2i(in.position.xy));
}
`
}

export function effectShaderSource(manifest: EffectManifest): string {
  return `${prelude(manifest)}
// ---- ${manifest.name} (src/effects/${manifest.id}) ----
${manifest.shader}
// ----

@fragment
fn fsEffect(in: VsOut) -> @location(0) vec4f {
  let src = textureLoad(inputTex, vec2i(in.position.xy), 0);
  let fx = effect(in.position.xy);
  let result = vec4f(fromSpace(fx.rgb), fx.a);
  let mode = u32(frame.blendMode + 0.5);
  var blended = result;
  if (mode != 0u) {
    blended = vec4f(mix(src.rgb, blendRgb(src.rgb, result.rgb, mode), result.a), src.a);
  }
  // The shared mask (M9) limits where the effect shows.
  var shown = 1.0;
  let parts = u32(frame.maskParts + 0.5);
  if (parts > 0u) {
    let p = in.position.xy;
    let fp = vec2f(frame.toFrame0.x * p.x + frame.toFrame0.z * p.y + frame.toFrame1.x, frame.toFrame0.y * p.x + frame.toFrame0.w * p.y + frame.toFrame1.y);
    shown = maskAlpha(fp, parts, frame.toFrame1.zw, frame.maskAa, maskLuma(src.rgb));
  }
  if (frame.maskInvert > 0.5) { shown = 1.0 - shown; }
  return mix(src, blended, clamp(frame.mixAmount, 0.0, 1.0) * shown);
}
`
}

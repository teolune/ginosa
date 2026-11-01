// Composites one layer over everything below it (the "destination" texture), with
// Motion, opacity and a blend mode. Values are display-referred (gamma-encoded),
// as in Photoshop and Premiere, so blend modes look the way editors expect.

struct Layer {
  inverse0: vec4f, // a, b, c, d of the sequence-pixel -> source-pixel transform
  inverse1: vec4f, // e, f, source width, source height (as displayed)
  params: vec4f,   // output pixels per sequence pixel, opacity (0-1), rotation quarter turns, blend mode
  colour: vec4f,   // decode (0 = values as stored, 1 = undo the Mac video display transform), conversion (0 none, 1 Apple Log, 2 LUT, 3 HLG, 4 PQ), LUT size, unused
  lutMin: vec4f,
  lutMax: vec4f,
  gamut0: vec4f,   // columns of the linear gamut matrix to Rec.709 (Apple Log conversions)
  gamut1: vec4f,
  gamut2: vec4f,
  maskTo0: vec4f,  // the layer's mask (M9): a, b, c, d of output pixel -> mask pixel
  maskTo1: vec4f,  // e, f, frame width, frame height
  mask: vec4f,     // shape count (0: no mask), edge softness, invert, unused
};

// How much of this layer shows at an output pixel (its mask; 1 without one). `luma` is the
// layer's own picture there (a clip) or what's beneath (an adjustment layer).
fn layerMask(pixel: vec2f, luma: f32) -> f32 {
  var shown = 1.0;
  let parts = u32(layer.mask.x + 0.5);
  if (parts > 0u) {
    let mp = vec2f(layer.maskTo0.x * pixel.x + layer.maskTo0.z * pixel.y + layer.maskTo1.x, layer.maskTo0.y * pixel.x + layer.maskTo0.w * pixel.y + layer.maskTo1.y);
    shown = maskAlpha(mp, parts, layer.maskTo1.zw, layer.mask.y, luma);
  }
  if (layer.mask.z > 0.5) { shown = 1.0 - shown; }
  return shown;
}

@group(0) @binding(0) var srcVideo: texture_external;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> layer: Layer;
@group(0) @binding(3) var dst: texture_2d<f32>;
@group(0) @binding(4) var srcImage: texture_2d<f32>;
@group(0) @binding(7) var lut: texture_3d<f32>;
// Layers' and adjustment layers' shared masks (mask.wgsl); the Layer carries their placement.
@group(0) @binding(8) var<storage, read> maskData: array<vec4f>;

// ---- Colour: working values are the file's own Rec.709 code values ----

fn srgbToLinear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

fn linearToSrgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, 12.92 * c, c <= vec3f(0.0031308));
}

// Chromium shows Rec.709 video the way macOS does (gamma 1.961, on an sRGB display).
const MAC_VIDEO_GAMMA = 1.961;

fn undoMacDisplay(c: vec3f) -> vec3f {
  return pow(max(srgbToLinear(c), vec3f(0.0)), vec3f(1.0 / MAC_VIDEO_GAMMA));
}

fn macDisplay(c: vec3f) -> vec3f {
  return linearToSrgb(pow(max(c, vec3f(0.0)), vec3f(MAC_VIDEO_GAMMA)));
}

// Apple Log Profile (Apple Log and Apple Log 2 share it): code value -> scene linear.
fn appleLogDecode(p: vec3f) -> vec3f {
  let R0 = -0.05641088;
  let Rt = 0.01;
  let c = 47.28711236;
  let beta = 0.00964052;
  let gamma = 0.08550479;
  let delta = 0.69336945;
  let pt = c * (Rt - R0) * (Rt - R0);
  let logPart = exp2((p - delta) / gamma) - beta;
  let toe = sqrt(max(p, vec3f(0.0)) / c) + R0;
  return select(select(vec3f(R0), toe, p >= vec3f(0.0)), logPart, p >= vec3f(pt));
}

fn shoulder(x: vec3f) -> vec3f {
  let knee = 0.5;
  return select(knee + (1.0 - knee) * (1.0 - exp(-(x - knee) / (1.0 - knee))), x, x <= vec3f(knee));
}

fn rec709Oetf(l: vec3f) -> vec3f {
  return select(1.099 * pow(l, vec3f(0.45)) - 0.099, 4.5 * l, l < vec3f(0.018));
}

// HDR (BT.2100 HLG or PQ, BT.2020) to Rec.709: the same maths as src/shared/colour/hdr-to-sdr.ts.
const HLG_A = 0.17883277;
const HLG_B = 0.28466892;
const HLG_C = 0.55991073;

fn hlgInverseOetf(e: vec3f) -> vec3f {
  return select((exp((e - HLG_C) / HLG_A) + HLG_B) / 12.0, e * e / 3.0, e <= vec3f(0.5));
}

fn pqEotfNits(e: vec3f) -> vec3f {
  let m1 = 2610.0 / 16384.0;
  let m2 = 2523.0 / 4096.0 * 128.0;
  let c1 = 3424.0 / 4096.0;
  let c2 = 2413.0 / 4096.0 * 32.0;
  let c3 = 2392.0 / 4096.0 * 32.0;
  let p = pow(max(e, vec3f(0.0)), vec3f(1.0 / m2));
  return 10000.0 * pow(max(p - c1, vec3f(0.0)) / (c2 - c3 * p), vec3f(1.0 / m1));
}

fn luma2020(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2627, 0.678, 0.0593));
}

fn hdrToSdr(v: vec3f, hlg: bool) -> vec3f {
  var linear: vec3f;
  if (hlg) {
    let scene = hlgInverseOetf(v);
    let gain = 1000.0 * pow(max(luma2020(scene), 1e-9), 0.2);
    linear = scene * gain / 203.0;
  } else {
    linear = pqEotfNits(v) / 203.0;
  }
  let y = luma2020(linear);
  var rolled = y;
  if (y > 0.75) { rolled = 0.75 + 0.25 * (1.0 - exp(-(y - 0.75) / 0.25)); }
  let toned = select(vec3f(0.0), linear * (rolled / y), y > 0.0);
  let out = vec3f(
    dot(toned, vec3f(1.6605, -0.5876, -0.0728)),
    dot(toned, vec3f(-0.1246, 1.1329, -0.0083)),
    dot(toned, vec3f(-0.0182, -0.1006, 1.1187))
  );
  return pow(clamp(out, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.4));
}

fn inputColour(stored: vec3f) -> vec3f {
  var v = stored;
  if (layer.colour.x > 0.5) { v = undoMacDisplay(v); }
  let conversion = u32(layer.colour.y + 0.5);
  if (conversion == 1u) {
    let gamut = mat3x3f(layer.gamut0.xyz, layer.gamut1.xyz, layer.gamut2.xyz);
    v = rec709Oetf(shoulder(max(gamut * appleLogDecode(v), vec3f(0.0))));
  } else if (conversion == 2u) {
    let n = layer.colour.z;
    let t = clamp((v - layer.lutMin.xyz) / (layer.lutMax.xyz - layer.lutMin.xyz), vec3f(0.0), vec3f(1.0));
    v = textureSampleLevel(lut, srcSampler, t * (n - 1.0) / n + 0.5 / n, 0.0).rgb;
  } else if (conversion == 3u || conversion == 4u) {
    v = hdrToSdr(v, conversion == 3u);
  }
  return v;
}

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let p = corners[index];
  var out: VsOut;
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = vec2f((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
  return out;
}

// Source pixel (as displayed) for this output pixel.
fn sourcePixel(pixel: vec2f) -> vec2f {
  let p = pixel / layer.params.x;
  return vec2f(
    layer.inverse0.x * p.x + layer.inverse0.z * p.y + layer.inverse1.x,
    layer.inverse0.y * p.x + layer.inverse0.w * p.y + layer.inverse1.y
  );
}

// Display uv -> stored (coded) uv for rotation metadata, in clockwise quarter turns.
fn codedUv(uv: vec2f, quarters: f32) -> vec2f {
  let q = u32(quarters + 0.5) % 4u;
  if (q == 1u) { return vec2f(uv.y, 1.0 - uv.x); }
  if (q == 2u) { return vec2f(1.0 - uv.x, 1.0 - uv.y); }
  if (q == 3u) { return vec2f(1.0 - uv.y, uv.x); }
  return uv;
}

fn composite(pixel: vec2f, src: vec4f, s: vec2f) -> vec4f {
  let below = textureLoad(dst, vec2i(pixel), 0);
  let size = layer.inverse1.zw;
  // Soft, one-pixel edges so rotated or scaled layers don't look jagged.
  let edge = min(min(s.x, s.y), min(size.x - s.x, size.y - s.y));
  let perPixel = max(max(fwidth(s.x), fwidth(s.y)), 1e-4);
  let coverage = clamp(edge / perPixel + 0.5, 0.0, 1.0);
  let mode = u32(layer.params.w + 0.5);
  let blended = blendRgb(below.rgb, src.rgb, mode);
  let alpha = clamp(src.a * layer.params.y * coverage * layerMask(pixel, maskLuma(src.rgb)), 0.0, 1.0);
  return vec4f(mix(below.rgb, blended, alpha), 1.0);
}

@fragment
fn fsVideo(in: VsOut) -> @location(0) vec4f {
  let s = sourcePixel(in.position.xy);
  let uv = codedUv(clamp(s / layer.inverse1.zw, vec2f(0.0), vec2f(1.0)), layer.params.z);
  let sampled = textureSampleBaseClampToEdge(srcVideo, srcSampler, uv);
  return composite(in.position.xy, vec4f(inputColour(sampled.rgb), sampled.a), s);
}

@fragment
fn fsImage(in: VsOut) -> @location(0) vec4f {
  let s = sourcePixel(in.position.xy);
  let uv = clamp(s / layer.inverse1.zw, vec2f(0.0), vec2f(1.0));
  let sampled = textureSampleLevel(srcImage, srcSampler, uv, 0.0);
  return composite(in.position.xy, vec4f(inputColour(sampled.rgb), sampled.a), s);
}

// A clip with effects is first drawn at its own size (decoded, colour-converted,
// rotation applied), so its effects run on its own pixels before Motion places it.
@fragment
fn fsSourceVideo(in: VsOut) -> @location(0) vec4f {
  let sampled = textureSampleBaseClampToEdge(srcVideo, srcSampler, codedUv(in.uv, layer.params.z));
  return vec4f(inputColour(sampled.rgb), sampled.a);
}

@fragment
fn fsSourceImage(in: VsOut) -> @location(0) vec4f {
  let sampled = textureSampleLevel(srcImage, srcSampler, in.uv, 0.0);
  return vec4f(inputColour(sampled.rgb), sampled.a);
}

// An adjustment layer: its effects' result (srcImage, the size of the frame) blended
// onto everything beneath with the layer's opacity and blend mode. Transparent parts
// of the result (e.g. a Transform shrinking the frame) count as black.
@fragment
fn fsAdjust(in: VsOut) -> @location(0) vec4f {
  let below = textureLoad(dst, vec2i(in.position.xy), 0);
  let fx = textureLoad(srcImage, vec2i(in.position.xy), 0);
  let mode = u32(layer.params.w + 0.5);
  let blended = blendRgb(below.rgb, fx.rgb * fx.a, mode);
  return vec4f(mix(below.rgb, blended, clamp(layer.params.y, 0.0, 1.0) * layerMask(in.position.xy, maskLuma(below.rgb))), 1.0);
}

// Final copy of the composite to the screen (or an export target).
@group(0) @binding(5) var finalTex: texture_2d<f32>;
@group(0) @binding(6) var finalSampler: sampler;

// The composite as it is (no display transform), for preview files (M9).
@fragment
fn fsCopy(in: VsOut) -> @location(0) vec4f {
  let c = textureSampleLevel(finalTex, finalSampler, in.uv, 0.0);
  return vec4f(c.rgb, 1.0);
}

@fragment
fn fsPresent(in: VsOut) -> @location(0) vec4f {
  // On screen, Rec.709 is shown the way QuickTime shows the exported file.
  let c = textureSampleLevel(finalTex, finalSampler, in.uv, 0.0);
  return vec4f(macDisplay(c.rgb), 1.0);
}

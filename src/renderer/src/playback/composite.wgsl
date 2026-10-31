// Composites one layer over everything below it (the "destination" texture), with
// Motion, opacity and a blend mode. Values are display-referred (gamma-encoded),
// as in Photoshop and Premiere, so blend modes look the way editors expect.

struct Layer {
  inverse0: vec4f, // a, b, c, d of the sequence-pixel -> source-pixel transform
  inverse1: vec4f, // e, f, source width, source height (as displayed)
  params: vec4f,   // output pixels per sequence pixel, opacity (0-1), rotation quarter turns, blend mode
};

@group(0) @binding(0) var srcVideo: texture_external;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> layer: Layer;
@group(0) @binding(3) var dst: texture_2d<f32>;
@group(0) @binding(4) var srcImage: texture_2d<f32>;

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

fn softLight(d: f32, s: f32) -> f32 {
  if (s <= 0.5) { return d - (1.0 - 2.0 * s) * d * (1.0 - d); }
  var g: f32;
  if (d <= 0.25) { g = ((16.0 * d - 12.0) * d + 4.0) * d; } else { g = sqrt(d); }
  return d + (2.0 * s - 1.0) * (g - d);
}

fn blendChannel(d: f32, s: f32, mode: u32) -> f32 {
  switch (mode) {
    case 1u: { return min(d, s); }                                   // darken
    case 2u: { return d * s; }                                       // multiply
    case 3u: { if (d >= 1.0) { return 1.0; } if (s <= 0.0) { return 0.0; } return 1.0 - min(1.0, (1.0 - d) / s); } // color burn
    case 4u: { return max(d, s); }                                   // lighten
    case 5u: { return 1.0 - (1.0 - d) * (1.0 - s); }                 // screen
    case 6u: { if (d <= 0.0) { return 0.0; } if (s >= 1.0) { return 1.0; } return min(1.0, d / (1.0 - s)); } // color dodge
    case 7u: { return min(1.0, d + s); }                             // linear dodge (add)
    case 8u: { if (d <= 0.5) { return 2.0 * d * s; } return 1.0 - 2.0 * (1.0 - d) * (1.0 - s); } // overlay
    case 9u: { return softLight(d, s); }                             // soft light
    case 10u: { if (s <= 0.5) { return 2.0 * d * s; } return 1.0 - 2.0 * (1.0 - d) * (1.0 - s); } // hard light
    case 11u: { return abs(d - s); }                                 // difference
    case 12u: { return d + s - 2.0 * d * s; }                        // exclusion
    default: { return s; }                                           // normal
  }
}

fn composite(pixel: vec2f, src: vec4f, s: vec2f) -> vec4f {
  let below = textureLoad(dst, vec2i(pixel), 0);
  let size = layer.inverse1.zw;
  // Soft, one-pixel edges so rotated or scaled layers don't look jagged.
  let edge = min(min(s.x, s.y), min(size.x - s.x, size.y - s.y));
  let perPixel = max(max(fwidth(s.x), fwidth(s.y)), 1e-4);
  let coverage = clamp(edge / perPixel + 0.5, 0.0, 1.0);
  let mode = u32(layer.params.w + 0.5);
  let blended = vec3f(
    blendChannel(below.r, src.r, mode),
    blendChannel(below.g, src.g, mode),
    blendChannel(below.b, src.b, mode)
  );
  let alpha = clamp(src.a * layer.params.y * coverage, 0.0, 1.0);
  return vec4f(mix(below.rgb, blended, alpha), 1.0);
}

@fragment
fn fsVideo(in: VsOut) -> @location(0) vec4f {
  let s = sourcePixel(in.position.xy);
  let uv = codedUv(clamp(s / layer.inverse1.zw, vec2f(0.0), vec2f(1.0)), layer.params.z);
  let src = textureSampleBaseClampToEdge(srcVideo, srcSampler, uv);
  return composite(in.position.xy, src, s);
}

@fragment
fn fsImage(in: VsOut) -> @location(0) vec4f {
  let s = sourcePixel(in.position.xy);
  let uv = clamp(s / layer.inverse1.zw, vec2f(0.0), vec2f(1.0));
  let src = textureSampleLevel(srcImage, srcSampler, uv, 0.0);
  return composite(in.position.xy, src, s);
}

// Final copy of the composite to the screen (or an export target).
@group(0) @binding(5) var finalTex: texture_2d<f32>;
@group(0) @binding(6) var finalSampler: sampler;

@fragment
fn fsPresent(in: VsOut) -> @location(0) vec4f {
  let c = textureSampleLevel(finalTex, finalSampler, in.uv, 0.0);
  return vec4f(c.rgb, 1.0);
}

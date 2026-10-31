// The Photoshop blend modes on display values, shared by clip compositing and every
// effect's Mix/Blend. Mode numbers follow BLEND_MODES in model.ts (a test checks).
// d = what's beneath, s = what's blended onto it. Mirrors engine/effects/blend.ts.

fn blendColorBurn(d: f32, s: f32) -> f32 {
  if (d >= 1.0) { return 1.0; }
  if (s <= 0.0) { return 0.0; }
  return 1.0 - min(1.0, (1.0 - d) / s);
}

fn blendColorDodge(d: f32, s: f32) -> f32 {
  if (d <= 0.0) { return 0.0; }
  if (s >= 1.0) { return 1.0; }
  return min(1.0, d / (1.0 - s));
}

fn blendSoftLight(d: f32, s: f32) -> f32 {
  if (s <= 0.5) { return d - (1.0 - 2.0 * s) * d * (1.0 - d); }
  var g: f32;
  if (d <= 0.25) { g = ((16.0 * d - 12.0) * d + 4.0) * d; } else { g = sqrt(d); }
  return d + (2.0 * s - 1.0) * (g - d);
}

fn blendVividLight(d: f32, s: f32) -> f32 {
  if (s <= 0.5) { return blendColorBurn(d, 2.0 * s); }
  return blendColorDodge(d, 2.0 * (s - 0.5));
}

fn blendChannel(d: f32, s: f32, mode: u32) -> f32 {
  switch (mode) {
    case 1u: { return min(d, s); }                                               // darken
    case 2u: { return d * s; }                                                   // multiply
    case 3u: { return blendColorBurn(d, s); }                                    // color-burn
    case 4u: { return max(d, s); }                                               // lighten
    case 5u: { return 1.0 - (1.0 - d) * (1.0 - s); }                             // screen
    case 6u: { return blendColorDodge(d, s); }                                   // color-dodge
    case 7u: { return min(1.0, d + s); }                                         // add
    case 8u: { if (d <= 0.5) { return 2.0 * d * s; } return 1.0 - 2.0 * (1.0 - d) * (1.0 - s); } // overlay
    case 9u: { return blendSoftLight(d, s); }                                    // soft-light
    case 10u: { if (s <= 0.5) { return 2.0 * d * s; } return 1.0 - 2.0 * (1.0 - d) * (1.0 - s); } // hard-light
    case 11u: { return abs(d - s); }                                             // difference
    case 12u: { return d + s - 2.0 * d * s; }                                    // exclusion
    case 13u: { return max(0.0, d + s - 1.0); }                                  // linear-burn
    case 14u: { return blendVividLight(d, s); }                                  // vivid-light
    case 15u: { return clamp(d + 2.0 * s - 1.0, 0.0, 1.0); }                     // linear-light
    case 16u: { if (s <= 0.5) { return min(d, 2.0 * s); } return max(d, 2.0 * s - 1.0); } // pin-light
    case 17u: { return select(0.0, 1.0, d + s >= 1.0); }                         // hard-mix
    case 18u: { return max(0.0, d - s); }                                        // subtract
    case 19u: { if (s <= 0.0) { return select(0.0, 1.0, d > 0.0); } return min(1.0, d / s); } // divide
    default: { return s; }                                                       // normal
  }
}

// Non-separable modes (W3C Compositing and Blending, section 10.2).
fn blendLum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.3, 0.59, 0.11));
}

fn blendClipColor(c0: vec3f) -> vec3f {
  var c = c0;
  let l = blendLum(c);
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  if (n < 0.0) { c = l + (c - l) * l / max(l - n, 1e-6); }
  if (x > 1.0) { c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6); }
  return c;
}

fn blendSetLum(c: vec3f, l: f32) -> vec3f {
  return blendClipColor(c + (l - blendLum(c)));
}

fn blendSat(c: vec3f) -> f32 {
  return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
}

fn blendSetSat(c: vec3f, s: f32) -> vec3f {
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  if (x <= n) { return vec3f(0.0); }
  return (c - n) * s / (x - n);
}

fn blendRgb(d: vec3f, s: vec3f, mode: u32) -> vec3f {
  switch (mode) {
    case 20u: { return blendSetLum(blendSetSat(s, blendSat(d)), blendLum(d)); } // hue
    case 21u: { return blendSetLum(blendSetSat(d, blendSat(s)), blendLum(d)); } // saturation
    case 22u: { return blendSetLum(s, blendLum(d)); }                          // color
    case 23u: { return blendSetLum(d, blendLum(s)); }                          // luminosity
    default: {
      return vec3f(blendChannel(d.r, s.r, mode), blendChannel(d.g, s.g, mode), blendChannel(d.b, s.b, mode));
    }
  }
}

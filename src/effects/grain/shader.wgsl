// Grain: the lattice noise interpolated at each pixel (the grain with Gaussian weights over
// the 4 x 4 nearest points, the clumps bilinearly; each scaled so its strength is the same
// everywhere), weighted by the picture's brightness and composited. Mirrors reference.ts.

fn latticeComponent(t: vec4f, component: u32) -> f32 {
  if (component == 1u) { return t.x; }
  if (component == 2u) { return t.y; }
  if (component == 3u) { return t.z; }
  return t.w;
}

fn grainAt(px: vec2f, component: u32) -> f32 {
  let h = grainSpacing(component);
  let u = px / h + 1.0;
  let base = vec2i(floor(u)) - 1;
  let sigma = 0.25 + 0.35 * clamp(params.softness / 100.0, 0.0, 1.0);
  let k = -0.5 / (sigma * sigma);
  var wx: array<f32, 4>;
  var wy: array<f32, 4>;
  for (var a = 0; a < 4; a++) {
    let dx = u.x - f32(base.x + a);
    let dy = u.y - f32(base.y + a);
    wx[a] = exp(k * dx * dx);
    wy[a] = exp(k * dy * dy);
  }
  var sum = 0.0;
  var squares = 0.0;
  for (var b = 0; b < 4; b++) {
    for (var a = 0; a < 4; a++) {
      let w = wx[a] * wy[b];
      sum += w * latticeComponent(prepassLoad(base + vec2i(a, b)), component);
      squares += w * w;
    }
  }
  let fine = sum / sqrt(squares);
  // The coarse lattice, in the right half of the pass's image.
  let half = prepassSize().x / 2;
  let c = px / (GRAIN_COARSE * h) + 1.0;
  let c0 = vec2i(floor(c));
  let f = c - floor(c);
  let n00 = latticeComponent(prepassLoad(vec2i(half + c0.x, c0.y)), component);
  let n10 = latticeComponent(prepassLoad(vec2i(half + c0.x + 1, c0.y)), component);
  let n01 = latticeComponent(prepassLoad(vec2i(half + c0.x, c0.y + 1)), component);
  let n11 = latticeComponent(prepassLoad(vec2i(half + c0.x + 1, c0.y + 1)), component);
  let g = (1.0 - f) * (1.0 - f) + f * f;
  let coarse = mix(mix(n00, n10, f.x), mix(n01, n11, f.x), f.y) / sqrt(g.x * g.y);
  return (fine + GRAIN_COARSE_WEIGHT * coarse) / sqrt(1.0 + GRAIN_COARSE_WEIGHT * GRAIN_COARSE_WEIGHT);
}

fn effect(px: vec2f) -> vec4f {
  let src = inputAt(px);
  let k = grainColourAmount();
  var g = vec3f(0.0);
  if (k < 1.0) { g = vec3f(grainAt(px, 0u) * sqrt(1.0 - k)); }
  if (k > 0.0) { g += vec3f(grainAt(px, 1u), grainAt(px, 2u), grainAt(px, 3u)) * sqrt(k); }
  let y = clamp(dot(clamp(src.rgb, vec3f(0.0), vec3f(1.0)), vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  let w = params.shadows / 100.0 * (1.0 - y) * (1.0 - y) + params.midtones / 100.0 * 2.0 * y * (1.0 - y) + params.highlights / 100.0 * y * y;
  let amount = params.amount / 100.0;
  let mode = u32(params.composite + 0.5);
  if (mode == 2u) {
    return vec4f(clamp(vec3f(0.5) + 0.5 * amount * g * w, vec3f(0.0), vec3f(1.0)), src.a);
  }
  let lin = toLinear(max(src.rgb, vec3f(0.0)));
  var out: vec3f;
  if (mode == 1u) {
    out = max(lin + amount * (0.4 * sqrt(lin) + 0.02) * g * w, vec3f(0.0));
  } else {
    out = lin * exp2(amount * g * w);
  }
  return vec4f(toDisplay(out), src.a);
}

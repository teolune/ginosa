// Grain: the maths the lattice pass and the main pass share. Mirrors maths.ts.

const GRAIN_TAU: f32 = 6.28318530718;
const GRAIN_COARSE: f32 = 2.5;
const GRAIN_COARSE_WEIGHT: f32 = 0.5;

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn hash4(a: u32, b: u32, c: u32, d: u32) -> u32 { return pcg(a + pcg(b + pcg(c + pcg(d)))); }

fn uniform01(h: u32) -> f32 { return (f32(h >> 8u) + 0.5) / 16777216.0; }

fn gaussian(h: u32) -> f32 {
  return sqrt(-2.0 * log(uniform01(h))) * cos(GRAIN_TAU * uniform01(pcg(h)));
}

fn grainSalt(component: u32, layer: u32) -> u32 { return u32(floor(params.seed + 0.5)) * 64u + component * 4u + layer; }

fn latticeNoise(i: i32, j: i32, k: i32, component: u32, layer: u32) -> f32 {
  return gaussian(hash4(bitcast<u32>(i), bitcast<u32>(j), bitcast<u32>(k), grainSalt(component, layer)));
}

fn grainRefresh() -> i32 {
  let mode = u32(params.refresh + 0.5);
  if (mode == 1u) { return i32(floor(frameIndex() / max(floor(params.every + 0.5), 1.0))); }
  if (mode == 2u) { return i32(floor((beatPosition() + beatsPerFrame() * 0.5) / grainNoteBeats(u32(params.note + 0.5)))); }
  return i32(frameIndex());
}

fn boiledNoise(i: i32, j: i32, component: u32, layer: u32) -> f32 {
  let tau = f32(grainRefresh()) * clamp(params.boil / 100.0, 0.0, 1.0);
  let k0 = floor(tau);
  let f = tau - k0;
  let a = latticeNoise(i, j, i32(k0), component, layer);
  if (f <= 0.0) { return a; }
  let b = latticeNoise(i, j, i32(k0) + 1, component, layer);
  return cos(f * GRAIN_TAU * 0.25) * a + sin(f * GRAIN_TAU * 0.25) * b;
}

// Pixels per lattice step: mono (0), red, green, blue.
fn grainSpacing(component: u32) -> f32 {
  let base = max(params.size, 0.05) * imageSize().y / 1080.0;
  if (component == 1u) { return base * params.redSize / 100.0; }
  if (component == 2u) { return base * params.greenSize / 100.0; }
  if (component == 3u) { return base * params.blueSize / 100.0; }
  return base;
}

fn grainFinestSpacing() -> f32 {
  let k = grainColourAmount();
  var h = 1e9;
  if (k < 1.0) { h = grainSpacing(0u); }
  if (k > 0.0) { h = min(h, min(grainSpacing(1u), min(grainSpacing(2u), grainSpacing(3u)))); }
  return h;
}

fn grainColourAmount() -> f32 {
  if (u32(params.grainType + 0.5) == 1u) { return clamp(params.colourAmount / 100.0, 0.0, 1.0); }
  return 0.0;
}

// Pass 2: coarse motion, at quarter size, one vector per 16-pixel block: the 24-pixel patch
// around each block is looked for in the frame before, everywhere up to 16 pixels away and
// around where the motion was last frame (so steady fast motion is followed).
// Vectors are where the block is fetched from, in full-size pixels.
const COARSE_RANGE: i32 = 4;
const FOOT: i32 = 6;

fn patchCost(v: Level, origin: vec2i, now: ptr<function, array<f32, 36>>, d: vec2i) -> f32 {
  var sum = 0.0;
  for (var i = 0; i < FOOT * FOOT; i++) { sum += abs((*now)[i] - lumaBefore(v, origin + vec2i(i % FOOT, i / FOOT) + d)); }
  return sum / f32(FOOT * FOOT) + MOVE_COST * length(vec2f(d));
}

fn prepass(texel: vec2i) -> vec4f {
  if (!hasPrevious()) { return vec4f(0.0); }
  let v = level(2u);
  let centre = (vec2f(texel) + 0.5) * coarseBlockPx();
  let origin = vec2i(floor(centre / 4.0)) - FOOT / 2;
  var now: array<f32, 36>;
  for (var i = 0; i < FOOT * FOOT; i++) { now[i] = lumaNow(v, origin + vec2i(i % FOOT, i / FOOT)); }
  var best = vec2i(0);
  var bestCost = 1e9;
  for (var dy = -COARSE_RANGE; dy <= COARSE_RANGE; dy++) {
    for (var dx = -COARSE_RANGE; dx <= COARSE_RANGE; dx++) {
      let d = vec2i(dx, dy);
      let cost = patchCost(v, origin, &now, d);
      if (cost < bestCost) {
        bestCost = cost;
        best = d;
      }
    }
  }
  // Last frame's motion here (kept by the shaping pass), and around it.
  let kept = keptSize(1u) - vec2i(0, 1);
  if (kept.x > 1 && kept.y > 1) {
    let last = vec2i(round(keptLoad(1u, vec2i(floor(centre / frame.size * vec2f(kept)))).zw / 4.0));
    for (var i = 0; i < 9; i++) {
      let d = last + vec2i(i % 3 - 1, i / 3 - 1);
      let cost = patchCost(v, origin, &now, d);
      if (cost < bestCost) {
        bestCost = cost;
        best = d;
      }
    }
  }
  return vec4f(vec2f(best) * 4.0, bestCost, 1.0);
}

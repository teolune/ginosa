// Pass 5: the motion shaped into how far each block of the mosh buffer moves this frame
// (kept for the next frame, slot 1). The last row holds the effect's running counts:
// frames since the last reset, the reset trigger's value, bloom frames left, the bloom
// trigger's value (each compared with the frame before's, so a trigger fires once as it
// crosses 50%).
fn beatReset() -> bool {
  let every = u32(params.every + 0.5);
  if (every == 0u) { return false; }
  var period = 1.0;
  if (every == 2u) { period = 2.0; }
  if (every == 3u) { period = beatsPerBar(); }
  if (every == 4u) { period = 2.0 * beatsPerBar(); }
  if (every == 5u) { period = 4.0 * beatsPerBar(); }
  if (every == 6u) { period = 8.0 * beatsPerBar(); }
  let now = beatPosition();
  return floor(now / period + 1e-4) != floor((now - beatsPerFrame()) / period + 1e-4);
}

fn previousField(texel: vec2i, grid: vec2i) -> vec2f {
  let kept = keptSize(1u) - vec2i(0, 1);
  // The same place in the frame before's grid (it differs if the block size changed).
  let p = vec2i(floor((vec2f(texel) + 0.5) * vec2f(kept) / vec2f(grid)));
  return keptLoad(1u, p).zw;
}

fn roundTo(v: vec2f, step: f32) -> vec2f {
  if (step <= 0.0) { return v; }
  return round(v / step) * step;
}

fn prepass(texel: vec2i) -> vec4f {
  let grid = passSize() - vec2i(0, 1);
  let first = !hasPrevious();
  let before = keptLoad(1u, vec2i(0, keptSize(1u).y - 1));
  let triggered = !first && before.y < 50.0 && params.resetTrigger >= 50.0;
  let cut = params.onCuts > 0.5 && framesSinceCut() < 0.5 && framesSinceReset() > 0.5;
  let reset = first || cut || triggered || beatReset();
  let since = select(before.x + 1.0, 0.0, reset);
  let bloomStart = !first && before.w < 50.0 && params.bloomTrigger >= 50.0;
  let bloomLeft = select(max(before.z - 1.0, 0.0), params.bloomFrames, bloomStart);
  if (texel.y >= grid.y) { return vec4f(since, params.resetTrigger, bloomLeft, params.bloomTrigger); }
  if (first) { return vec4f(0.0); }

  // Measured motion, smoothed with its neighbours (Fluid), scaled (Speed), with Swirl and Push.
  let measured = prepassLoad(texel);
  var v = measured.xy;
  if (params.smoothing > 0.0) {
    var sum = vec2f(0.0);
    for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) { sum += prepassLoad(clamp(texel + vec2i(x, y), vec2i(0), grid - 1)).xy; } }
    v = mix(v, sum / 9.0, params.smoothing / 100.0);
  }
  v = v * params.speed / 100.0;
  let b = blockPx();
  let r = (vec2f(texel) + 0.5) * b - frame.size * 0.5;
  v += vec2f(-r.y, r.x) * (params.swirl / 100.0) * 0.02;
  // A vector says where a block is fetched from, so pushing the picture right fetches from the left.
  v -= vec2f(params.pushX, params.pushY) * heightScale();

  // Momentum and Repeat Motion carry the field on; a bloom holds it.
  let previous = previousField(texel, grid);
  if (!reset) {
    v = mix(v, previous, params.momentum / 100.0);
    v = mix(v, previous, select(params.repeatMotion / 100.0, 1.0, bloomLeft > 0.5));
  }
  let field = v;

  // How far the block moves: Strength, nothing while frozen, then the codec's character.
  var d = field * params.strength / 100.0;
  if (since <= params.freeze) { d = vec2f(0.0); }
  // A cut that doesn't reset (Reset on Cuts off) holds for its first frame, as a codec does when
  // the cut's keyframe is removed: the motion measured across a cut means nothing.
  let atCut = framesSinceCut() < 0.5;
  if (atCut) { d = vec2f(0.0); }
  if (blockRandom(texel, 1u) < params.wrongMatches / 100.0) {
    // A wrong match: another block's motion, a little off, as an encoder's bad guess.
    let o = vec2i(floor(vec2f(blockRandom(texel, 2u), blockRandom(texel, 3u)) * 7.0)) - 3;
    let other = prepassLoad(clamp(texel + o, vec2i(0), grid - 1)).xy;
    d = other * params.strength / 100.0 + (vec2f(blockRandom(texel, 4u), blockRandom(texel, 5u)) - 0.5) * b;
  }
  let rounding = u32(params.rounding + 0.5);
  if (rounding == 1u) { d = roundTo(d, 0.5); }
  if (rounding == 2u) { d = roundTo(d, 1.0); }
  if (rounding == 3u) { d = roundTo(d, 2.0); }
  // Intra Blocks: a block the motion can't explain is coded afresh, as an encoder does: the real
  // frame shows there. At 50%, the usual encoder rule: when matching it costs more than its own
  // detail plus 2 levels in 255 (MPEG-4's reference encoder: SAD > deviation + 512 per 16 × 16).
  let intra = params.intra / 100.0;
  if (intra > 0.0 && since > params.freeze && !atCut && measured.z > (measured.w + 2.0 / 255.0) * 2.0 * (1.0 - intra)) { d = vec2f(INTRA, 0.0); }
  return vec4f(d, field);
}

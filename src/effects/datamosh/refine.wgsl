// Passes 3 and 4: the motion refined at half size, then full size, for the chosen block size
// (a coarse vector is good to 2 pixels, a half-size one to 1, so one pixel either way at each).
// A block's own pixels (at most 8 × 8 samples of them) are compared with the frame before
// at each candidate: the starting guesses, then every vector within `range` of the best.
// Each block's result: its vector, the cost of the match, and the block's own detail.
struct Block { v: Level, origin: vec2i, step: i32, count: i32, scale: f32 }

fn blockAt(l: u32, texel: vec2i) -> Block {
  let scale = f32(1 << l);
  let size = max(2, i32(blockPx() / scale));
  let step = max(1, size / 8);
  return Block(level(l), vec2i(floor(vec2f(texel) * blockPx() / scale)), step, (size + step - 1) / step, scale);
}

fn costOf(b: Block, now: ptr<function, array<f32, 64>>, d: vec2i) -> f32 {
  var sum = 0.0;
  for (var i = 0; i < b.count * b.count; i++) {
    let p = b.origin + vec2i(i % b.count, i / b.count) * b.step;
    sum += abs((*now)[i] - lumaBefore(b.v, p + d));
  }
  return sum / f32(b.count * b.count) + MOVE_COST * length(vec2f(d));
}

fn refine(l: u32, texel: vec2i, guesses: ptr<function, array<vec2f, 9>>, guessCount: i32, range: i32) -> vec4f {
  if (!hasPrevious()) { return vec4f(0.0); }
  let b = blockAt(l, texel);
  var now: array<f32, 64>;
  for (var i = 0; i < b.count * b.count; i++) { now[i] = lumaNow(b.v, b.origin + vec2i(i % b.count, i / b.count) * b.step); }
  // Every vector within `range` of each different guess, and of no motion at all (so a wrong
  // guess can't stick, and a slightly-off right one isn't beaten by a lucky wrong one).
  var best = vec2i(0);
  var bestCost = costOf(b, &now, best);
  for (var g = -1; g < guessCount; g++) {
    var centre = vec2i(0);
    if (g >= 0) { centre = vec2i(round((*guesses)[g] / b.scale)); }
    var seen = false;
    for (var h = 0; h < g; h++) { if (all(vec2i(round((*guesses)[h] / b.scale)) == centre)) { seen = true; } }
    if (g >= 0 && (seen || all(centre == vec2i(0)))) { continue; }
    for (var dy = -range; dy <= range; dy++) {
      for (var dx = -range; dx <= range; dx++) {
        let d = centre + vec2i(dx, dy);
        let cost = costOf(b, &now, d);
        if (cost < bestCost) {
          bestCost = cost;
          best = d;
        }
      }
    }
  }
  // The block's own detail: how far its pixels are from their mean (an encoder's intra cost).
  let n = b.count * b.count;
  var mean = 0.0;
  for (var i = 0; i < n; i++) { mean += now[i]; }
  mean /= f32(n);
  var detail = 0.0;
  for (var i = 0; i < n; i++) { detail += abs(now[i] - mean); }
  return vec4f(vec2f(best) * b.scale, bestCost, detail / f32(n));
}

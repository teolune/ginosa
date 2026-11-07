// Pass 1: the luma pyramid (kept for the next frame, slot 0): this frame's luma in x
// (level 1 averages 2 × 2 pixels, level 2 averages 4 × 4), the frame before's in y. With a
// Motion Source track, its picture's luma instead of the input's (motion transfer). At full
// size z and w hold this frame's Cb and Cr too, so the next frame can work out the residual.
fn prepass(texel: vec2i) -> vec4f {
  let h0 = levelSize(0u).y;
  let h1 = levelSize(1u).y;
  var l = 0u;
  var row = texel.y;
  if (row >= h0 + h1) {
    l = 2u;
    row = row - h0 - h1;
  } else if (row >= h0) {
    l = 1u;
    row = row - h0;
  }
  let before = keptLoad(0u, texel).x;
  let s = levelSize(l);
  if (texel.x >= s.x || row >= s.y) { return vec4f(0.0, before, 0.0, 1.0); }
  if (l == 0u) {
    let c = motionSourceLoad(vec2i(texel.x, row)).rgb;
    let y = dot(c, LUMA_W);
    return vec4f(y, before, (c.b - y) / 1.8556, (c.r - y) / 1.5748);
  }
  let n = 1 << l;
  var sum = 0.0;
  for (var dy = 0; dy < n; dy++) {
    for (var dx = 0; dx < n; dx++) {
      sum += dot(motionSourceLoad(vec2i(texel.x * n + dx, row * n + dy)).rgb, LUMA_W);
    }
  }
  return vec4f(sum / f32(n * n), before, 0.0, 1.0);
}

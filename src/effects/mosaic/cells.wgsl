// Mosaic pass 2: for each cell, the mean of pass 1's rows inside it (weighted by coverage):
// the cell's average colour, premultiplied, in linear light. Mirrors reference.ts.

fn prepass(texel: vec2i) -> vec4f {
  let cell = mosaicCell();
  let start = mosaicStart(imageSize().y, f32(passSize().y), cell.y);
  let lo = max(start + f32(texel.y) * cell.y, 0.0);
  let hi = min(start + f32(texel.y + 1) * cell.y, imageSize().y);
  if (hi <= lo) { return vec4f(0.0); }
  if (mosaicCentre()) {
    return prepassLoad(vec2i(texel.x, i32(floor((lo + hi) * 0.5 + MOSAIC_BIAS))));
  }
  var sum = vec4f(0.0);
  for (var y = i32(floor(lo)); y < i32(ceil(hi)); y++) {
    let w = min(f32(y + 1), hi) - max(f32(y), lo);
    sum += prepassLoad(vec2i(texel.x, y)) * w;
  }
  return sum / (hi - lo);
}

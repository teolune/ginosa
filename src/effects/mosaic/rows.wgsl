// Mosaic pass 1: for each cell column and pixel row, the mean of the row's pixels inside the
// column (weighted by how much of each pixel is inside), premultiplied, in linear light.
// Mirrors reference.ts.

fn prepass(texel: vec2i) -> vec4f {
  let cell = mosaicCell();
  let start = mosaicStart(imageSize().x, f32(passSize().x), cell.x);
  let lo = max(start + f32(texel.x) * cell.x, 0.0);
  let hi = min(start + f32(texel.x + 1) * cell.x, imageSize().x);
  if (hi <= lo) { return vec4f(0.0); }
  if (mosaicCentre()) {
    let c = inputLoad(vec2i(i32(floor((lo + hi) * 0.5 + MOSAIC_BIAS)), texel.y));
    return vec4f(c.rgb * c.a, c.a);
  }
  var sum = vec4f(0.0);
  for (var x = i32(floor(lo)); x < i32(ceil(hi)); x++) {
    let w = min(f32(x + 1), hi) - max(f32(x), lo);
    let c = inputLoad(vec2i(x, texel.y));
    sum += vec4f(c.rgb * c.a, c.a) * w;
  }
  return sum / (hi - lo);
}

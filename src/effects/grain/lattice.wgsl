// Grain pass 1: the noise at each lattice point, one texel each: red, green, blue, and mono
// in alpha. The left half holds the grain's lattice, the right half the coarse clumps'
// lattice. Each channel uses its own spacing, so a coarser channel reads fewer texels.

fn prepass(texel: vec2i) -> vec4f {
  let half = passSize().x / 2;
  var layer = 0u;
  var p = texel;
  if (texel.x >= half) {
    layer = 1u;
    p = vec2i(texel.x - half, texel.y);
    // The coarse lattice needs only the first 1/2.5 of its half (plus the margin).
    let limit = imageSize() / (GRAIN_COARSE * grainFinestSpacing()) + 6.0;
    if (f32(p.x) > limit.x || f32(p.y) > limit.y) { return vec4f(0.0); }
  }
  let k = grainColourAmount();
  var out = vec4f(0.0);
  if (k < 1.0) { out.w = boiledNoise(p.x, p.y, 0u, layer); }
  if (k > 0.0) {
    out.x = boiledNoise(p.x, p.y, 1u, layer);
    out.y = boiledNoise(p.x, p.y, 2u, layer);
    out.z = boiledNoise(p.x, p.y, 3u, layer);
  }
  return out;
}

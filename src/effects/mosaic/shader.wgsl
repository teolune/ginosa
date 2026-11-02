// Mosaic: each pixel takes its cell's colour from pass 2, blended with the neighbouring
// cells across the edges by Edge Softness. Mirrors reference.ts.

fn effect(px: vec2f) -> vec4f {
  let n = prepassSize();
  // Off (cells under a pixel): pass 2 is 1 x 1 and the cell tiny. A real 1 x 1 grid has huge cells.
  if (all(n == vec2i(1)) && params.cellSize / 100.0 * imageSize().y < 1.5) { return inputNearest(px); }
  let cell = mosaicCell();
  let origin = vec2f(mosaicStart(imageSize().x, f32(n.x), cell.x), mosaicStart(imageSize().y, f32(n.y), cell.y));
  // Where px is between the centres of the four cells around it.
  let g = (px - origin + MOSAIC_BIAS) / cell - 0.5;
  let i0 = vec2i(floor(g));
  let t = g - floor(g);
  let s = clamp(params.softness / 100.0, 0.0, 1.0);
  var w = step(vec2f(0.5), t);
  if (s > 1e-4) { w = smoothstep(vec2f(0.5 - s * 0.5), vec2f(0.5 + s * 0.5), t); }
  let c00 = prepassLoad(i0);
  let c10 = prepassLoad(i0 + vec2i(1, 0));
  let c01 = prepassLoad(i0 + vec2i(0, 1));
  let c11 = prepassLoad(i0 + vec2i(1, 1));
  let c = mix(mix(c00, c10, w.x), mix(c01, c11, w.x), w.y);
  if (c.a <= 1e-8) { return vec4f(0.0); }
  return vec4f(c.rgb / c.a, c.a);
}

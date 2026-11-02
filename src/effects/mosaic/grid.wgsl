// Mosaic's grid, as grid.ts works it out.

const MOSAIC_BIAS: f32 = 0.001;

fn mosaicCell() -> vec2f {
  let h = params.cellSize / 100.0 * imageSize().y;
  return vec2f(max(h * params.aspect, 1.0), max(h, 1.0));
}

// Where cell 0 starts along one axis, for n cells of size c: centred, in whole pixels.
fn mosaicStart(size: f32, n: f32, c: f32) -> f32 {
  return floor((size - n * c) * 0.5 + 0.5);
}

fn mosaicCentre() -> bool { return u32(params.sample + 0.5) == 1u; }

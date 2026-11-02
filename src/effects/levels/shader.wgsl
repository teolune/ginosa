// Levels. Mirrors reference.ts: each channel through its own levels, then RGB.

fn level(x: f32, inBlack: f32, inWhite: f32, gamma: f32, outBlack: f32, outWhite: f32) -> f32 {
  let v = clamp((clamp(x, 0.0, 1.0) * 255.0 - inBlack) / max(inWhite - inBlack, 0.001), 0.0, 1.0);
  var g = 0.0;
  if (v > 0.0) { g = pow(v, 1.0 / max(gamma, 0.01)); }
  return (outBlack + g * (outWhite - outBlack)) / 255.0;
}

fn master(x: f32) -> f32 {
  return level(x, params.inBlack, params.inWhite, params.gamma, params.outBlack, params.outWhite);
}

fn effect(px: vec2f) -> vec4f {
  let src = inputAt(px);
  let r = level(src.r, params.redInBlack, params.redInWhite, params.redGamma, params.redOutBlack, params.redOutWhite);
  let g = level(src.g, params.greenInBlack, params.greenInWhite, params.greenGamma, params.greenOutBlack, params.greenOutWhite);
  let b = level(src.b, params.blueInBlack, params.blueInWhite, params.blueGamma, params.blueOutBlack, params.blueOutWhite);
  return vec4f(master(r), master(g), master(b), src.a);
}

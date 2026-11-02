// Curves. Mirrors reference.ts: each channel through its own curve, then the RGB curve.

fn effect(px: vec2f) -> vec4f {
  let src = inputAt(px);
  let c = vec3f(curveAt(CURVE_red, src.r), curveAt(CURVE_green, src.g), curveAt(CURVE_blue, src.b));
  return vec4f(curveAt(CURVE_master, c.r), curveAt(CURVE_master, c.g), curveAt(CURVE_master, c.b), src.a);
}

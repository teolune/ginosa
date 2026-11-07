// Look LUT. Mirrors lookReference in engine/colour/look-lut.ts.
// The input arrives as display values (colourSpace 'display'); the LUT is a 3D texture over 0–1.

fn effect(px: vec2f) -> vec4f {
  let src = inputAt(px);
  if (!hasEffectLut()) { return src; }
  let c = clamp(src.rgb, vec3f(0.0), vec3f(1.0));
  // The LUT's change, scaled by Strength; light past white keeps its distance above it.
  let out = src.rgb + (effectLutAt(c) - c) * (params.strength / 100.0);
  return vec4f(out, src.a);
}

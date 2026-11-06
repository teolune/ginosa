// Gradient Map. Mirrors reference.ts (the CPU version the tests compare against).
// The input arrives as display values (colourSpace 'display').

// Photoshop's brightness for Gradient Map (measured against Photoshop 2026).
const LUMA: vec3f = vec3f(0.30, 0.59, 0.11);

// Where along the gradient a tone falls: Input Range, then Repeat and Offset, then Edges, then Reverse.
fn mapPosition(y: f32) -> f32 {
  let black = params.inputBlack / 100.0;
  let white = params.inputWhite / 100.0;
  var p = 0.0;
  if (abs(white - black) < 1e-5) {
    p = select(0.0, 1.0, y >= black);
  } else {
    p = clamp((y - black) / (white - black), 0.0, 1.0);
  }
  let q = p * params.repeat + params.offset / 100.0;
  var x = 0.0;
  let edges = u32(params.edges + 0.5);
  if (edges == 2u) {
    x = clamp(q, 0.0, 1.0);
  } else if (edges == 1u) {
    x = 1.0 - abs(1.0 - (q - 2.0 * floor(q / 2.0)));
  } else {
    // Wrap into (0, 1], so the top of the range keeps the right-hand end.
    x = q - floor(q);
    if (x == 0.0 && q > 0.0) { x = 1.0; }
  }
  if (params.reverse > 0.5) { x = 1.0 - x; }
  return x;
}

// A fixed pattern of triangular noise, one level either way.
fn ditherAt(px: vec2f) -> f32 {
  let p = vec2u(px);
  var h = p.x * 1973u + p.y * 9277u + 26699u;
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  h = h ^ (h >> 15u);
  let a = f32(h & 0xffffu) / 65535.0;
  let b = f32(h >> 16u) / 65535.0;
  return (a + b - 1.0) / 255.0;
}

fn effect(px: vec2f) -> vec4f {
  let src = inputAt(px);
  let y = dot(clamp(src.rgb, vec3f(0.0), vec3f(1.0)), LUMA);
  let x = mapPosition(y);
  var g = gradientAt(GRADIENT_gradient, x);
  if (params.morph > 0.0) {
    g = mix(g, gradientAt(GRADIENT_gradientB, x), params.morph / 100.0);
  }
  var rgb = g.rgb;
  if (params.dither > 0.5) { rgb = rgb + vec3f(ditherAt(px)); }
  let a = select(1.0, g.a, params.opacityStops > 0.5);
  // With Normal blending the gradient replaces the picture (through its opacity, if used);
  // other blend modes get the gradient's colour and opacity to blend with.
  if (u32(frame.blendMode + 0.5) == 0u) {
    return vec4f(mix(src.rgb, rgb, a), src.a);
  }
  return vec4f(rgb, a);
}

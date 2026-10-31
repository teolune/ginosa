// Invert. Mirrors reference.ts (the CPU version the tests compare against).

fn rgbToHsl(c: vec3f) -> vec3f {
  let hi = max(c.r, max(c.g, c.b));
  let lo = min(c.r, min(c.g, c.b));
  let l = (hi + lo) * 0.5;
  let d = hi - lo;
  if (d <= 1e-6) { return vec3f(0.0, 0.0, l); }
  let s = d / (1.0 - abs(2.0 * l - 1.0));
  var h: f32;
  if (hi == c.r) { h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b); }
  else if (hi == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return vec3f(h / 6.0, s, l);
}

fn hslToRgb(hsl: vec3f) -> vec3f {
  let c = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  let h = fract(hsl.x) * 6.0;
  let x = c * (1.0 - abs(h % 2.0 - 1.0));
  var rgb: vec3f;
  if (h < 1.0) { rgb = vec3f(c, x, 0.0); }
  else if (h < 2.0) { rgb = vec3f(x, c, 0.0); }
  else if (h < 3.0) { rgb = vec3f(0.0, c, x); }
  else if (h < 4.0) { rgb = vec3f(0.0, x, c); }
  else if (h < 5.0) { rgb = vec3f(x, 0.0, c); }
  else { rgb = vec3f(c, 0.0, x); }
  return rgb + (hsl.z - c * 0.5);
}

fn effect(px: vec2f) -> vec4f {
  let src = inputAt(px);
  let c = clamp(src.rgb, vec3f(0.0), vec3f(1.0));
  let channel = u32(params.channel + 0.5);
  let linear = params.space > 0.5;
  var out = c;
  if (channel <= 3u) {
    var mask = vec3f(1.0);
    if (channel == 1u) { mask = vec3f(1.0, 0.0, 0.0); }
    if (channel == 2u) { mask = vec3f(0.0, 1.0, 0.0); }
    if (channel == 3u) { mask = vec3f(0.0, 0.0, 1.0); }
    if (linear) {
      let l = toLinear(c);
      out = toDisplay(mix(l, 1.0 - l, mask));
    } else {
      out = mix(c, 1.0 - c, mask);
    }
  } else if (channel == 5u) {
    let hsl = rgbToHsl(c);
    out = hslToRgb(vec3f(hsl.x + 0.5, hsl.y, hsl.z));
  } else {
    let lab = toOklab(toLinear(c));
    var flipped = lab;
    if (channel == 4u) { flipped = vec3f(1.0 - lab.x, lab.y, lab.z); }
    else { flipped = vec3f(lab.x, -lab.y, -lab.z); }
    out = toDisplay(clamp(fromOklab(flipped), vec3f(0.0), vec3f(1.0)));
  }
  return vec4f(mix(c, out, params.amount / 100.0), src.a);
}

// Transform: the same maths as the clip's Motion (motion.ts), inverted per output pixel.

// A texel with the chosen edge behaviour: 0 transparent, 1 repeat, 2 mirror, 3 tile.
fn texel(ix: i32, iy: i32) -> vec4f {
  let size = vec2i(imageSize());
  var p = vec2i(ix, iy);
  let edges = u32(params.edges + 0.5);
  if (edges == 0u) {
    if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) { return vec4f(0.0); }
  } else if (edges == 1u) {
    p = clamp(p, vec2i(0), size - 1);
  } else if (edges == 2u) {
    let period = size * 2;
    var m = ((p % period) + period) % period;
    m = select(m, period - 1 - m, m >= size);
    p = m;
  } else {
    p = ((p % size) + size) % size;
  }
  // Premultiplied, so smooth sampling doesn't darken edges that fade to transparent.
  let c = inputLoad(p);
  return vec4f(c.rgb * c.a, c.a);
}

fn cubic(t: f32) -> vec4f {
  // Catmull-Rom weights for the four taps around t.
  let t2 = t * t;
  let t3 = t2 * t;
  return vec4f(
    -0.5 * t3 + t2 - 0.5 * t,
    1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
    0.5 * t3 - 0.5 * t2
  );
}

fn unpremultiply(c: vec4f) -> vec4f {
  if (c.a <= 1e-5) { return vec4f(0.0); }
  return vec4f(c.rgb / c.a, c.a);
}

fn sampleAt(s: vec2f) -> vec4f {
  let sampling = u32(params.sampling + 0.5);
  if (sampling == 2u) {
    let p = vec2i(floor(s));
    return unpremultiply(texel(p.x, p.y));
  }
  let f = s - 0.5;
  let base = vec2i(floor(f));
  let t = f - floor(f);
  if (sampling == 0u) {
    let a = mix(texel(base.x, base.y), texel(base.x + 1, base.y), t.x);
    let b = mix(texel(base.x, base.y + 1), texel(base.x + 1, base.y + 1), t.x);
    return unpremultiply(mix(a, b, t.y));
  }
  let wx = cubic(t.x);
  let wy = cubic(t.y);
  var sum = vec4f(0.0);
  for (var j = 0; j < 4; j++) {
    var row = vec4f(0.0);
    for (var i = 0; i < 4; i++) {
      row += texel(base.x - 1 + i, base.y - 1 + j) * wx[i];
    }
    sum += row * wy[j];
  }
  let a = clamp(sum.a, 0.0, 1.0);
  return unpremultiply(vec4f(clamp(sum.rgb, vec3f(0.0), vec3f(a)), a));
}

fn effect(px: vec2f) -> vec4f {
  let sx = params.scale / 100.0 * params.scaleWidth / 100.0;
  let sy = params.scale / 100.0;
  if (abs(sx) < 1e-6 || abs(sy) < 1e-6) { return vec4f(0.0); }
  let r = radians(params.rotation);
  let d = px - vec2f(params.position_x, params.position_y);
  let u = cos(r) * d.x + sin(r) * d.y;
  let v = -sin(r) * d.x + cos(r) * d.y;
  let s = vec2f(params.anchor_x, params.anchor_y) + vec2f(u / sx, v / sy);
  let c = sampleAt(s);
  return vec4f(c.rgb, c.a * params.opacity / 100.0);
}

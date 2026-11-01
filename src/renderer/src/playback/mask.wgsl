// Shared masks (M9): how much of an effect shows at a pixel, 0-1. The buffer layout is
// packMask's (src/engine/masks/masks.ts), and maskAlpha there is the CPU reference this
// must match. The including shader declares `maskData: array<vec4f>` (read-only storage).

fn maskSdRoundBox(p: vec2f, half: vec2f, r: f32) -> f32 {
  let rr = min(max(r, 0.0), min(half.x, half.y));
  let q = abs(p) - half + rr;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rr;
}

fn maskSdEllipse(p: vec2f, radii: vec2f) -> f32 {
  let r = max(radii, vec2f(1e-3));
  let k0 = length(p / r);
  let k1 = length(p / (r * r));
  if (k1 < 1e-9) { return -min(r.x, r.y); }
  return k0 * (k0 - 1.0) / k1;
}

// Even-odd polygon distance over edges stored as (previous point, this point).
fn maskSdPolygon(p: vec2f, first: u32, count: u32) -> f32 {
  if (count < 3u) { return 1e9; }
  var d = 1e30;
  var s = 1.0;
  for (var k = 0u; k < count; k++) {
    let edge = maskData[first + k];
    let vj = edge.xy;
    let vi = edge.zw;
    let e = vj - vi;
    let w = p - vi;
    let b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
    d = min(d, dot(b, b));
    let c1 = p.y >= vi.y;
    let c2 = p.y < vj.y;
    let c3 = e.x * w.y > e.y * w.x;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) { s = -s; }
  }
  return s * sqrt(d);
}

// `px` is a frame (sequence) pixel; `size` the frame; `aa` frame pixels per processed pixel.
fn maskAlpha(px: vec2f, parts: u32, size: vec2f, aa: f32, luma: f32) -> f32 {
  if (parts == 0u) { return 1.0; }
  // Adding starts from nothing; subtracting or intersecting first starts from everything.
  var acc = select(1.0, 0.0, u32(maskData[0u].y + 0.5) == 0u);
  for (var i = 0u; i < parts; i++) {
    let p0 = maskData[i * 4u];
    let p1 = maskData[i * 4u + 1u];
    let p2 = maskData[i * 4u + 2u];
    let p3 = maskData[i * 4u + 3u];
    let kind = u32(p0.x + 0.5);
    let mode = u32(p0.y + 0.5);
    let f = max(p1.x, aa);
    var a = 0.0;
    if (kind == 4u) {
      let soft = max(p2.z, 1e-4);
      a = smoothstep(p2.x - soft, p2.x, luma) * (1.0 - smoothstep(p2.y, p2.y + soft, luma));
    } else if (kind == 3u) {
      let d = min(min(px.x, px.y), min(size.x - px.x, size.y - px.y));
      let reach = p2.x + p1.y;
      a = 1.0 - smoothstep(reach - f * 0.5, reach + f * 0.5, d);
    } else {
      var d = 1e9;
      if (kind == 2u) {
        // Further outside the path's box than its soft edge reaches: nothing to show (the
        // distance can only be larger), so the edges needn't be visited.
        let margin = f * 0.5 + max(p1.y, 0.0) + 1.0;
        let outside = max(p3.xy - px, px - p3.zw);
        if (max(outside.x, outside.y) <= margin) {
          d = maskSdPolygon(px, u32(p2.x + 0.5), u32(p2.y + 0.5));
        }
      } else {
        let delta = px - p1.zw;
        let local = vec2f(p3.x * delta.x + p3.y * delta.y, -p3.y * delta.x + p3.x * delta.y);
        if (kind == 0u) { d = maskSdRoundBox(local, p2.xy, p2.z); } else { d = maskSdEllipse(local, p2.xy); }
      }
      a = 1.0 - smoothstep(-f * 0.5, f * 0.5, d - p1.y);
    }
    if (p0.z > 0.5) { a = 1.0 - a; }
    a *= clamp(p0.w, 0.0, 1.0);
    if (mode == 0u) { acc = acc + a - acc * a; } else if (mode == 1u) { acc *= 1.0 - a; } else { acc *= a; }
  }
  return acc;
}

fn maskLuma(c: vec3f) -> f32 {
  return clamp(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
}

// Feedback: this frame over the effect's own previous frame (zoomed and turned about Centre).

fn effect(px: vec2f) -> vec4f {
  let current = inputNearest(px);
  if (!hasPrevious()) { return current; }
  let c = vec2f(params.centre_x, params.centre_y);
  let r = radians(params.rotation);
  let z = max(params.zoom / 100.0, 1e-3);
  // Where this pixel was on the previous frame: undo this frame's zoom and turn.
  let d = (px - c) / z;
  let q = c + vec2f(cos(r) * d.x + sin(r) * d.y, -sin(r) * d.x + cos(r) * d.y);
  let previous = previousAt(q);
  let k = clamp(params.amount / 100.0, 0.0, 1.0) * previous.a;
  let mode = u32(params.mode + 0.5);
  var rgb = mix(current.rgb, previous.rgb, k);
  if (mode == 1u) {
    // Kept within white, so the glow can't build up without limit.
    rgb = min(current.rgb + previous.rgb * k, vec3f(1.0));
  } else if (mode == 2u) {
    rgb = 1.0 - (1.0 - current.rgb) * (1.0 - previous.rgb * k);
  } else if (mode == 3u) {
    rgb = max(current.rgb, previous.rgb * k);
  }
  return vec4f(rgb, max(current.a, k));
}

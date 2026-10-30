// M0 smoke-test shader: draws a decoded video frame, optionally inverted.
// This is a pipeline test, not the real Invert effect (that arrives in M6).

struct Params {
  amount: f32,
  effect: u32, // 0 = none, 1 = invert
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var src: texture_external;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

// One triangle that covers the whole target; no vertex buffer needed.
@vertex
fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let p = corners[index];
  var out: VsOut;
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = vec2f((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let color = textureSampleBaseClampToEdge(src, srcSampler, in.uv);
  var rgb = color.rgb;
  if (params.effect == 1u) {
    rgb = mix(rgb, vec3f(1.0) - rgb, clamp(params.amount, 0.0, 1.0));
  }
  return vec4f(rgb, 1.0);
}

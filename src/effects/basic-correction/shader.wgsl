// Basic Correction. Mirrors reference.ts (the CPU version the tests compare against).
// The input arrives as linear light (colourSpace 'linear').

const SKIN_HUE: f32 = 0.95993109; // 55 degrees
const SKIN_WIDTH: f32 = 0.35;
const VIBRANCE_CHROMA: f32 = 0.25;
const TAU: f32 = 6.28318530718;

fn powPos(x: f32, y: f32) -> f32 {
  if (x <= 0.0) { return 0.0; }
  return pow(x, y);
}

fn basicTone(l0: f32) -> f32 {
  var l = clamp(l0, 0.0, 1.0);
  l = powPos(l, exp2(-params.brightness / 100.0));
  let k = exp2(params.contrast / 100.0);
  if (l < 0.5) { l = 0.5 * powPos(2.0 * l, k); } else { l = 1.0 - 0.5 * powPos(2.0 * (1.0 - l), k); }
  l = l + 0.12 * (params.highlights / 100.0) * 6.75 * l * l * (1.0 - l);
  l = l + 0.12 * (params.shadows / 100.0) * 6.75 * l * (1.0 - l) * (1.0 - l);
  l = clamp(l, 0.0, 1.0);
  l = l + 0.1 * (params.whites / 100.0) * l * l * l;
  let below = max(1.0 - l, 0.0);
  l = l + 0.1 * (params.blacks / 100.0) * below * below * below;
  return max(l, 0.0) + max(l0 - 1.0, 0.0);
}

fn effect(px: vec2f) -> vec4f {
  let src = inputAt(px);
  let t = params.temperature / 100.0;
  let g = params.tint / 100.0;
  var gains = vec3f(exp2(0.3 * t + 0.15 * g), exp2(-0.3 * g), exp2(-0.3 * t + 0.15 * g));
  gains = gains / dot(gains, vec3f(0.2126, 0.7152, 0.0722));
  let lab = toOklab(max(src.rgb, vec3f(0.0)) * gains * exp2(params.exposure));
  let l = basicTone(lab.x);
  var k = 1.0;
  if (lab.x > 1e-6) { k = clamp(l / lab.x, 0.0, 4.0); }
  var ab = lab.yz * k * (params.saturation / 100.0);
  let v = params.vibrance / 100.0;
  let c = length(ab);
  if (v != 0.0 && c > 1e-7) {
    var d = atan2(ab.y, ab.x) - SKIN_HUE;
    d = d - TAU * floor(d / TAU + 0.5);
    let skin = exp(-(d * d) / (2.0 * SKIN_WIDTH * SKIN_WIDTH));
    let w = clamp(1.0 - c / VIBRANCE_CHROMA, 0.0, 1.0) * (1.0 - 0.6 * skin);
    var f = 1.0 + v * w;
    if (v > 0.0) { f = 1.0 + 0.8 * v * w; }
    ab = ab * f;
  }
  let turn = radians(params.hue);
  let cs = cos(turn);
  let sn = sin(turn);
  let out = fromOklab(vec3f(l, ab.x * cs - ab.y * sn, ab.x * sn + ab.y * cs));
  return vec4f(max(out, vec3f(0.0)), src.a);
}

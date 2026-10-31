// Composite (working values: Rec.709 R'G'B') → the raw Y'CbCr bytes FFmpeg expects.
// One invocation writes one 32-bit word of the frame, so every layout packs exactly:
//   0 nv12          8-bit  Y plane, then interleaved CbCr at 4:2:0
//   1 p010le       16-bit  same layout, 10-bit values in the high bits
//   2 yuv422p10le  16-bit  Y, Cb, Cr planes, 4:2:2, 10-bit values in the low bits
//   3 yuv444p10le  16-bit  Y, Cb, Cr planes, full resolution
// BT.709 matrix, limited range. Chroma is sited left (co-sited with even luma columns,
// as H.264/HEVC/ProRes expect) using a [1 2 1] filter, and for 4:2:0 centred between rows.
// Values are dithered (triangular, ±1 step) before rounding, so gradients don't band.

struct Params {
  width: u32,
  height: u32,
  format: u32,
  frame: u32,
  words: u32,
  groupsX: u32,
  _a: u32,
  _b: u32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outWords: array<u32>;
@group(0) @binding(2) var<uniform> p: Params;

fn rgbAt(x: i32, y: i32) -> vec3f {
  let cx = clamp(x, 0, i32(p.width) - 1);
  let cy = clamp(y, 0, i32(p.height) - 1);
  return clamp(textureLoad(src, vec2i(cx, cy), 0).rgb, vec3f(0.0), vec3f(1.0));
}

fn hash(a: u32) -> u32 {
  var x = a;
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

// Triangular dither in [-1, 1] steps, different per sample, plane and frame.
fn dither(index: u32, plane: u32) -> f32 {
  let seed = hash(index * 3u + plane + hash(p.frame + 0x9e3779b9u));
  let a = f32(seed & 0xffffu) / 65535.0;
  let b = f32(seed >> 16u) / 65535.0;
  return a + b - 1.0;
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn quantise(v: f32, index: u32, plane: u32) -> u32 {
  let maxValue = select(1023.0, 255.0, p.format == 0u);
  return u32(clamp(floor(v + 0.5 + dither(index, plane)), 0.0, maxValue));
}

// Code value for Y' at (x, y).
fn lumaCode(x: i32, y: i32, index: u32) -> u32 {
  let scale = select(4.0, 1.0, p.format == 0u);
  return quantise((16.0 + 219.0 * luma(rgbAt(x, y))) * scale, index, 0u);
}

// Code value for Cb (component 0) or Cr (1) at chroma position (cx, cy).
fn chromaCode(cx: i32, cy: i32, component: u32, index: u32) -> u32 {
  var c: vec3f;
  if (p.format == 3u) {
    c = rgbAt(cx, cy);
  } else {
    let x = cx * 2;
    var rows = array<i32, 2>(cy, cy);
    if (p.format <= 1u) { rows = array<i32, 2>(cy * 2, cy * 2 + 1); }
    c = vec3f(0.0);
    for (var r = 0; r < 2; r++) {
      c += 0.25 * rgbAt(x - 1, rows[r]) + 0.5 * rgbAt(x, rows[r]) + 0.25 * rgbAt(x + 1, rows[r]);
    }
    c *= 0.5;
  }
  let y = luma(c);
  let diff = select(c.r - y, c.b - y, component == 0u) / select(1.5748, 1.8556, component == 0u);
  let scale = select(4.0, 1.0, p.format == 0u);
  return quantise((128.0 + 224.0 * diff) * scale, index, 1u + component);
}

// The value of sample `s` (counted across the whole frame, in samples).
fn sampleAt(s: u32) -> u32 {
  let w = p.width;
  let h = p.height;
  let lumaCount = w * h;
  if (s < lumaCount) {
    return lumaCode(i32(s % w), i32(s / w), s);
  }
  let c = s - lumaCount;
  if (p.format <= 1u) {
    // Interleaved CbCr pairs at half width and height.
    let pair = c / 2u;
    let cw = w / 2u;
    return chromaCode(i32(pair % cw), i32(pair / cw), c % 2u, s);
  }
  let cw = select(w / 2u, w, p.format == 3u);
  let planeCount = cw * h;
  let component = c / planeCount;
  let i = c % planeCount;
  return chromaCode(i32(i % cw), i32(i / cw), component, s);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let word = id.y * p.groupsX * 256u + id.x;
  if (word >= p.words) { return; }
  if (p.format == 0u) {
    let s = word * 4u;
    outWords[word] = sampleAt(s) | (sampleAt(s + 1u) << 8u) | (sampleAt(s + 2u) << 16u) | (sampleAt(s + 3u) << 24u);
  } else {
    let s = word * 2u;
    var a = sampleAt(s);
    var b = sampleAt(s + 1u);
    if (p.format == 1u) { a = a << 6u; b = b << 6u; }
    outWords[word] = a | (b << 16u);
  }
}

// ---- Datamosh (M14): shared by every pass. See manifest.ts for the whole design. ----

const LUMA_W: vec3f = vec3f(0.2126, 0.7152, 0.0722);

// Block sizes are in pixels of a 1080-high picture, so the look holds at any resolution.
fn heightScale() -> f32 { return frame.size.y / 1080.0; }
fn blockPx() -> f32 { return max(2.0, floor(f32(4u << u32(params.blockSize + 0.5)) * heightScale() + 0.5)); }
fn coarseBlockPx() -> f32 { return max(4.0, floor(16.0 * heightScale() + 0.5)); }

// The luma pyramid (pass 1): levels 0, 1 and 2 (full, half and quarter size) stacked one
// under the other, this frame's luma in x and the frame before's in y, so a block search
// reads both from one image.
fn levelSize(level: u32) -> vec2i {
  let s = vec2i(frame.size + 0.5);
  let n = 1 << level;
  return (s + vec2i(n - 1)) / n;
}
fn levelRow(level: u32) -> i32 {
  if (level == 0u) { return 0; }
  if (level == 1u) { return levelSize(0u).y; }
  return levelSize(0u).y + levelSize(1u).y;
}

// This frame's luma, and the frame before's, at a point of a level (held at the level's edges).
struct Level { size: vec2i, row: i32 }
fn level(l: u32) -> Level { return Level(levelSize(l), levelRow(l)); }
fn lumaNow(v: Level, p: vec2i) -> f32 {
  let q = clamp(p, vec2i(0), v.size - 1);
  return firstPassLoad(vec2i(q.x, v.row + q.y)).x;
}
fn lumaBefore(v: Level, p: vec2i) -> f32 {
  let q = clamp(p, vec2i(0), v.size - 1);
  return firstPassLoad(vec2i(q.x, v.row + q.y)).y;
}

// An encoder biases towards its prediction; here, a small cost per pixel moved, so flat
// areas don't wander.
const MOVE_COST: f32 = 0.0003;
// A block's vector when it's an intra block (Intra Blocks): the real frame, not moved.
const INTRA: f32 = 10000.0;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// A repeatable random number in 0-1 for a block on a frame (and a stream, for independent draws).
fn blockRandom(block: vec2i, stream: u32) -> f32 {
  let f = u32(max(frameIndex(), 0.0));
  return f32(pcg((u32(block.x) * 73856093u) ^ pcg((u32(block.y) * 19349663u) ^ pcg((f * 83492791u) ^ stream)))) / 4294967295.0;
}

// The mosh buffer: last frame's output, its blocks moved by this frame's motion (as a
// decoder moves a reference frame's blocks), with some of the real frame let back in.
fn bufferAt(p: vec2f) -> vec4f {
  // Like a decoder, blocks pulled from outside the picture take its edge.
  return previousAt(clamp(p, vec2f(0.5), frame.size - 0.5));
}

fn effect(px: vec2f) -> vec4f {
  let src = inputAt(px);
  let grid = prepassSize() - vec2i(0, 1);
  let counts = prepassLoad(vec2i(0, grid.y));
  // A reset (the first frame, a cut, a beat, the trigger): the buffer starts again from this frame.
  if (!hasPrevious() || counts.x < 0.5) {
    if (u32(params.view + 0.5) == 1u) { return vec4f(0.5, 0.5, 0.5, src.a); }
    return src;
  }
  let block = clamp(vec2i(floor(px / blockPx())), vec2i(0), grid - 1);
  let d = prepassLoad(block).xy;
  let intra = d.x > INTRA * 0.5;
  // Show: Motion. How far this block is fetched from, as colour (grey: still; 32 px is full; black: intra).
  if (u32(params.view + 0.5) == 1u) {
    if (intra) { return vec4f(0.0, 0.0, 0.0, src.a); }
    return vec4f(0.5 - d.x / 64.0, 0.5 - d.y / 64.0, 0.5, src.a);
  }
  if (intra) { return src; }
  var c = bufferAt(px + d).rgb;
  // Residual: the footage's own change since the frame before, along this motion (what a P-frame
  // adds after moving its blocks), added to the moved picture and kept in range as a decoder does.
  // From the pyramid's luma and chroma, so with a Motion Source it's that track's change.
  // Not across a cut: the shot before isn't what the new shot's changes were measured from.
  if (params.residual > 0.0 && counts.x > params.freeze && framesSinceCut() > 0.5) {
    let now = firstPassLoad(vec2i(floor(px)));
    let then = keptLoad(0u, clamp(vec2i(floor(px + d)), vec2i(0), vec2i(frame.size) - 1));
    let dy = now.x - then.x;
    let dr = dy + 1.5748 * (now.w - then.w);
    let db = dy + 1.8556 * (now.z - then.z);
    let dg = (dy - LUMA_W.r * dr - LUMA_W.b * db) / LUMA_W.g;
    c = clamp(c + vec3f(dr, dg, db) * params.residual / 100.0, vec3f(0.0), vec3f(1.0));
  }
  let drift = params.colourDrift / 100.0;
  if (drift > 0.0) {
    // Colour drift: red and blue follow slightly different vectors, so colour bleeds off edges.
    c.r = bufferAt(px + d * (1.0 + 0.2 * drift) + vec2f(1.5 * drift, 0.0)).r;
    c.b = bufferAt(px + d * (1.0 - 0.2 * drift) - vec2f(1.5 * drift, 0.0)).b;
  }
  // Leak: the real frame back in, evenly or as whole blocks refreshed (an encoder's intra blocks);
  // Melt raises it from nothing at a cut to all of it after that many frames.
  var leak = params.leak / 100.0;
  if (params.melt > 0.0) { leak = max(leak, smoothstep(0.0, 1.0, framesSinceCut() / params.melt)); }
  if (u32(params.leakStyle + 0.5) == 1u) {
    if (blockRandom(block, 9u) < leak) { return src; }
    return vec4f(c, src.a);
  }
  return vec4f(mix(c, src.rgb, leak), src.a);
}

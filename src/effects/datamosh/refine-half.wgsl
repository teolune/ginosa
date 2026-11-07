fn prepass(texel: vec2i) -> vec4f {
  // Guesses: the coarse vectors of the 16-pixel block under this block's centre and its neighbours.
  let c = vec2i(floor((vec2f(texel) + 0.5) * blockPx() / coarseBlockPx()));
  var guesses: array<vec2f, 9>;
  for (var i = 0; i < 9; i++) { guesses[i] = prepassLoad(clamp(c + vec2i(i % 3 - 1, i / 3 - 1), vec2i(0), prepassSize() - 1)).xy; }
  return refine(1u, texel, &guesses, 9, 1);
}

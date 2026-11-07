fn prepass(texel: vec2i) -> vec4f {
  var guesses: array<vec2f, 9>;
  guesses[0] = prepassLoad(texel).xy;
  return refine(0u, texel, &guesses, 1, 1);
}

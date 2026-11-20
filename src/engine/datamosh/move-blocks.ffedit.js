// Datamosh Bake's vector tools (M15, decision 133): ffedit runs this on each P-frame of a bake.
// Plain JavaScript for FFglitch's QuickJS, inlined into each bake's script by vectors.ts, and
// tested as it stands (vectors.test.ts). No imports, nothing outside the function.
//
// `base`: each block's vector, row by row, horizontal then vertical, in half pixels (MPEG-4's
// unit). A codec vector points to where the block's picture comes from in the frame before, so
// the picture moves the other way: the push and the swirl are subtracted. `v`: this frame's
// values (Push X/Y in pixels of a 1080-high picture, Scale %, Rotate degrees clockwise, Swirl %,
// Fluid %, Wrong Guesses %) and `unit`, half pixels of the bake per pixel of a 1080-high picture.
// `state` carries Fluid's running average and the wrong guesses' random numbers between frames.
// Returns the new vectors, rounded.
function moveBlocks(base, width, height, v, state) {
  const n = width * height
  if (!state.avg || state.avg.length !== n * 2) state.avg = Float64Array.from(base)
  const avg = state.avg
  const keep = Math.min(0.95, Math.max(0, v.fluid / 100) * 0.95)
  const scale = v.scale / 100
  const angle = (v.rotate * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const swirl = (v.swirl / 100) * 20 * v.unit
  const cx = width / 2
  const cy = height / 2
  const radius = Math.max(1, height / 2)
  const out = new Float64Array(n * 2)
  for (let i = 0; i < height; i++) {
    for (let j = 0; j < width; j++) {
      const k = (i * width + j) * 2
      avg[k] = avg[k] * keep + base[k] * (1 - keep)
      avg[k + 1] = avg[k + 1] * keep + base[k + 1] * (1 - keep)
      const x = avg[k] * scale
      const y = avg[k + 1] * scale
      // Around the centre, clockwise on screen (y down), as the picture moves.
      const dx = (j + 0.5 - cx) / radius
      const dy = (i + 0.5 - cy) / radius
      out[k] = x * cos - y * sin - (-dy * swirl + v.px * v.unit)
      out[k + 1] = x * sin + y * cos - (dx * swirl + v.py * v.unit)
    }
  }
  if (v.wrong > 0) {
    // Mulberry32, seeded once per bake, so the same settings give the same bake.
    const random = () => {
      state.rng = (state.rng + 0x6d2b79f5) >>> 0
      let t = state.rng
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const before = Float64Array.from(out)
    const chance = Math.min(1, v.wrong / 100)
    for (let i = 0; i < height; i++) {
      for (let j = 0; j < width; j++) {
        if (random() >= chance) continue
        const side = Math.floor(random() * 4)
        const ni = Math.min(height - 1, Math.max(0, i + (side === 0 ? -1 : side === 1 ? 1 : 0)))
        const nj = Math.min(width - 1, Math.max(0, j + (side === 2 ? -1 : side === 3 ? 1 : 0)))
        const k = (i * width + j) * 2
        const nk = (ni * width + nj) * 2
        out[k] = before[nk] + (random() * 2 - 1) * 2 * v.unit
        out[k + 1] = before[nk + 1] + (random() * 2 - 1) * 2 * v.unit
      }
    }
  }
  const rounded = new Int32Array(n * 2)
  for (let k = 0; k < n * 2; k++) rounded[k] = Math.round(out[k])
  return rounded
}

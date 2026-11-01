/**
 * The CPU version of shader.wgsl, for tests: one frame of Feedback on an RGBA float image
 * (display values), given the previous output (null on the first frame). Bilinear sampling
 * of the previous frame as the GPU does it (clamped at the edges, transparent outside).
 */
export interface FeedbackParams {
  amount: number
  zoom: number
  rotation: number
  centre: [number, number]
  mode: 'over' | 'add' | 'screen' | 'lighten'
}

export function feedbackReference(input: Float32Array, previous: Float32Array | null, width: number, height: number, p: FeedbackParams): Float32Array {
  if (!previous) return input.slice()
  const out = new Float32Array(input.length)
  const r = (p.rotation * Math.PI) / 180
  const z = Math.max(p.zoom / 100, 1e-3)
  const [cx, cy] = p.centre
  const texel = (x: number, y: number, ch: number) => previous[(Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4 + ch]!
  const sample = (qx: number, qy: number): number[] => {
    if (qx < 0 || qy < 0 || qx > width || qy > height) return [0, 0, 0, 0]
    const fx = qx - 0.5
    const fy = qy - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    return [0, 1, 2, 3].map((ch) => {
      const a = texel(x0, y0, ch) * (1 - tx) + texel(x0 + 1, y0, ch) * tx
      const b = texel(x0, y0 + 1, ch) * (1 - tx) + texel(x0 + 1, y0 + 1, ch) * tx
      return a * (1 - ty) + b * ty
    })
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const dx = (px - cx) / z
      const dy = (py - cy) / z
      const prev = sample(cx + Math.cos(r) * dx + Math.sin(r) * dy, cy - Math.sin(r) * dx + Math.cos(r) * dy)
      const i = (y * width + x) * 4
      const k = Math.min(1, Math.max(0, p.amount / 100)) * prev[3]!
      for (let ch = 0; ch < 3; ch++) {
        const c = input[i + ch]!
        const q = prev[ch]!
        out[i + ch] = p.mode === 'add' ? Math.min(1, c + q * k) : p.mode === 'screen' ? 1 - (1 - c) * (1 - q * k) : p.mode === 'lighten' ? Math.max(c, q * k) : c + (q - c) * k
      }
      out[i + 3] = Math.max(input[i + 3]!, k)
    }
  return out
}

import { describe, expect, it } from 'vitest'
import moveBlocksSource from './move-blocks.ffedit.js?raw'
import { STILL_VECTORS, motionReaderScript, vectorScript, vectorsChange, type VectorFrame } from './vectors'

type Move = (base: ArrayLike<number>, width: number, height: number, v: VectorFrame & { unit: number }, state: { avg: Float64Array | null; rng: number }) => Int32Array
const moveBlocks = new Function(`${moveBlocksSource}\nreturn moveBlocks`)() as Move

const still = (over: Partial<VectorFrame & { unit: number }> = {}) => ({ ...STILL_VECTORS, unit: 2, ...over })

describe('Datamosh Bake: the vector tools (as ffedit runs them)', () => {
  const base = [4, 0, 4, 0, 0, -2, 0, -2] // 2 × 2 blocks: the top row moving, the bottom row moving up

  it('leaves vectors alone at the defaults', () => {
    expect(Array.from(moveBlocks(base, 2, 2, still(), { avg: null, rng: 1 }))).toEqual(base)
  })

  it('pushes against the vector (a vector points where the picture comes from), in half pixels of the bake', () => {
    // Push X 3 px (unit 2: 1080 high, half pixels): every vector −6 horizontally, so the picture moves right.
    expect(Array.from(moveBlocks(base, 2, 2, still({ px: 3 }), { avg: null, rng: 1 }))).toEqual([-2, 0, -2, 0, -6, -2, -6, -2])
  })

  it('scales and rotates (clockwise on screen)', () => {
    expect(Array.from(moveBlocks(base, 2, 2, still({ scale: 50 }), { avg: null, rng: 1 }))).toEqual([2, 0, 2, 0, 0, -1, 0, -1])
    expect(Array.from(moveBlocks([4, 0], 1, 1, still({ rotate: 90 }), { avg: null, rng: 1 }))).toEqual([0, 4])
  })

  it('swirls round the centre', () => {
    // 2 × 1 blocks: the left one turns up (clockwise), so its vector points down; the right one the other way.
    const out = Array.from(moveBlocks([0, 0, 0, 0], 2, 1, still({ swirl: 100, unit: 1 }), { avg: null, rng: 1 }))
    expect(out[1]).toBeGreaterThan(0)
    expect(out[3]).toBeLessThan(0)
    expect(out[0]).toBe(0)
  })

  it('Fluid averages each block over the frames before', () => {
    const state = { avg: null, rng: 1 }
    moveBlocks([10, 0], 1, 1, still({ fluid: 100 }), state)
    const next = moveBlocks([0, 0], 1, 1, still({ fluid: 100 }), state)
    // 95% of the last frame's 10 carries on.
    expect(next[0]).toBe(10)
    expect(moveBlocks([0, 0], 1, 1, still({ fluid: 100 }), state)[0]).toBe(9)
  })

  it('wrong guesses take a neighbour’s vector, a little off, the same for the same seed', () => {
    const grid = Array.from({ length: 16 * 16 * 2 }, (_, k) => (k % 2 === 0 ? (k >> 1) % 16 : 0))
    const a = moveBlocks(grid, 16, 16, still({ wrong: 50 }), { avg: null, rng: 7 })
    const b = moveBlocks(grid, 16, 16, still({ wrong: 50 }), { avg: null, rng: 7 })
    const c = moveBlocks(grid, 16, 16, still({ wrong: 50 }), { avg: null, rng: 8 })
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(Array.from(a)).not.toEqual(Array.from(c))
    const changed = Array.from(a).filter((v, k) => v !== grid[k]).length
    expect(changed).toBeGreaterThan(50)
    expect(Array.from(a).every((v, k) => Math.abs(v - grid[k]!) <= 1 + 4)).toBe(true)
  })

  it('knows when a bake needs ffedit at all', () => {
    expect(vectorsChange([STILL_VECTORS, STILL_VECTORS], false)).toBe(false)
    expect(vectorsChange([STILL_VECTORS], true)).toBe(true)
    expect(vectorsChange([STILL_VECTORS, { ...STILL_VECTORS, scale: 99 }], false)).toBe(true)
  })
})

/** Runs a generated script on fake frames, as ffedit would (without QuickJS's `std`). */
const overflow: unknown[] = []
function runScript(script: string, frames: Array<number[][] | null>, lines: string[] = []) {
  overflow.length = 0
  const body = script.replace(/^import .*$/m, '').replace(/export function/g, 'function')
  const std = { open: () => ({ getline: () => lines.shift() ?? null, puts: (t: string) => lines.push(t), flush: () => undefined }) }
  const api = new Function('std', `${body}\nreturn { setup, glitch_frame }`)(std) as { setup(a: { features?: string[] }): void; glitch_frame(f: unknown): void }
  const args: { features?: string[] } = {}
  api.setup(args)
  expect(args.features).toEqual(['mv'])
  return frames.map((rows) => {
    if (!rows) {
      api.glitch_frame({})
      return null
    }
    const mv2d = {
      width: rows[0]!.length / 2,
      height: rows.length,
      forEach(fn: (mv: number[], r: number, c: number) => void) {
        rows.forEach((row, r) => {
          for (let c = 0; c < row.length / 2; c++) {
            const mv = [row[c * 2]!, row[c * 2 + 1]!]
            fn(mv, r, c)
            row[c * 2] = mv[0]!
            row[c * 2 + 1] = mv[1]!
          }
        })
      }
    }
    const frame = { mv: { forward: mv2d } as Record<string, unknown> }
    api.glitch_frame(frame)
    overflow.push(frame.mv['overflow'])
    return rows
  })
}

describe('Datamosh Bake: the ffedit scripts', () => {
  it('counts every frame (keyframes too) and uses that frame’s values', () => {
    const frames = [STILL_VECTORS, { ...STILL_VECTORS, px: 1 }, { ...STILL_VECTORS, px: 2 }]
    const out = runScript(vectorScript({ frames, unit: 2, seed: 1 }), [null, [[0, 0, 0, 0]], [[0, 0, 0, 0]]])
    expect(out).toEqual([null, [[-2, 0, -2, 0]], [[-4, 0, -4, 0]]])
    // Vectors pushed past the codec's range are clipped to it, not wrapped.
    expect(overflow).toEqual(['truncate', 'truncate'])
  })

  it('replaces the vectors with a motion source’s, line by line', () => {
    const out = runScript(vectorScript({ frames: [STILL_VECTORS], unit: 2, seed: 1, motionFile: '/tmp/m.txt' }), [null, [[1, 1, 1, 1]], [[1, 1, 1, 1]]], ['-', '5,6,7,8', 'bad'])
    // A line that doesn't fit the frame leaves its own vectors.
    expect(out).toEqual([null, [[5, 6, 7, 8]], [[1, 1, 1, 1]]])
  })

  it('writes a motion source’s vectors a line a frame', () => {
    const lines: string[] = []
    runScript(motionReaderScript('/tmp/m.txt'), [null, [[3, -1, 2, 0]]], lines)
    expect(lines).toEqual(['-\n', '3,-1,2,0\n'])
  })
})

/// <reference types="vite/client" />
import moveBlocksSource from './move-blocks.ffedit.js?raw'

/**
 * Datamosh Bake's ffedit scripts (M15): the vector tools as a script for each bake, with this
 * bake's values for every frame written into it (so keyframes and audio links on Push, Scale
 * and the rest work), and the script that reads a motion source's vectors out of its own encode.
 * The tools themselves are move-blocks.ffedit.js.
 */

/** One frame's vector values: Push X/Y (px of a 1080-high picture), Scale %, Rotate °, Swirl %, Fluid %, Wrong Guesses %. */
export interface VectorFrame {
  px: number
  py: number
  scale: number
  rotate: number
  swirl: number
  fluid: number
  wrong: number
}

export const STILL_VECTORS: VectorFrame = { px: 0, py: 0, scale: 100, rotate: 0, swirl: 0, fluid: 0, wrong: 0 }

/** Whether a bake needs ffedit at all: any frame's values move the vectors, or a motion source replaces them. */
export function vectorsChange(frames: readonly VectorFrame[], motionSource: boolean): boolean {
  if (motionSource) return true
  const k = Object.keys(STILL_VECTORS) as Array<keyof VectorFrame>
  return frames.some((f) => k.some((key) => Math.abs(f[key] - STILL_VECTORS[key]) > 1e-6))
}

const round = (v: number) => Math.round(v * 1000) / 1000

/**
 * The script ffedit runs on a bake (its frames in the bake's order, I-frames included: every
 * frame is counted, and only P-frames have vectors to change). `unit` is half pixels of the bake
 * per pixel of a 1080-high picture. With `motionFile`, each frame's own vectors are replaced
 * first by that frame's line from the motion source's vectors (motionReaderScript).
 */
export function vectorScript(options: { frames: readonly VectorFrame[]; unit: number; seed: number; motionFile?: string | null; logFile?: string | null }): string {
  const values = options.frames.map((f) => [f.px, f.py, f.scale, f.rotate, f.swirl, f.fluid, f.wrong].map(round))
  const motion = options.motionFile ?? null
  const log = options.logFile ?? null
  return `// ginosa Datamosh Bake: the vector tools, written for one bake.
${motion || log ? "import * as std from 'std';\n" : ''}${moveBlocksSource}
const V = ${JSON.stringify(values)};
const UNIT = ${round(options.unit)};
let n = 0;
let replaced = 0;
let source = null;
let log = null;
const state = { avg: null, rng: ${Math.max(1, Math.round(options.seed) >>> 0)} };

export function setup(args) {
  args.features = ['mv'];${motion ? `\n  source = std.open(${JSON.stringify(motion)}, 'r');` : ''}${log ? `\n  log = std.open(${JSON.stringify(log)}, 'w');` : ''}
}

export function glitch_frame(frame) {
  const i = n++;
  const line = source ? source.getline() : null;
  const mvs = frame.mv ? frame.mv.forward : null;
  if (!mvs) return;
  frame.mv.overflow = 'truncate';
  const w = mvs.width;
  const h = mvs.height;
  let base = null;
  if (line && line !== '-') {
    const parts = line.split(',');
    if (parts.length === w * h * 2) {
      replaced++;
      base = new Float64Array(w * h * 2);
      for (let k = 0; k < parts.length; k++) base[k] = +parts[k] || 0;
    }
  }
  if (!base) {
    base = new Float64Array(w * h * 2);
    mvs.forEach((mv, r, c) => {
      const k = (r * w + c) * 2;
      base[k] = mv[0] || 0;
      base[k + 1] = mv[1] || 0;
    });
  }
  const row = V[Math.min(i, V.length - 1)];
  const out = moveBlocks(base, w, h, { px: row[0], py: row[1], scale: row[2], rotate: row[3], swirl: row[4], fluid: row[5], wrong: row[6], unit: UNIT }, state);
  mvs.forEach((mv, r, c) => {
    const k = (r * w + c) * 2;
    mv[0] = out[k];
    mv[1] = out[k + 1];
  });${log ? `
  if (i <= 3) {
    let sum = 0;
    for (let k = 0; k < out.length; k += 2) sum += out[k];
    let back = 0;
    mvs.forEach((mv) => (back += mv[0] || 0));
    log.puts('frame ' + i + ': ' + w + ' x ' + h + ' blocks, motion line ' + (line === null ? 'none' : line === '-' ? '-' : line.split(',').length + ' numbers') + ', replaced ' + replaced + ', mean h ' + (sum / (w * h)).toFixed(2) + ', read back ' + (back / (w * h)).toFixed(2) + '\\n');
    log.flush();
  }` : ''}
}
`
}

/** The script that writes a motion source encode's vectors to `file`: a line a frame, '-' for a frame without any (its keyframe). */
export function motionReaderScript(file: string): string {
  return `// ginosa Datamosh Bake: a motion source's vectors, a line a frame.
import * as std from 'std';
let out = null;

export function setup(args) {
  args.features = ['mv'];
  out = std.open(${JSON.stringify(file)}, 'w');
}

export function glitch_frame(frame) {
  const mvs = frame.mv ? frame.mv.forward : null;
  if (!mvs) {
    out.puts('-\\n');
    out.flush();
    return;
  }
  const w = mvs.width;
  const a = new Array(w * mvs.height * 2);
  mvs.forEach((mv, r, c) => {
    const k = (r * w + c) * 2;
    a[k] = mv[0] || 0;
    a[k + 1] = mv[1] || 0;
  });
  out.puts(a.join(',') + '\\n');
  out.flush();
}
`
}

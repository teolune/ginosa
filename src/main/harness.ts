import { mkdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { HarnessJob, TestEffect } from '@shared/ipc'
import { mediaUrlForPath } from '@shared/ipc'

/**
 * Render harness: renders chosen frames of a file through the real GPU pipeline
 * to PNG, without showing a window. Used by `npm run render -- --input <file> ...`.
 *
 * Flags:
 *   --input <path>        video file (required)
 *   --frames 0,24,48      frame indices (default 0)
 *   --effect none|invert  test effect (default none)
 *   --amount 0..1         effect amount (default 1)
 *   --out <dir>           output folder (default renders/<input name>)
 *   --show                show the window while rendering (debugging)
 */
export interface HarnessOptions {
  job: HarnessJob
  show: boolean
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

export function isHarnessRun(argv: string[]): boolean {
  return argv.includes('--render-harness')
}

export function parseHarnessArgs(argv: string[], cwd: string): HarnessOptions {
  const inputArg = flagValue(argv, '--input')
  if (!inputArg) throw new Error('Render harness needs --input <video file>')
  const input = isAbsolute(inputArg) ? inputArg : resolve(cwd, inputArg)

  const framesArg = flagValue(argv, '--frames') ?? '0'
  const frames = framesArg
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
  if (frames.length === 0 || frames.some((frame) => !Number.isInteger(frame) || frame < 0)) {
    throw new Error(`--frames must be a comma-separated list of frame numbers, got "${framesArg}"`)
  }

  const effectArg = flagValue(argv, '--effect') ?? 'none'
  if (effectArg !== 'none' && effectArg !== 'invert') {
    throw new Error(`--effect must be none or invert, got "${effectArg}"`)
  }
  const effect: TestEffect = effectArg

  const amount = Number(flagValue(argv, '--amount') ?? '1')
  if (!Number.isFinite(amount) || amount < 0 || amount > 1) throw new Error('--amount must be between 0 and 1')

  const stem = basename(input).replace(/\.[^.]+$/, '')
  const outArg = flagValue(argv, '--out') ?? join('renders', stem)
  const outDir = isAbsolute(outArg) ? outArg : resolve(cwd, outArg)

  return {
    job: { input, inputUrl: mediaUrlForPath(input), frames, effect, amount, outDir },
    show: argv.includes('--show')
  }
}

/** Writes a file the renderer produced. Only ever writes inside the job's output folder. */
export async function writeHarnessFile(job: HarnessJob, name: string, data: ArrayBuffer | Uint8Array): Promise<string> {
  const safeName = basename(name)
  if (safeName !== name || safeName.startsWith('.')) throw new Error(`Refusing to write unsafe file name "${name}"`)
  await mkdir(job.outDir, { recursive: true })
  const target = join(job.outDir, safeName)
  await writeFile(target, data instanceof Uint8Array ? data : new Uint8Array(data))
  return target
}

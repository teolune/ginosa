import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Finds and runs the Homebrew FFmpeg tools. Apps launched from Finder don't get
 * the Terminal's PATH, so the usual Homebrew locations are searched explicitly.
 */

const SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
const cache = new Map<string, string>()

export class ToolMissingError extends Error {}

export async function findTool(name: 'ffmpeg' | 'ffprobe'): Promise<string> {
  const cached = cache.get(name)
  if (cached) return cached
  const override = process.env[`GINOSA_${name.toUpperCase()}`]
  const dirs = [...SEARCH_DIRS, ...(process.env['PATH'] ?? '').split(delimiter)]
  for (const candidate of [override, ...dirs.map((dir) => join(dir, name))]) {
    if (!candidate) continue
    try {
      await access(candidate, constants.X_OK)
      cache.set(name, candidate)
      return candidate
    } catch {
      // keep looking
    }
  }
  throw new ToolMissingError(`${name} was not found. Install it with: brew install ffmpeg`)
}

export interface RunResult {
  code: number
  stdout: Buffer
  stderr: string
}

export interface RunOptions {
  signal?: AbortSignal
  onStdout?(chunk: Buffer): void
  /** Collect stdout into the result (off for large binary streams handled by onStdout). */
  collect?: boolean
}

export async function runTool(name: 'ffmpeg' | 'ffprobe', args: string[], options: RunOptions = {}): Promise<RunResult> {
  const bin = await findTool(name)
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      options.onStdout?.(chunk)
      if (options.collect !== false) chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
    })
    const abort = () => child.kill('SIGTERM')
    options.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', reject)
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', abort)
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr })
    })
  })
}

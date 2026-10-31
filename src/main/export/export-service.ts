import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { exportProblem, ffmpegArgs, wavHeader, type ExportSettings } from '../../engine/export/export-settings'
import type { FrameRate } from '../../engine/time'
import type { ExportBegin, ExportResult } from '../../shared/ipc'
import { findTool } from '../media/ffmpeg'
import { probeFile } from '../media/media-files'

/**
 * Runs exports: the renderer sends the mixed-down sound, then raw Y'CbCr frames, and
 * FFmpeg encodes and muxes them. The file is written next to the destination under a
 * hidden name and renamed only when FFmpeg succeeds, so a cancelled or failed export
 * never replaces an existing file or leaves a broken one.
 */
interface Job {
  id: string
  settings: ExportSettings
  width: number
  height: number
  rate: FrameRate
  output: string
  partial: string
  temp: string
  audioPath: string
  audio: WriteStream
  ffmpeg: ChildProcessWithoutNullStreams | null
  stderr: string
  exited: Promise<number> | null
  framesWritten: number
}

const jobs = new Map<string, Job>()

function partialPath(output: string): string {
  return join(dirname(output), `.${basename(output, extname(output))}.ginosa-partial${extname(output)}`)
}

async function cleanup(job: Job): Promise<void> {
  jobs.delete(job.id)
  job.audio.destroy()
  await rm(job.temp, { recursive: true, force: true })
}

export function registerExportIpc(): void {
  ipcMain.handle('export:chooseFile', async (event, suggestedName: string, extension: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = {
      title: 'Export',
      buttonLabel: 'Export',
      defaultPath: suggestedName,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
    }
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    return result.canceled || !result.filePath ? null : result.filePath
  })

  ipcMain.handle('export:begin', async (_event, request: ExportBegin) => {
    const problem = exportProblem(request.settings, request.width, request.height)
    if (problem) throw new Error(problem)
    await findTool('ffmpeg')
    const temp = await mkdtemp(join(tmpdir(), 'ginosa-export-'))
    const audioPath = join(temp, 'mix.wav')
    const audio = createWriteStream(audioPath)
    audio.write(wavHeader(request.audioFrames, request.sampleRate))
    const id = globalThis.crypto.randomUUID()
    jobs.set(id, {
      id,
      settings: request.settings,
      width: request.width,
      height: request.height,
      rate: request.rate,
      output: request.output,
      partial: partialPath(request.output),
      temp,
      audioPath,
      audio,
      ffmpeg: null,
      stderr: '',
      exited: null,
      framesWritten: 0
    })
    return id
  })

  /** Interleaved 32-bit float stereo samples, in order. */
  ipcMain.handle('export:audio', async (_event, id: string, samples: Uint8Array) => {
    const job = jobs.get(id)
    if (!job) throw new Error('That export was cancelled')
    if (!job.audio.write(samples)) await once(job.audio, 'drain')
  })

  ipcMain.handle('export:startVideo', async (_event, id: string) => {
    const job = jobs.get(id)
    if (!job) throw new Error('That export was cancelled')
    job.audio.end()
    await once(job.audio, 'close')
    const bin = await findTool('ffmpeg')
    const args = ffmpegArgs(job.settings, { width: job.width, height: job.height, rate: job.rate, audioPath: job.audioPath, output: job.partial })
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    job.ffmpeg = child
    child.stderr.on('data', (chunk: Buffer) => {
      job.stderr = (job.stderr + chunk.toString()).slice(-16_000)
    })
    child.stdin.on('error', () => undefined) // reported through the exit code
    job.exited = new Promise((resolve) => child.on('close', (code) => resolve(code ?? -1)))
  })

  ipcMain.handle('export:frame', async (_event, id: string, bytes: Uint8Array) => {
    const job = jobs.get(id)
    if (!job?.ffmpeg) throw new Error('That export was cancelled')
    if (job.ffmpeg.exitCode !== null) throw new Error(`FFmpeg stopped: ${job.stderr.trim().split('\n').pop() ?? 'unknown error'}`)
    if (!job.ffmpeg.stdin.write(bytes)) await Promise.race([once(job.ffmpeg.stdin, 'drain'), job.exited])
    job.framesWritten++
  })

  ipcMain.handle('export:finish', async (_event, id: string): Promise<ExportResult> => {
    const job = jobs.get(id)
    if (!job?.ffmpeg || !job.exited) throw new Error('That export was cancelled')
    job.ffmpeg.stdin.end()
    const code = await job.exited
    try {
      if (code !== 0) throw new Error(`FFmpeg failed: ${job.stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`}`)
      await rename(job.partial, job.output)
      const size = (await stat(job.output)).size
      const probe = await probeFile(job.output)
      return { path: job.output, size, frames: job.framesWritten, info: probe.ok ? probe.file.info : null }
    } catch (error) {
      await rm(job.partial, { force: true })
      throw error
    } finally {
      await cleanup(job)
    }
  })

  ipcMain.handle('export:cancel', async (_event, id: string) => {
    const job = jobs.get(id)
    if (!job) return
    job.ffmpeg?.kill('SIGKILL')
    if (job.exited) await job.exited
    await rm(job.partial, { force: true })
    await cleanup(job)
  })
}

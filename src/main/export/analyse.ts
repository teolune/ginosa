import { runTool } from '../media/ffmpeg'

/**
 * Reads an exported file back for the export tests: the picture's middle row in every
 * frame (as full-range RGB via the BT.709 matrix, which is what the file is tagged
 * with), the beeps in its sound, and when each stream starts.
 */
import type { ExportAnalysis } from '../../shared/ipc'

const ROWS = 4

/** Planar Y'CbCr layouts the exports produce: chroma subsampling (log2) and bit depth. */
const PLANAR: Record<string, { sx: number; sy: number; depth: number }> = {
  yuv420p: { sx: 1, sy: 1, depth: 8 },
  yuv420p10le: { sx: 1, sy: 1, depth: 10 },
  yuv422p10le: { sx: 1, sy: 0, depth: 10 },
  yuv444p10le: { sx: 0, sy: 0, depth: 10 },
  yuv444p12le: { sx: 0, sy: 0, depth: 12 }
}

export async function analyseExport(path: string, xs: number[]): Promise<ExportAnalysis> {
  const probe = await runTool('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path])
  if (probe.code !== 0) throw new Error(probe.stderr)
  const streams = (JSON.parse(probe.stdout.toString()) as { streams: Array<Record<string, string | number | undefined>> }).streams
  const video = streams.find((s) => s['codec_type'] === 'video')!
  const audio = streams.find((s) => s['codec_type'] === 'audio')
  const width = Number(video['width'])
  const height = Number(video['height'])
  const [num, den] = String(video['avg_frame_rate']).split('/').map(Number)
  const fps = num! / (den || 1)

  // The middle 4 rows in the file's own Y'CbCr (a crop changes no values; an even count on
  // an even line, since 4:2:0 crops round to even), converted here with exact BT.709
  // limited-range maths so the check is as precise as the file.
  const layout = PLANAR[String(video['pix_fmt'])]
  if (!layout) throw new Error(`The analyser doesn't read ${String(video['pix_fmt'])} yet`)
  const rowsRun = await runTool('ffmpeg', [
    '-v', 'error', '-i', path, '-map', '0:v:0', '-fps_mode', 'passthrough',
    '-vf', `crop=iw:${ROWS}:0:${Math.floor(height / 4) * 2 - 2}`,
    '-f', 'rawvideo', '-'
  ])
  if (rowsRun.code !== 0) throw new Error(rowsRun.stderr)
  const raw = rowsRun.stdout
  const bytes = layout.depth > 8 ? 2 : 1
  const cw = width >> layout.sx
  const ch = ROWS >> layout.sy
  const lumaBytes = width * ROWS * bytes
  const chromaBytes = cw * ch * bytes
  const frameBytes = lumaBytes + 2 * chromaBytes
  const read = (offset: number) => (bytes === 2 ? raw.readUInt16LE(offset) : raw[offset]!)
  const scale = 2 ** (layout.depth - 8)
  const rows: number[][][] = []
  for (let at = 0; at + frameBytes <= raw.length; at += frameBytes) {
    rows.push(
      xs.map((x) => {
        const sum = [0, 0, 0]
        let n = 0
        for (let row = 0; row < ROWS; row++)
          for (let dx = -1; dx <= 1; dx++) {
            const px = Math.min(width - 1, Math.max(0, x + dx))
            const y = (read(at + (row * width + px) * bytes) / scale - 16) / 219
            const ci = ((row >> layout.sy) * cw + (px >> layout.sx)) * bytes
            const cb = (read(at + lumaBytes + ci) / scale - 128) / 224
            const cr = (read(at + lumaBytes + chromaBytes + ci) / scale - 128) / 224
            const r = y + 1.5748 * cr
            const b = y + 1.8556 * cb
            const g = (y - 0.2126 * r - 0.0722 * b) / 0.7152
            sum[0] = sum[0]! + r
            sum[1] = sum[1]! + g
            sum[2] = sum[2]! + b
            n++
          }
        return sum.map((v) => Math.round((v / n) * 10000) / 10000)
      })
    )
  }

  let onsets: number[] = []
  if (audio) {
    const audioRun = await runTool('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
    if (audioRun.code !== 0) throw new Error(audioRun.stderr)
    const pcm = audioRun.stdout
    let quiet = Number.POSITIVE_INFINITY
    for (let i = 0; i + 4 <= pcm.length; i += 4) {
      const v = Math.abs(pcm.readFloatLE(i))
      if (v > 0.1 && quiet >= 0.3 * 48000) onsets.push(i / 4 / 48000)
      quiet = v > 0.1 ? 0 : quiet + 1
    }
    onsets = onsets.map((t) => Math.round(t * 1e6) / 1e6)
  }
  const start = (s: Record<string, string | number | undefined> | undefined) => (s && s['start_time'] !== undefined ? Number(s['start_time']) : 0)
  const tag = (key: string) => (video[key] === undefined ? null : String(video[key]))
  return {
    width,
    height,
    fps,
    videoStart: start(video),
    audioStart: start(audio),
    rows,
    onsets,
    tags: { primaries: tag('color_primaries'), transfer: tag('color_transfer'), matrix: tag('color_space'), range: tag('color_range') }
  }
}

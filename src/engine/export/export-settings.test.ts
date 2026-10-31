import { describe, expect, it } from 'vitest'
import { FRAME_RATES } from '../time'
import { DEFAULT_EXPORT, exportProblem, ffmpegArgs, frameBytes, suggestedBitrate, wavHeader, type ExportSettings } from './export-settings'

const job = { width: 1920, height: 1080, rate: FRAME_RATES['25'], audioPath: '/tmp/mix.wav', output: '/out/film.mp4' }
const value = (args: string[], flag: string, after = 0) => {
  let index = -1
  for (let i = 0, seen = 0; i < args.length; i++) if (args[i] === flag && seen++ === after) index = i
  return index >= 0 ? args[index + 1] : undefined
}

describe('export settings', () => {
  it('pipes raw frames in the layout each codec wants', () => {
    expect(frameBytes('nv12', 1920, 1080)).toBe(1920 * 1080 * 1.5)
    expect(frameBytes('p010le', 1920, 1080)).toBe(1920 * 1080 * 3)
    expect(frameBytes('yuv422p10le', 1920, 1080)).toBe(1920 * 1080 * 4)
    expect(frameBytes('yuv444p10le', 1920, 1080)).toBe(1920 * 1080 * 6)
  })

  it('encodes H.264 in hardware with Rec.709 tags on input and output, and AAC sound', () => {
    const args = ffmpegArgs(DEFAULT_EXPORT, job)
    expect(value(args, '-pix_fmt')).toBe('nv12')
    expect(value(args, '-s')).toBe('1920x1080')
    expect(value(args, '-r')).toBe('25/1')
    expect(value(args, '-c:v')).toBe('h264_videotoolbox')
    expect(value(args, '-b:v')).toBe('40M')
    expect(value(args, '-g')).toBe('25')
    expect(value(args, '-allow_sw')).toBe('0')
    for (const n of [0, 1]) {
      expect(value(args, '-color_primaries', n)).toBe('bt709')
      expect(value(args, '-color_trc', n)).toBe('bt709')
      expect(value(args, '-colorspace', n)).toBe('bt709')
      expect(value(args, '-color_range', n)).toBe('tv')
    }
    expect(value(args, '-c:a')).toBe('aac_at')
    expect(value(args, '-i')).toBe('pipe:0')
    expect(value(args, '-i', 1)).toBe('/tmp/mix.wav')
    expect(args.at(-1)).toBe('/out/film.mp4')
  })

  it('uses Main 10 for 10-bit HEVC, prores_ks for ProRes with PCM sound, and the exact NTSC rate', () => {
    const hevc = ffmpegArgs({ ...DEFAULT_EXPORT, format: 'hevc10', container: 'mov' }, { ...job, rate: FRAME_RATES['29.97'] })
    expect(value(hevc, '-pix_fmt')).toBe('p010le')
    expect(value(hevc, '-profile:v')).toBe('main10')
    expect(value(hevc, '-tag:v')).toBe('hvc1')
    expect(value(hevc, '-r')).toBe('30000/1001')
    expect(value(hevc, '-g')).toBe('30')
    expect(value(hevc, '-f')).toBe('rawvideo')
    expect(hevc[hevc.indexOf('-f', hevc.indexOf('-movflags'))+1]).toBe('mov')
    const prores = ffmpegArgs({ ...DEFAULT_EXPORT, format: 'prores-422hq', container: 'mov' }, job)
    expect(value(prores, '-pix_fmt')).toBe('yuv422p10le')
    expect(value(prores, '-c:v')).toBe('prores_ks')
    expect(value(prores, '-profile:v')).toBe('3')
    expect(value(prores, '-c:a')).toBe('pcm_s24le')
    expect(value(ffmpegArgs({ ...DEFAULT_EXPORT, format: 'prores-4444', container: 'mov' }, job), '-pix_fmt')).toBe('yuv444p10le')
  })

  it('refuses settings that would fail', () => {
    const ok: ExportSettings = DEFAULT_EXPORT
    expect(exportProblem(ok, 1920, 1080)).toBeNull()
    expect(exportProblem({ ...ok, format: 'prores-422hq', container: 'mp4' }, 1920, 1080)).toMatch(/MOV/)
    expect(exportProblem(ok, 1081, 1080)).toMatch(/even/)
    expect(exportProblem({ ...ok, bitrateMbps: 0 }, 1920, 1080)).toMatch(/Bitrate/)
  })

  it('suggests bitrates by pixels per second', () => {
    expect(suggestedBitrate(1920, 1080, FRAME_RATES['25'], 'h264')).toBe(40)
    expect(suggestedBitrate(1080, 1920, FRAME_RATES['25'], 'hevc')).toBe(30)
    expect(suggestedBitrate(3840, 2160, FRAME_RATES['50'], 'h264')).toBe(320)
  })

  it('writes a float WAV header for the mixdown', () => {
    const header = new DataView(wavHeader(48_000, 48_000).buffer)
    expect(String.fromCharCode(...new Uint8Array(header.buffer, 0, 4))).toBe('RIFF')
    expect(header.getUint16(20, true)).toBe(3)
    expect(header.getUint16(22, true)).toBe(2)
    expect(header.getUint32(24, true)).toBe(48_000)
    expect(header.getUint32(40, true)).toBe(48_000 * 2 * 4)
  })
})

import { describe, expect, it } from 'vitest'
import { escapeRbsp, findSpsColour, hvccTransfer, rewriteHvcc, rewriteSample, rewriteSpsTransfer, unescapeRbsp } from './hevc-sps'

/**
 * Real SPS units from x265 (various settings), Apple's VideoToolbox (as an iPhone
 * writes), and a hand-built one using every branch x265 skips: sub-layers, scaling
 * lists, PCM, inter-predicted reference picture sets, long-term refs, extended SAR.
 * Expected offsets come from FFmpeg's trace_headers (its bit position minus the 16-bit
 * NAL header); FFmpeg also re-read each rewritten SPS cleanly with transfer 2.
 */
const FIXTURES = {
  hlg_default: {
    offset: 211,
    transfer: 18,
    sps:
      '42010102200000030090000003000003003ca00a080b9f6d96566924caf016a122412080000003008000000c84'
  },
  pq_scaling: {
    offset: 212,
    transfer: 16,
    sps:
      '42010102200000030090000003000003003ca00a080b9f6d96566924ed780b5091009040000003004000000642'
  },
  hlg_sar: {
    offset: 212,
    transfer: 18,
    sps:
      '42010102200000030090000003000003003ca00a080b9f6d96566924caf0ea3091209040000003004000000642'
  },
  pq_hdr10: {
    offset: 213,
    transfer: 16,
    sps:
      '42010102200000030090000003000003003ca00a080b9f6d96662a4932bc05a84880482000000300200000030321'
  },
  hlg_lowdelay: {
    offset: 207,
    transfer: 18,
    sps:
      '42010102200000030090000003000003003ca00a080b9f6d965a924caf016a12241208000003000800000300c840'
  },
  synthetic: {
    offset: 2018,
    transfer: 18,
    sps:
      '420104022000000300900000030000030078d00002200000030090000003000003005a5aa00a080b9f6d96472391e4912dd325325325321699299299' +
      '2990b4c94c94c94c9a64a64a64a64a64a64a64a64a64a64a64a64a64a64a64a642d32532532532532532532532532532532532532532532532169929' +
      '9299299299299299299299299299299299299299299099e992992992992992992992992992992992992992992992990a7a64a64a64a64a64a64a64a6' +
      '4a64a64a64a64a64a64a64a6429e9929929929929929929929929929929929929929929929927a64a64a64a64a64a64a64a64a64a64a64a64a64a64a' +
      '64a642eef52b5aa7a65697b05e43ffc0010000fd4244824020'
  },
  videotoolbox: {
    offset: 257,
    transfer: 18,
    sps: '420101022000000300b0000003000003005da00280802d136205ee45914bff2e7f13fac05a8489048040'
  }
}

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))
const bitsOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(2).padStart(8, '0')).join('')

/** A minimal hvcC: 23-byte header, then VPS-free arrays holding this SPS (and a fake PPS). */
function hvcc(sps: Uint8Array): Uint8Array {
  const header = new Uint8Array(23)
  header[0] = 1
  header[21] = 0xf3 // lengthSizeMinusOne = 3
  header[22] = 2
  const pps = Uint8Array.of(0x44, 0x01, 0xc1, 0x72, 0xb4, 0x62, 0x40)
  return Uint8Array.from([...header, 0xa1, 0, 1, sps.length >> 8, sps.length & 255, ...sps, 0xa2, 0, 1, 0, pps.length, ...pps])
}

describe('HEVC SPS colour description', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`finds it where FFmpeg does, and rewrites only the transfer (${name})`, () => {
      const nal = hex(fixture.sps)
      const before = unescapeRbsp(nal.subarray(2))
      expect(findSpsColour(before)).toEqual({ offset: fixture.offset, primaries: 9, transfer: fixture.transfer, matrix: 9 })
      const rewritten = rewriteSpsTransfer(nal, 2)!
      const after = unescapeRbsp(rewritten.subarray(2))
      expect(findSpsColour(after)).toEqual({ offset: fixture.offset, primaries: 9, transfer: 2, matrix: 9 })
      const [a, b] = [bitsOf(before), bitsOf(after)]
      expect(b.length).toBe(a.length)
      for (let i = 0; i < a.length; i++) if (i < fixture.offset + 8 || i >= fixture.offset + 16) expect(b[i], `bit ${i}`).toBe(a[i])
      expect(rewritten.subarray(0, 2)).toEqual(nal.subarray(0, 2))
    })
  }

  it('leaves an SPS alone when the transfer is already right, or when it isn’t an SPS', () => {
    const nal = hex(FIXTURES.hlg_default.sps)
    expect(rewriteSpsTransfer(nal, 18)).toBeNull()
    expect(rewriteSpsTransfer(Uint8Array.of(0x44, 0x01, 0xc1), 2)).toBeNull()
  })

  it('refuses a truncated SPS rather than guessing', () => {
    const nal = hex(FIXTURES.synthetic.sps).subarray(0, 120)
    expect(() => rewriteSpsTransfer(nal, 2)).toThrow(/ended early/)
  })

  it('escapes and unescapes emulation-prevention bytes', () => {
    const raw = Uint8Array.of(0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 5)
    const escaped = escapeRbsp(raw)
    expect(Array.from(escaped)).toEqual([0, 0, 3, 0, 1, 0, 0, 3, 2, 0, 0, 3, 3, 0, 0, 4, 5])
    expect(unescapeRbsp(escaped)).toEqual(raw)
  })

  it('rewrites the SPS inside an hvcC record, keeping the rest', () => {
    const record = hvcc(hex(FIXTURES.videotoolbox.sps))
    expect(hvccTransfer(record)).toBe(18)
    const rewritten = rewriteHvcc(record, 2)!
    expect(hvccTransfer(rewritten)).toBe(2)
    expect(rewritten.length).toBe(record.length)
    expect(rewritten.subarray(0, 23)).toEqual(record.subarray(0, 23))
    expect(rewritten.subarray(rewritten.length - 9)).toEqual(record.subarray(record.length - 9))
    expect(rewriteHvcc(rewritten, 2)).toBeNull()
  })

  it('rewrites an SPS repeated inside a sample, and leaves samples without one untouched', () => {
    const sps = hex(FIXTURES.pq_hdr10.sps)
    const slice = Uint8Array.of(0x26, 0x01, 0xaf, 0x09, 0x40)
    const sample = Uint8Array.from([0, 0, 0, sps.length, ...sps, 0, 0, 0, slice.length, ...slice])
    const rewritten = rewriteSample(sample, 4, 2)!
    const length = (rewritten[3]! | (rewritten[2]! << 8)) >>> 0
    expect(findSpsColour(unescapeRbsp(rewritten.subarray(6, 4 + length)))!.transfer).toBe(2)
    expect(rewritten.subarray(rewritten.length - slice.length)).toEqual(slice)
    expect(rewriteSample(Uint8Array.from([0, 0, 0, slice.length, ...slice]), 4, 2)).toBeNull()
  })
})

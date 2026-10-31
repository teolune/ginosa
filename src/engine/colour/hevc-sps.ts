/**
 * Reads and rewrites the colour description in an HEVC sequence parameter set (SPS).
 *
 * Why: Chromium tone-maps HLG and PQ frames itself, using the transfer function written
 * in the stream, and ignores ginosa's request for the raw values. Rewriting the SPS's
 * transfer_characteristics to "unspecified" (2) as the file is read makes HDR behave
 * like Apple Log: the decoder hands over the stored values and ginosa converts them on
 * the GPU with its own maths. Only those 8 bits change.
 *
 * Syntax per ITU-T H.265 (V8) §7.3.2.2.1 (SPS), §7.3.3 (profile_tier_level),
 * §7.3.4 (scaling_list_data), §7.3.7 + §7.4.8 (st_ref_pic_set), §E.2.1 (VUI).
 */

export const NAL_SPS = 33
export const TRANSFER_UNSPECIFIED = 2
export const TRANSFER_PQ = 16
export const TRANSFER_HLG = 18

export class BitReader {
  pos = 0
  private readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  bit(): number {
    const byte = this.bytes[this.pos >> 3]
    if (byte === undefined) throw new RangeError('SPS ended early')
    const value = (byte >> (7 - (this.pos & 7))) & 1
    this.pos++
    return value
  }

  u(n: number): number {
    let value = 0
    for (let i = 0; i < n; i++) value = value * 2 + this.bit()
    return value
  }

  skip(n: number): void {
    if (this.pos + n > this.bytes.length * 8) throw new RangeError('SPS ended early')
    this.pos += n
  }

  ue(): number {
    let zeros = 0
    while (this.bit() === 0) {
      if (++zeros > 31) throw new RangeError('Bad Exp-Golomb code in SPS')
    }
    return 2 ** zeros - 1 + this.u(zeros)
  }

  se(): number {
    const k = this.ue()
    return k % 2 === 1 ? (k + 1) / 2 : -k / 2
  }
}

/** Removes emulation-prevention bytes (00 00 03 → 00 00). */
export function unescapeRbsp(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  let n = 0
  let zeros = 0
  for (const byte of bytes) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0
      continue
    }
    out[n++] = byte
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return out.subarray(0, n)
}

/** Adds emulation-prevention bytes where 00 00 is followed by 00–03. */
export function escapeRbsp(bytes: Uint8Array): Uint8Array {
  const out: number[] = []
  let zeros = 0
  for (const byte of bytes) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3)
      zeros = 0
    }
    out.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  return Uint8Array.from(out)
}

function profileTierLevel(r: BitReader, maxSubLayersMinus1: number): void {
  r.skip(88) // general profile space, tier, idc, compatibility flags, constraint flags
  r.skip(8) // general_level_idc
  const profilePresent: number[] = []
  const levelPresent: number[] = []
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(r.bit())
    levelPresent.push(r.bit())
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.skip(2)
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) r.skip(88)
    if (levelPresent[i]) r.skip(8)
  }
}

function scalingListData(r: BitReader): void {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      if (!r.bit()) r.ue() // scaling_list_pred_matrix_id_delta
      else {
        const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)))
        if (sizeId > 1) r.se() // scaling_list_dc_coef_minus8
        for (let i = 0; i < coefNum; i++) r.se()
      }
    }
  }
}

interface RefPicSet {
  s0: number[] // DeltaPocS0
  s1: number[] // DeltaPocS1
}

/** st_ref_pic_set(idx) as it appears in an SPS, with the §7.4.8 derivation so later sets can predict from it. */
function shortTermRefPicSet(r: BitReader, idx: number, sets: RefPicSet[]): RefPicSet {
  const interPrediction = idx !== 0 ? r.bit() : 0
  if (interPrediction) {
    // In an SPS, delta_idx_minus1 isn't sent: the reference is the previous set.
    const ref = sets[idx - 1]!
    const sign = r.bit()
    const deltaRps = (1 - 2 * sign) * (r.ue() + 1)
    const numDeltaPocs = ref.s0.length + ref.s1.length
    const used: number[] = []
    const useDelta: number[] = []
    for (let j = 0; j <= numDeltaPocs; j++) {
      used[j] = r.bit()
      useDelta[j] = used[j] ? 1 : r.bit()
    }
    const s0: number[] = []
    const s1: number[] = []
    const negatives = ref.s0.length
    // Equation 7-61.
    for (let j = ref.s1.length - 1; j >= 0; j--) {
      const dPoc = ref.s1[j]! + deltaRps
      if (dPoc < 0 && useDelta[negatives + j]) s0.push(dPoc)
    }
    if (deltaRps < 0 && useDelta[numDeltaPocs]) s0.push(deltaRps)
    for (let j = 0; j < negatives; j++) {
      const dPoc = ref.s0[j]! + deltaRps
      if (dPoc < 0 && useDelta[j]) s0.push(dPoc)
    }
    // Equation 7-62.
    for (let j = negatives - 1; j >= 0; j--) {
      const dPoc = ref.s0[j]! + deltaRps
      if (dPoc > 0 && useDelta[j]) s1.push(dPoc)
    }
    if (deltaRps > 0 && useDelta[numDeltaPocs]) s1.push(deltaRps)
    for (let j = 0; j < ref.s1.length; j++) {
      const dPoc = ref.s1[j]! + deltaRps
      if (dPoc > 0 && useDelta[negatives + j]) s1.push(dPoc)
    }
    return { s0, s1 }
  }
  const numNegative = r.ue()
  const numPositive = r.ue()
  if (numNegative > 16 || numPositive > 16) throw new RangeError('Bad reference picture set in SPS')
  const s0: number[] = []
  const s1: number[] = []
  let poc = 0
  for (let i = 0; i < numNegative; i++) {
    poc -= r.ue() + 1
    r.bit()
    s0.push(poc)
  }
  poc = 0
  for (let i = 0; i < numPositive; i++) {
    poc += r.ue() + 1
    r.bit()
    s1.push(poc)
  }
  return { s0, s1 }
}

export interface SpsColour {
  /** Bit offset of colour_primaries in the RBSP (after the 2-byte NAL header). */
  offset: number
  primaries: number
  transfer: number
  matrix: number
}

/** Finds the VUI colour description in an SPS RBSP (header removed). Null if the SPS has none. */
export function findSpsColour(rbsp: Uint8Array): SpsColour | null {
  const r = new BitReader(rbsp)
  r.skip(4) // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.u(3)
  r.skip(1) // sps_temporal_id_nesting_flag
  profileTierLevel(r, maxSubLayersMinus1)
  r.ue() // sps_seq_parameter_set_id
  const chromaFormat = r.ue()
  if (chromaFormat === 3) r.skip(1)
  r.ue() // width
  r.ue() // height
  if (r.bit()) for (let i = 0; i < 4; i++) r.ue() // conformance window
  r.ue() // bit_depth_luma_minus8
  r.ue() // bit_depth_chroma_minus8
  const log2MaxPocLsb = r.ue() + 4
  const orderingAll = r.bit()
  for (let i = orderingAll ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
    r.ue()
    r.ue()
    r.ue()
  }
  for (let i = 0; i < 6; i++) r.ue() // block sizes and transform depths
  if (r.bit() && r.bit()) scalingListData(r) // scaling_list_enabled, sps_scaling_list_data_present
  r.skip(2) // amp, sample_adaptive_offset
  if (r.bit()) {
    r.skip(8) // pcm sample bit depths
    r.ue()
    r.ue()
    r.skip(1)
  }
  const numSets = r.ue()
  if (numSets > 64) throw new RangeError('Bad reference picture set count in SPS')
  const sets: RefPicSet[] = []
  for (let i = 0; i < numSets; i++) sets.push(shortTermRefPicSet(r, i, sets))
  if (r.bit()) {
    const count = r.ue()
    for (let i = 0; i < count; i++) r.skip(log2MaxPocLsb + 1)
  }
  r.skip(2) // sps_temporal_mvp_enabled, strong_intra_smoothing_enabled
  if (!r.bit()) return null // vui_parameters_present_flag
  if (r.bit() && r.u(8) === 255) r.skip(32) // aspect ratio, extended SAR
  if (r.bit()) r.skip(1) // overscan
  if (!r.bit()) return null // video_signal_type_present_flag
  r.skip(4) // video_format, video_full_range_flag
  if (!r.bit()) return null // colour_description_present_flag
  const offset = r.pos
  return { offset, primaries: r.u(8), transfer: r.u(8), matrix: r.u(8) }
}

/** A copy of an SPS NAL unit (with its 2-byte header) with a new transfer_characteristics, or null if it has none to change. */
export function rewriteSpsTransfer(nal: Uint8Array, transfer: number): Uint8Array | null {
  if (nal.length < 3 || ((nal[0]! >> 1) & 0x3f) !== NAL_SPS) return null
  const rbsp = unescapeRbsp(nal.subarray(2))
  const colour = findSpsColour(rbsp)
  if (!colour || colour.transfer === transfer) return null
  const at = colour.offset + 8
  const patched = rbsp.slice()
  for (let i = 0; i < 8; i++) {
    const bit = (transfer >> (7 - i)) & 1
    const pos = at + i
    const mask = 1 << (7 - (pos & 7))
    patched[pos >> 3] = bit ? patched[pos >> 3]! | mask : patched[pos >> 3]! & ~mask
  }
  const body = escapeRbsp(patched)
  const out = new Uint8Array(2 + body.length)
  out.set(nal.subarray(0, 2))
  out.set(body, 2)
  return out
}

/** The transfer_characteristics in an hvcC record's first SPS, or null. */
export function hvccTransfer(description: Uint8Array): number | null {
  for (const nal of hvccNals(description)) {
    if (((nal[0]! >> 1) & 0x3f) !== NAL_SPS) continue
    return findSpsColour(unescapeRbsp(nal.subarray(2)))?.transfer ?? null
  }
  return null
}

function* hvccNals(description: Uint8Array): Generator<Uint8Array> {
  if (description.length < 23) return
  let at = 23
  const arrays = description[22]!
  for (let a = 0; a < arrays && at + 3 <= description.length; a++) {
    const count = (description[at + 1]! << 8) | description[at + 2]!
    at += 3
    for (let n = 0; n < count && at + 2 <= description.length; n++) {
      const length = (description[at]! << 8) | description[at + 1]!
      at += 2
      yield description.subarray(at, at + length)
      at += length
    }
  }
}

/** An hvcC (HEVCDecoderConfigurationRecord) with every SPS's transfer rewritten, or null if nothing changed. */
export function rewriteHvcc(description: Uint8Array, transfer: number): Uint8Array | null {
  if (description.length < 23) return null
  const out: number[] = Array.from(description.subarray(0, 23))
  let at = 23
  let changed = false
  const arrays = description[22]!
  for (let a = 0; a < arrays; a++) {
    if (at + 3 > description.length) return null
    const header = description.subarray(at, at + 3)
    const count = (header[1]! << 8) | header[2]!
    out.push(...header)
    at += 3
    for (let n = 0; n < count; n++) {
      if (at + 2 > description.length) return null
      const length = (description[at]! << 8) | description[at + 1]!
      const nal = description.subarray(at + 2, at + 2 + length)
      at += 2 + length
      const rewritten = rewriteSpsTransfer(nal, transfer)
      const result = rewritten ?? nal
      if (rewritten) changed = true
      out.push(result.length >> 8, result.length & 0xff, ...result)
    }
  }
  out.push(...description.subarray(at))
  return changed ? Uint8Array.from(out) : null
}

/** The length field size from an hvcC (lengthSizeMinusOne + 1). */
export function hvccLengthSize(description: Uint8Array): number {
  return ((description[21] ?? 3) & 3) + 1
}

/**
 * A sample (length-prefixed NAL units, as stored in MP4/MOV) with any in-band SPS
 * rewritten, or null if it has none to change.
 */
export function rewriteSample(data: Uint8Array, lengthSize: number, transfer: number): Uint8Array | null {
  // Most samples carry no SPS: check the NAL types first without copying anything.
  let scan = 0
  let hasSps = false
  while (scan + lengthSize < data.length) {
    let length = 0
    for (let i = 0; i < lengthSize; i++) length = length * 256 + data[scan + i]!
    if (((data[scan + lengthSize]! >> 1) & 0x3f) === NAL_SPS) hasSps = true
    scan += lengthSize + length
  }
  if (!hasSps) return null
  const parts: Uint8Array[] = []
  let changed = false
  let at = 0
  while (at + lengthSize <= data.length) {
    let length = 0
    for (let i = 0; i < lengthSize; i++) length = length * 256 + data[at + i]!
    const nal = data.subarray(at + lengthSize, at + lengthSize + length)
    at += lengthSize + length
    const rewritten = nal.length > 0 && ((nal[0]! >> 1) & 0x3f) === NAL_SPS ? rewriteSpsTransfer(nal, transfer) : null
    if (rewritten) changed = true
    const body = rewritten ?? nal
    const prefix = new Uint8Array(lengthSize)
    for (let i = 0, v = body.length; i < lengthSize; i++, v = Math.floor(v / 256)) prefix[lengthSize - 1 - i] = v & 0xff
    parts.push(prefix, body)
  }
  if (!changed) return null
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

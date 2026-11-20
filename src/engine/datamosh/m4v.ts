/**
 * MPEG-4 Part 2 elementary streams (M15): cutting one into its frames and joining frames back,
 * for Datamosh Bake's frame surgery (bake-plan.ts says which frames go where).
 *
 * A frame is a VOP (start code 00 00 01 B6); a GOV header (00 00 01 B3) belongs with the frame
 * after it. Everything before the first frame (the VOS and VOL headers) is the stream's head.
 * The same as scripts/codec-mosh.py, which made M14's references.
 */

const VOP = 0xb6
const GOV = 0xb3

/** Where each start code with this last byte begins. */
function startCodes(data: Uint8Array, code: number, from = 0, to = data.length): number[] {
  const out: number[] = []
  for (let i = from; i + 3 < to; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && data[i + 3] === code) {
      out.push(i)
      i += 3
    }
  }
  return out
}

export interface M4vStream {
  head: Uint8Array
  frames: Uint8Array[]
}

export function splitM4v(data: Uint8Array): M4vStream {
  const vops = startCodes(data, VOP)
  if (vops.length === 0) throw new Error('No frames in this MPEG-4 stream')
  // Each frame starts at its GOV header when one comes just before it.
  const starts = vops.map((at, n) => {
    const from = n === 0 ? 0 : vops[n - 1]! + 4
    const govs = startCodes(data, GOV, from, at)
    return govs.length ? govs[govs.length - 1]! : at
  })
  const frames = starts.map((at, n) => data.subarray(at, n + 1 < starts.length ? starts[n + 1]! : data.length))
  return { head: data.subarray(0, starts[0]!), frames }
}

/** A frame's coding type, from the two bits after its VOP start code: I, P, B or S. */
export function frameKind(frame: Uint8Array): 'I' | 'P' | 'B' | 'S' {
  const at = startCodes(frame, VOP)[0]
  if (at === undefined || at + 4 >= frame.length) throw new Error('Not a frame')
  return (['I', 'P', 'B', 'S'] as const)[frame[at + 4]! >> 6]!
}

/** The stream with its frames in this order (each an index into `stream.frames`). */
export function joinM4v(stream: M4vStream, order: readonly number[]): Uint8Array {
  const parts = order.map((i) => {
    const f = stream.frames[i]
    if (!f) throw new Error(`No frame ${i}`)
    return f
  })
  const out = new Uint8Array(stream.head.length + parts.reduce((n, p) => n + p.length, 0))
  out.set(stream.head, 0)
  let at = stream.head.length
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

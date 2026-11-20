import { beatAt, beatTime } from '../audio/beat-grid'
import { tempoGrid } from '../audio/tempo-map'
import type { ParamValue } from '../effects/types'
import { DEFAULT_GRID } from '../modulation/curve'
import type { Clip, Sequence } from '../project/model'
import type { Ticks } from '../time'
import { channelHits, hitBeat } from '../timeline/rack'
import { visibleFrom } from '../timeline/render-plan'
import { clipEnd, frameTicks, tracksOf } from '../timeline/timeline'

/**
 * Datamosh Bake (M15, decision 133): what a bake does, worked out before anything is encoded.
 *
 * The span's frames are encoded as MPEG-4 Part 2 with keyframes (I-frames) only where this plan
 * puts them: the span's first frame, every cut beneath an adjustment layer, and every heal. The
 * encoded frames are then put back in an order (`order`): a melt shows, at the cut, the frame
 * before again in place of the cut's keyframe, so the new shot's P-frames (its motion and its
 * residual) land on the old picture; a bloom shows one P-frame several times, so its motion
 * keeps pushing; a heal shows its keyframe, so the picture clears. The length never changes,
 * so the bake stays in time with the timeline.
 */

export const BAKE_EFFECT_ID = 'datamosh-bake'
/** Bumped when baking itself changes (the plan, the encoder's settings, the script), so old bakes aren't reused. */
export const BAKE_VERSION = 1

export type CutAction = 'melt' | 'meltBloom' | 'clean'
export type MomentAction = 'bloom' | 'heal'

export interface BakeSettings {
  cuts: CutAction
  /** A Channel Rack row id, or '' for none. */
  channel: string
  channelAction: MomentAction
  /** Beats between beat-grid moments, or 0 for none. */
  everyBeats: number
  everyAction: MomentAction
  markers: MomentAction | 'off'
  bloomFrames: number
  healAfter: number
  /** The codec's block size in pixels of a 1080-high picture: 16, 32 or 64. */
  blockSize: number
  /** MPEG-4's quantiser (1 finest to 31 coarsest). */
  quantiser: number
  seed: number
  /** A video track id, or '' for none. */
  motionSource: string
}

const QUANTISERS: Record<string, number> = { fine: 2, normal: 5, rough: 12, crushed: 24 }

/** Beats between moments for each Every choice (bars counted on the grid's bar length). */
function everyBeats(id: string, beatsPerBar: number): number {
  switch (id) {
    case 'beat':
      return 1
    case '2beats':
      return 2
    case 'bar':
      return beatsPerBar
    case '2bars':
      return 2 * beatsPerBar
    case '4bars':
      return 4 * beatsPerBar
    case '8bars':
      return 8 * beatsPerBar
    default:
      return 0
  }
}

/** The bake's settings from the effect's values (as they are at the span's start; the moments and codec settings don't animate). */
export function bakeSettings(params: Record<string, ParamValue>, beatsPerBar = 4): BakeSettings {
  const str = (id: string, fallback: string) => (typeof params[id] === 'string' ? (params[id] as string) : fallback)
  const num = (id: string, fallback: number) => (typeof params[id] === 'number' && Number.isFinite(params[id]) ? (params[id] as number) : fallback)
  const action = (id: string): MomentAction => (str(id, 'bloom') === 'heal' ? 'heal' : 'bloom')
  const cuts = str('cuts', 'melt')
  const markers = str('markers', 'off')
  const block = Number(str('blockSize', '16'))
  return {
    cuts: cuts === 'meltBloom' || cuts === 'clean' ? cuts : 'melt',
    channel: str('channel', ''),
    channelAction: action('channelAction'),
    everyBeats: everyBeats(str('every', 'off'), beatsPerBar),
    everyAction: action('everyAction'),
    markers: markers === 'bloom' || markers === 'heal' ? markers : 'off',
    bloomFrames: Math.max(1, Math.min(120, Math.round(num('bloomFrames', 8)))),
    healAfter: Math.max(0, Math.round(num('healAfter', 0))),
    blockSize: block === 32 || block === 64 ? block : 16,
    quantiser: QUANTISERS[str('quality', 'normal')] ?? 5,
    seed: Math.max(0, Math.round(num('seed', 1))),
    motionSource: str('motionSource', '')
  }
}

/** Where a bake sits on the timeline: from the clip's first visible frame to its end, in whole frames. */
export interface BakeSpan {
  start: Ticks
  /** The sequence frame number of the span's first frame. */
  first: number
  frames: number
}

export function bakeSpan(sequence: Sequence, clip: Clip): BakeSpan {
  const frame = frameTicks(sequence)
  const first = Math.round(visibleFrom(sequence, clip) / frame)
  const last = Math.round(clipEnd(clip) / frame)
  return { start: first * frame, first, frames: Math.max(0, last - first) }
}

/** The size the span is encoded at: its picture scaled so a 16-pixel macroblock covers `blockSize` pixels of a 1080-high picture, even on both sides. */
export function bakeSize(input: { width: number; height: number }, blockSize: number): { width: number; height: number; scale: number } {
  const scale = Math.min(1, ((16 / blockSize) * 1080) / Math.max(1, input.height))
  const even = (v: number) => Math.max(16, 2 * Math.round((v * scale) / 2))
  return { width: even(input.width), height: even(input.height), scale }
}

export type MomentKind = 'cut' | 'channel' | 'beat' | 'marker'

/** A moment in the span (frames from its start) and what happens there. */
export interface Moment {
  frame: number
  kind: MomentKind
  action: CutAction | MomentAction
}

/**
 * Every moment in the span, in frame order: cuts beneath an adjustment layer (the edges of the
 * clips on the video tracks below it), each cube of the chosen channel, the beat grid every
 * `everyBeats`, and markers. A moment on the span's first frame is left out (it's a keyframe anyway).
 */
export function bakeMoments(sequence: Sequence, clip: Clip, settings: BakeSettings, span: BakeSpan): Moment[] {
  const frame = frameTicks(sequence)
  const out: Moment[] = []
  const add = (time: Ticks, kind: MomentKind, action: Moment['action']) => {
    const f = Math.round(time / frame) - span.first
    if (f > 0 && f < span.frames) out.push({ frame: f, kind, action })
  }
  if (clip.adjustment) {
    const tracks = tracksOf(sequence, 'video')
    const below = new Set(tracks.slice(0, Math.max(0, tracks.findIndex((t) => t.id === clip.trackId))).map((t) => t.id))
    const edges = new Set<number>()
    for (const c of sequence.clips) if (below.has(c.trackId) && !c.automation) for (const edge of [c.start, clipEnd(c)]) edges.add(Math.round(edge / frame))
    for (const edge of edges) add(edge * frame, 'cut', settings.cuts)
  }
  const grid = tempoGrid(sequence) ?? DEFAULT_GRID
  if (settings.channel) {
    const row = sequence.rack.rows.find((r) => r.id === settings.channel)
    if (row && row.enabled) for (const hit of channelHits(sequence.rack, row.id, grid)) add(beatTime(grid, hitBeat(hit.step, row)), 'channel', settings.channelAction)
  }
  if (settings.everyBeats > 0) {
    const from = beatAt(grid, span.start)
    const to = beatAt(grid, span.start + span.frames * frame)
    for (let k = Math.ceil(from / settings.everyBeats - 1e-9); k * settings.everyBeats < to; k++) add(beatTime(grid, k * settings.everyBeats), 'beat', settings.everyAction)
  }
  if (settings.markers !== 'off') for (const marker of sequence.markers) add(marker.time, 'marker', settings.markers)
  return out.sort((a, b) => a.frame - b.frame || a.kind.localeCompare(b.kind))
}

export interface BakePlan {
  frames: number
  /** The frames the encoder makes keyframes, from 0. */
  keyframes: number[]
  /** For each frame of the bake, which encoded frame it shows. */
  order: number[]
  melts: number[]
  blooms: Array<{ frame: number; length: number }>
  heals: number[]
}

/**
 * The plan for `frames` frames with these moments. On one frame a heal beats everything (the
 * picture clears); otherwise a melt at a cut, then a bloom. A bloom stops early at a keyframe.
 * Heal After puts a keyframe that many frames after each melt or bloom, unless a melt is there.
 */
export function planBake(frames: number, moments: readonly Moment[], settings: Pick<BakeSettings, 'bloomFrames' | 'healAfter'>): BakePlan {
  const at = new Map<number, { heal: boolean; melt: boolean; bloom: boolean; cut: boolean }>()
  const slot = (f: number) => {
    let s = at.get(f)
    if (!s) at.set(f, (s = { heal: false, melt: false, bloom: false, cut: false }))
    return s
  }
  for (const m of moments) {
    if (m.frame <= 0 || m.frame >= frames) continue
    const s = slot(m.frame)
    if (m.kind === 'cut') s.cut = true
    if (m.action === 'heal' || m.action === 'clean') s.heal = true
    else if (m.action === 'melt') s.melt = true
    else if (m.action === 'meltBloom') s.melt = s.bloom = true
    else s.bloom = true
  }
  const keyframes = new Set<number>([0])
  for (const [f, s] of at) if (s.cut || s.heal) keyframes.add(f)
  // Heal After: keyframes after each melt or bloom (not where a melt is).
  if (settings.healAfter > 0) {
    for (const [f, s] of [...at]) {
      if (s.heal || !(s.melt || s.bloom)) continue
      const h = f + settings.healAfter
      if (h < frames && !at.get(h)?.melt) {
        keyframes.add(h)
        slot(h).heal = true
      }
    }
  }
  const order: number[] = new Array(frames)
  const melts: number[] = []
  const heals: number[] = []
  const blooms: Array<{ frame: number; length: number }> = []
  let bloomSource = -1
  let bloomUntil = -1
  for (let i = 0; i < frames; i++) {
    const s = at.get(i)
    if (i === 0 || s?.heal) {
      order[i] = i
      bloomUntil = -1
      if (i > 0) heals.push(i)
      continue
    }
    if (s?.melt) {
      // The cut's keyframe is never shown: the frame before shows again in its place.
      order[i] = order[i - 1]!
      melts.push(i)
      if (s.bloom) {
        bloomSource = i + 1
        bloomUntil = i + settings.bloomFrames
      }
      continue
    }
    if (keyframes.has(i)) {
      // A clean keyframe (a cut left clean) ends a bloom.
      order[i] = i
      bloomUntil = -1
      continue
    }
    if (s?.bloom) {
      bloomSource = i
      bloomUntil = i + settings.bloomFrames - 1
    }
    order[i] = i <= bloomUntil && bloomSource <= i ? bloomSource : i
  }
  // The blooms as they came out (each run of one frame repeated).
  for (let i = 1; i < frames; i++) {
    if (order[i] === order[i - 1] && !melts.includes(i)) {
      const last = blooms[blooms.length - 1]
      if (last && last.frame + last.length === i) last.length++
      else blooms.push({ frame: i - 1, length: 2 })
    }
  }
  return { frames, keyframes: [...keyframes].sort((a, b) => a - b), order, melts, blooms, heals }
}

import { components, evaluate, type Keyframe } from '@engine/keyframes/keyframes'
import { animatedRefs, findEffect, keyframesOf, linksOf, modulatedValueAt, propertySpec, staticValue, type PropertyRef, type PropertySpec } from '@engine/keyframes/properties'
import type { ModulationContext } from '@engine/modulation/types'
import type { BeatGrid, Clip, Sequence } from '@engine/project/model'
import { beatsBetween } from '@engine/audio/beat-grid'
import { secondsToTicks, ticksToSeconds, type Ticks } from '@engine/time'
import type { KeyframeRef } from '@engine/timeline/keyframe-edits'
import { clipEnd } from '@engine/timeline/timeline'
import { rulerSteps } from '../timeline/geometry'
import { effectById } from '../../../effects/registry'

/**
 * The Keyframe Editor's layout and drawing: a dope sheet (one row per animated value of
 * the selected clips, keyframes as markers along sequence time) and a graph of the
 * focused value's curve with its bezier handles.
 */

export const LABEL_W = 190
export const RULER_H = 24
export const ROW_H = 22
const GRAPH_PAD = 14

export interface EditorRow {
  kind: 'clip' | 'value'
  clip: Clip
  ref: PropertyRef | null
  spec: PropertySpec | null
  label: string
}

export interface EditorView {
  /** Pixels per second. */
  pps: number
  /** Seconds at the left edge of the time area. */
  scroll: number
  /** Dope sheet rows scrolled off the top, in pixels. */
  scrollY: number
}

export interface Size {
  width: number
  height: number
}

/** Rows: each selected clip, then its animated values (clip properties, then effects top to bottom). */
export function editorRows(sequence: Sequence, clipIds: ReadonlySet<string>): EditorRow[] {
  const order = new Map(sequence.tracks.map((t, i) => [t.id, i]))
  const clips = sequence.clips
    .filter((c) => clipIds.has(c.id))
    .sort((a, b) => (a.kind === b.kind ? (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || a.start - b.start : a.kind === 'video' ? -1 : 1))
  const rows: EditorRow[] = []
  for (const clip of clips) {
    rows.push({ kind: 'clip', clip, ref: null, spec: null, label: clip.name })
    // Animated values, and modulated ones (the graph shows their curve as it really plays).
    const refs = animatedRefs(clip)
    const has = (r: PropertyRef) => refs.some((x) => x.effectId === r.effectId && x.param === r.param)
    for (const [param, links] of Object.entries(clip.modulation)) if (links.length && !has({ clipId: clip.id, effectId: null, param })) refs.push({ clipId: clip.id, effectId: null, param })
    for (const effect of clip.effects)
      for (const [param, links] of Object.entries(effect.modulation)) if (links.length && !has({ clipId: clip.id, effectId: effect.id, param })) refs.push({ clipId: clip.id, effectId: effect.id, param })
    for (const ref of refs) {
      const spec = propertySpec(clip, ref.effectId, ref.param)
      if (!spec) continue
      const effect = ref.effectId ? findEffect(clip, ref.effectId) : undefined
      const effectName = effect ? (effectById(effect.effectId)?.name ?? effect.effectId) : null
      rows.push({ kind: 'value', clip, ref, spec, label: effectName ? `${effectName} › ${spec.label}` : spec.label })
    }
  }
  return rows
}

export function timeToX(time: Ticks, view: EditorView): number {
  return LABEL_W + (ticksToSeconds(time) - view.scroll) * view.pps
}

export function xToTime(x: number, view: EditorView): Ticks {
  return secondsToTicks((x - LABEL_W) / view.pps + view.scroll)
}

export function rowTop(index: number, view: EditorView): number {
  return RULER_H + index * ROW_H - view.scrollY
}

// ---- Graph geometry ---------------------------------------------------------------------

export interface GraphRange {
  lo: number
  hi: number
}

export function graphTop(): number {
  return RULER_H + GRAPH_PAD
}

export function graphBottom(size: Size): number {
  return size.height - GRAPH_PAD
}

export function valueToY(value: number, range: GraphRange, size: Size): number {
  const top = graphTop()
  const bottom = graphBottom(size)
  return bottom - ((value - range.lo) / (range.hi - range.lo)) * (bottom - top)
}

export function yToValue(y: number, range: GraphRange, size: Size): number {
  const top = graphTop()
  const bottom = graphBottom(size)
  return range.lo + ((bottom - y) / (bottom - top)) * (range.hi - range.lo)
}

/** Where a keyframe's handles sit in (time, value) for component `c`, if its segments are bezier. */
export function handlePoints(track: readonly Keyframe[], index: number, c: number): { in: [Ticks, number] | null; out: [Ticks, number] | null } {
  const k = track[index]!
  const value = components(k.value)?.[c] ?? 0
  const prev = track[index - 1]
  const next = track[index + 1]
  return {
    in: prev && prev.interpolation === 'bezier' ? [k.time - k.in.t * (k.time - prev.time), value + (k.in.v[c] ?? 0)] : null,
    out: next && k.interpolation === 'bezier' ? [k.time + k.out.t * (next.time - k.time), value + (k.out.v[c] ?? 0)] : null
  }
}

/** The value range the graph shows: the curve over the visible time, its keyframes and handles, padded. */
export function graphRange(row: EditorRow, view: EditorView, size: Size): GraphRange {
  if (!row.ref || row.spec?.kind === 'stepped') return { lo: 0, hi: 1 }
  const { clip, ref } = row
  const track = keyframesOf(clip, ref.effectId, ref.param)
  const n = row.spec?.kind === 'point' ? 2 : 1
  let lo = Infinity
  let hi = -Infinity
  const take = (v: number) => {
    if (!Number.isFinite(v)) return
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  const fallback = staticValue(clip, ref.effectId, ref.param)
  const steps = Math.max(2, Math.floor((size.width - LABEL_W) / 4))
  for (let i = 0; i <= steps; i++) {
    const time = xToTime(LABEL_W + ((size.width - LABEL_W) * i) / steps, view) - clip.start
    const c = components(evaluate(track, time, fallback)) ?? [0]
    c.forEach(take)
  }
  track.forEach((k, index) => {
    for (let c = 0; c < n; c++) {
      take(components(k.value)?.[c] ?? 0)
      const h = handlePoints(track, index, c)
      if (h.in) take(h.in[1])
      if (h.out) take(h.out[1])
    }
  })
  if (!Number.isFinite(lo)) return { lo: 0, hi: 1 }
  const span = hi - lo
  const pad = span > 1e-9 ? span * 0.12 : Math.max(1, Math.abs(hi) * 0.1)
  return { lo: lo - pad, hi: hi + pad }
}

// ---- Hit testing -----------------------------------------------------------------------

export interface KeyframeHit {
  ref: KeyframeRef
  keyframe: Keyframe
  /** Graph only: which component (0 = X or the number, 1 = Y) and which part was hit. */
  component: number
  part: 'key' | 'in' | 'out'
}

const HIT = 6

export function hitDope(rows: EditorRow[], view: EditorView, x: number, y: number): KeyframeHit | null {
  if (x < LABEL_W) return null
  const index = Math.floor((y - RULER_H + view.scrollY) / ROW_H)
  const row = rows[index]
  if (!row?.ref) return null
  const track = keyframesOf(row.clip, row.ref.effectId, row.ref.param)
  let best: KeyframeHit | null = null
  let bestDistance = HIT
  for (const k of track) {
    const d = Math.abs(timeToX(row.clip.start + k.time, view) - x)
    if (d <= bestDistance) {
      best = { ref: { ...row.ref, keyframeId: k.id }, keyframe: k, component: 0, part: 'key' }
      bestDistance = d
    }
  }
  return best
}

export function hitGraph(row: EditorRow, view: EditorView, size: Size, range: GraphRange, x: number, y: number, isSelected: (ref: KeyframeRef) => boolean): KeyframeHit | null {
  if (!row.ref || x < LABEL_W) return null
  const track = keyframesOf(row.clip, row.ref.effectId, row.ref.param)
  const n = row.spec?.kind === 'point' ? 2 : 1
  const stepped = row.spec?.kind === 'stepped'
  const near = (t: Ticks, v: number) => Math.hypot(timeToX(row.clip.start + t, view) - x, (stepped ? stepY(size) : valueToY(v, range, size)) - y) <= HIT
  // Handles of selected keyframes first: they sit on top.
  for (let index = 0; index < track.length; index++) {
    const k = track[index]!
    const ref = { ...row.ref, keyframeId: k.id }
    if (!isSelected(ref) || stepped) continue
    for (let c = 0; c < n; c++) {
      const h = handlePoints(track, index, c)
      if (h.in && near(h.in[0], h.in[1])) return { ref, keyframe: k, component: c, part: 'in' }
      if (h.out && near(h.out[0], h.out[1])) return { ref, keyframe: k, component: c, part: 'out' }
    }
  }
  for (const k of track) for (let c = 0; c < n; c++) if (near(k.time, components(k.value)?.[c] ?? 0)) return { ref: { ...row.ref, keyframeId: k.id }, keyframe: k, component: c, part: 'key' }
  return null
}

function stepY(size: Size): number {
  return (graphTop() + graphBottom(size)) / 2
}

// ---- Drawing ----------------------------------------------------------------------------

const C = {
  bg: '#15121b',
  label: '#1b1722',
  labelFocused: '#2a2140',
  clipRow: '#211c29',
  grid: '#262030',
  gridText: '#756c85',
  text: '#ebe6f3',
  muted: '#968ea6',
  band: 'rgba(187,145,250,0.08)',
  bandVideo: 'rgba(187,145,250,0.10)',
  bandAudio: 'rgba(82,196,140,0.10)',
  key: '#d9dade',
  keySelected: '#bb91fa',
  playhead: '#ff5d5d',
  curve: ['#bb91fa', '#5fd08a'],
  handle: '#f2d16b',
  marquee: 'rgba(187,145,250,0.18)'
}

export interface DrawState {
  rows: EditorRow[]
  view: EditorView
  size: Size
  mode: 'dope' | 'graph'
  graphRow: EditorRow | null
  range: GraphRange
  playhead: Ticks
  fps: number
  timecode(time: Ticks): string
  isSelected(ref: KeyframeRef): boolean
  isFocused(ref: PropertyRef): boolean
  marquee: { x0: number; y0: number; x1: number; y1: number } | null
  markers: Ticks[]
  grid: BeatGrid | null
  /** Modulators' outputs: a modulated value's final curve is drawn faintly beside its keyframes. */
  modulation: ModulationContext | null
}

function shape(ctx: CanvasRenderingContext2D, k: Keyframe, x: number, y: number, r: number): void {
  ctx.beginPath()
  if (k.interpolation === 'hold') ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6)
  else if (k.interpolation === 'bezier') ctx.arc(x, y, r * 0.85, 0, Math.PI * 2)
  else {
    ctx.moveTo(x, y - r)
    ctx.lineTo(x + r, y)
    ctx.lineTo(x, y + r)
    ctx.lineTo(x - r, y)
    ctx.closePath()
  }
}

function drawRuler(ctx: CanvasRenderingContext2D, s: DrawState): void {
  const { width } = s.size
  ctx.fillStyle = '#1b1722'
  ctx.fillRect(LABEL_W, 0, width - LABEL_W, RULER_H)
  const { major, minor } = rulerSteps(s.view.pps, s.fps)
  const start = s.view.scroll
  const end = s.view.scroll + (width - LABEL_W) / s.view.pps
  ctx.strokeStyle = '#3a3d44'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let t = Math.floor(start / minor) * minor; t <= end; t += minor) {
    const x = Math.round(LABEL_W + (t - start) * s.view.pps) + 0.5
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6
    ctx.moveTo(x, RULER_H - (isMajor ? 9 : 4))
    ctx.lineTo(x, RULER_H)
  }
  ctx.stroke()
  ctx.fillStyle = C.gridText
  ctx.font = '10px "SF Mono", ui-monospace, Menlo, monospace'
  ctx.textBaseline = 'top'
  for (let t = Math.floor(start / major) * major; t <= end; t += major) {
    const x = Math.round(LABEL_W + (t - start) * s.view.pps)
    if (x >= LABEL_W) ctx.fillText(s.timecode(secondsToTicks(t)), x + 3, 4)
  }
  // Beats and bars along the bottom, once there's a beat grid.
  if (s.grid) {
    const beats = beatsBetween(s.grid, secondsToTicks(start), secondsToTicks(end))
    const spacing = beats.length > 1 ? timeToX(beats[1]!.time, s.view) - timeToX(beats[0]!.time, s.view) : Infinity
    for (const b of beats) {
      if (!b.bar && spacing < 5) continue
      const x = Math.round(timeToX(b.time, s.view)) + 0.5
      ctx.fillStyle = b.bar ? '#e8b04a' : 'rgba(232,176,74,0.55)'
      ctx.fillRect(x - 0.5, RULER_H - (b.bar ? 7 : 3), 1, b.bar ? 7 : 3)
    }
  }
  ctx.fillStyle = '#e8b04a'
  for (const m of s.markers) {
    const x = timeToX(m, s.view)
    if (x < LABEL_W || x > width) continue
    ctx.beginPath()
    ctx.moveTo(x - 4, 0)
    ctx.lineTo(x + 4, 0)
    ctx.lineTo(x, 6)
    ctx.closePath()
    ctx.fill()
  }
}

function drawPlayhead(ctx: CanvasRenderingContext2D, s: DrawState): void {
  const x = Math.round(timeToX(s.playhead, s.view)) + 0.5
  if (x < LABEL_W || x > s.size.width) return
  ctx.strokeStyle = C.playhead
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, s.size.height)
  ctx.stroke()
}

function drawLabels(ctx: CanvasRenderingContext2D, s: DrawState): void {
  ctx.fillStyle = C.label
  ctx.fillRect(0, 0, LABEL_W, s.size.height)
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.textBaseline = 'middle'
  s.rows.forEach((row, i) => {
    const top = rowTop(i, s.view)
    if (top + ROW_H < RULER_H || top > s.size.height) return
    const focused = row.ref && s.isFocused(row.ref)
    if (row.kind === 'clip') {
      ctx.fillStyle = C.clipRow
      ctx.fillRect(0, top, LABEL_W, ROW_H)
    } else if (focused) {
      ctx.fillStyle = C.labelFocused
      ctx.fillRect(0, top, LABEL_W, ROW_H)
    }
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, top, LABEL_W - 6, ROW_H)
    ctx.clip()
    ctx.fillStyle = row.kind === 'clip' ? C.text : focused ? C.text : C.muted
    ctx.font = row.kind === 'clip' ? '600 11px -apple-system, BlinkMacSystemFont, sans-serif' : '11px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.fillText(row.label, row.kind === 'clip' ? 8 : 20, top + ROW_H / 2)
    ctx.restore()
  })
  ctx.fillStyle = C.label
  ctx.fillRect(0, 0, LABEL_W, RULER_H)
  ctx.fillStyle = C.muted
  ctx.font = '10.5px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(s.mode === 'graph' ? 'Click a value to graph it' : 'Animated values', 8, RULER_H / 2)
  ctx.strokeStyle = C.grid
  ctx.beginPath()
  ctx.moveTo(LABEL_W - 0.5, 0)
  ctx.lineTo(LABEL_W - 0.5, s.size.height)
  ctx.stroke()
}

function drawDope(ctx: CanvasRenderingContext2D, s: DrawState): void {
  const { width } = s.size
  s.rows.forEach((row, i) => {
    const top = rowTop(i, s.view)
    if (top + ROW_H < RULER_H || top > s.size.height) return
    const x0 = Math.max(LABEL_W, timeToX(row.clip.start, s.view))
    const x1 = Math.min(width, timeToX(clipEnd(row.clip), s.view))
    if (row.kind === 'clip') {
      ctx.fillStyle = C.clipRow
      ctx.fillRect(LABEL_W, top, width - LABEL_W, ROW_H)
    }
    if (x1 > x0) {
      ctx.fillStyle = row.clip.kind === 'video' ? C.bandVideo : C.bandAudio
      ctx.fillRect(x0, top + 2, x1 - x0, ROW_H - 4)
    }
    ctx.strokeStyle = C.grid
    ctx.beginPath()
    ctx.moveTo(LABEL_W, top + ROW_H - 0.5)
    ctx.lineTo(width, top + ROW_H - 0.5)
    ctx.stroke()
    const cy = top + ROW_H / 2
    if (row.kind === 'clip') {
      // Every keyframe of the clip, small and grey (a summary; edit them on their rows).
      const times = new Set<Ticks>()
      for (const r of s.rows) if (r.clip.id === row.clip.id && r.ref) for (const k of keyframesOf(r.clip, r.ref.effectId, r.ref.param)) times.add(k.time)
      ctx.fillStyle = '#6b6e76'
      for (const t of times) {
        const x = timeToX(row.clip.start + t, s.view)
        if (x < LABEL_W - 4 || x > width + 4) continue
        ctx.beginPath()
        ctx.moveTo(x, cy - 3)
        ctx.lineTo(x + 3, cy)
        ctx.lineTo(x, cy + 3)
        ctx.lineTo(x - 3, cy)
        ctx.closePath()
        ctx.fill()
      }
      return
    }
    const ref = row.ref!
    const track = keyframesOf(row.clip, ref.effectId, ref.param)
    // Segment lines: solid between interpolating keyframes, faint for holds.
    for (let k = 0; k < track.length - 1; k++) {
      const a = timeToX(row.clip.start + track[k]!.time, s.view)
      const b = timeToX(row.clip.start + track[k + 1]!.time, s.view)
      ctx.strokeStyle = track[k]!.interpolation === 'hold' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.2)'
      ctx.beginPath()
      ctx.moveTo(Math.max(LABEL_W, a), cy + 0.5)
      ctx.lineTo(Math.min(width, b), cy + 0.5)
      ctx.stroke()
    }
    for (const k of track) {
      const x = timeToX(row.clip.start + k.time, s.view)
      if (x < LABEL_W - 6 || x > width + 6) continue
      const selected = s.isSelected({ ...ref, keyframeId: k.id })
      const outside = k.time < 0 || k.time >= row.clip.duration
      shape(ctx, k, x, cy, 5.5)
      ctx.globalAlpha = outside ? 0.45 : 1
      ctx.fillStyle = selected ? C.keySelected : C.key
      ctx.fill()
      ctx.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.7)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  })
}

function drawGraph(ctx: CanvasRenderingContext2D, s: DrawState): void {
  const { width, height } = s.size
  const row = s.graphRow
  if (!row?.ref) {
    ctx.fillStyle = C.muted
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText('Animate a value (⏱ in Effect Controls), then click its name here to see its curve.', LABEL_W + 16, height / 2)
    return
  }
  const { clip, ref } = row
  const track = keyframesOf(clip, ref.effectId, ref.param)
  const range = s.range
  const stepped = row.spec?.kind === 'stepped'
  // Clip span.
  const x0 = Math.max(LABEL_W, timeToX(clip.start, s.view))
  const x1 = Math.min(width, timeToX(clipEnd(clip), s.view))
  if (x1 > x0) {
    ctx.fillStyle = C.band
    ctx.fillRect(x0, RULER_H, x1 - x0, height - RULER_H)
  }
  // Value grid.
  if (!stepped) {
    const span = range.hi - range.lo
    const raw = span / 6
    const mag = 10 ** Math.floor(Math.log10(raw))
    const step = [1, 2, 5, 10].map((m) => m * mag).find((m) => m >= raw) ?? raw
    ctx.font = '10px "SF Mono", ui-monospace, Menlo, monospace'
    ctx.textBaseline = 'bottom'
    for (let v = Math.ceil(range.lo / step) * step; v <= range.hi; v += step) {
      const y = Math.round(valueToY(v, range, s.size)) + 0.5
      ctx.strokeStyle = C.grid
      ctx.beginPath()
      ctx.moveTo(LABEL_W, y)
      ctx.lineTo(width, y)
      ctx.stroke()
      ctx.fillStyle = C.gridText
      ctx.fillText(`${Number(v.toFixed(6))}${row.spec?.unit ?? ''}`, LABEL_W + 4, y - 1)
    }
  }
  const n = row.spec?.kind === 'point' ? 2 : 1
  const fallback = staticValue(clip, ref.effectId, ref.param)
  const midY = (graphTop() + graphBottom(s.size)) / 2
  if (stepped) {
    // Choices and toggles: a strip showing where each value starts.
    ctx.fillStyle = C.text
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.textBaseline = 'bottom'
    const spec = row.spec?.param
    track.forEach((k, i) => {
      const xa = timeToX(clip.start + k.time, s.view)
      const xb = i + 1 < track.length ? timeToX(clip.start + track[i + 1]!.time, s.view) : width
      ctx.strokeStyle = C.curve[0]!
      ctx.beginPath()
      ctx.moveTo(xa, midY + 0.5)
      ctx.lineTo(xb, midY + 0.5)
      ctx.stroke()
      const label = spec?.type === 'choice' ? (spec.options.find((o) => o.id === k.value)?.label ?? String(k.value)) : k.value ? 'On' : 'Off'
      ctx.fillText(label, xa + 8, midY - 8)
    })
  } else {
    // With modulation, the value as it really plays: faint, beside the keyframed curve.
    if (s.modulation && linksOf(clip, ref.effectId, ref.param).length > 0) {
      for (let c = 0; c < n; c++) {
        ctx.strokeStyle = c === 0 ? 'rgba(187,145,250,0.35)' : 'rgba(95,208,138,0.35)'
        ctx.lineWidth = 1
        ctx.beginPath()
        for (let x = LABEL_W; x <= width; x += 2) {
          const v = components(modulatedValueAt(clip, ref.effectId, ref.param, xToTime(x, s.view), s.modulation))?.[c] ?? 0
          const y = valueToY(v, range, s.size)
          if (x === LABEL_W) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
    }
    for (let c = 0; c < n; c++) {
      ctx.strokeStyle = C.curve[c]!
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (let x = LABEL_W; x <= width; x += 1) {
        const v = components(evaluate(track, xToTime(x, s.view) - clip.start, fallback))?.[c] ?? 0
        const y = valueToY(v, range, s.size)
        if (x === LABEL_W) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.lineWidth = 1
    }
  }
  if (n === 2) {
    ctx.font = '10.5px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.textBaseline = 'top'
    ctx.fillStyle = C.curve[0]!
    ctx.fillText('X', width - 34, RULER_H + 6)
    ctx.fillStyle = C.curve[1]!
    ctx.fillText('Y', width - 20, RULER_H + 6)
  }
  // Keyframes and the handles of selected ones.
  track.forEach((k, index) => {
    const selected = s.isSelected({ ...ref, keyframeId: k.id })
    const x = timeToX(clip.start + k.time, s.view)
    for (let c = 0; c < n; c++) {
      const y = stepped ? midY : valueToY(components(k.value)?.[c] ?? 0, range, s.size)
      if (selected && !stepped) {
        const h = handlePoints(track, index, c)
        for (const p of [h.in, h.out]) {
          if (!p) continue
          const hx = timeToX(clip.start + p[0], s.view)
          const hy = valueToY(p[1], range, s.size)
          ctx.strokeStyle = C.handle
          ctx.beginPath()
          ctx.moveTo(x, y)
          ctx.lineTo(hx, hy)
          ctx.stroke()
          ctx.fillStyle = C.handle
          ctx.beginPath()
          ctx.arc(hx, hy, 3.5, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      shape(ctx, k, x, y, 5)
      ctx.fillStyle = selected ? C.keySelected : C.key
      ctx.fill()
      ctx.strokeStyle = selected ? '#ffffff' : 'rgba(0,0,0,0.7)'
      ctx.stroke()
    }
  })
}

export function drawEditor(ctx: CanvasRenderingContext2D, s: DrawState): void {
  const { width, height } = s.size
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, width, height)
  ctx.save()
  ctx.beginPath()
  ctx.rect(LABEL_W, RULER_H, width - LABEL_W, height - RULER_H)
  ctx.clip()
  if (s.mode === 'dope') drawDope(ctx, s)
  else drawGraph(ctx, s)
  if (s.marquee) {
    const { x0, y0, x1, y1 } = s.marquee
    ctx.fillStyle = C.marquee
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
    ctx.strokeStyle = C.keySelected
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0))
  }
  ctx.restore()
  drawRuler(ctx, s)
  drawLabels(ctx, s)
  drawPlayhead(ctx, s)
}

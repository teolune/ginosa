import { beatAt, beatTime } from '@engine/audio/beat-grid'
import { automationValue } from '@engine/automation/curve'
import { tensionHandle, usesTension } from '@engine/automation/edit'
import type { AutomationPoint, BeatGrid, Clip } from '@engine/project/model'
import { secondsToTicks, type Ticks } from '@engine/time'

/**
 * The automation editor's graph (W2.2): the clip's stretch of the curve across the width, 0–100%
 * up the height, on the beat grid where the clip sits. The curve is drawn from the same function
 * playback reads (`automationValue`), one sample per screen column; the test reads the drawing
 * back from the pixels.
 */

export const PAD = { left: 42, right: 14, top: 22, bottom: 12 }
/** The curve's stroke: its own colour, so the test can find it among the pixels. */
export const CURVE_STROKE = '#d9c6ff'
export const POINT_RADIUS = 4.5
export const HANDLE_RADIUS = 3.5

export interface EditorGeometry {
  x0: number
  x1: number
  y0: number
  y1: number
  /** The clip's stretch of its curve (its source time). */
  from: Ticks
  to: Ticks
  xOf(time: Ticks): number
  timeOf(x: number): Ticks
  yOf(value: number): number
  valueOf(y: number): number
}

export function editorGeometry(clip: Pick<Clip, 'sourceIn' | 'duration'>, size: { width: number; height: number }): EditorGeometry {
  const x0 = PAD.left
  const x1 = Math.max(x0 + 10, size.width - PAD.right)
  const y0 = PAD.top
  const y1 = Math.max(y0 + 10, size.height - PAD.bottom)
  const from = clip.sourceIn
  const to = clip.sourceIn + Math.max(1, clip.duration)
  return {
    x0,
    x1,
    y0,
    y1,
    from,
    to,
    xOf: (time) => x0 + ((time - from) / (to - from)) * (x1 - x0),
    timeOf: (x) => from + ((x - x0) / (x1 - x0)) * (to - from),
    yOf: (value) => y1 - value * (y1 - y0),
    valueOf: (y) => (y1 - y) / (y1 - y0)
  }
}

export interface DrawInput {
  clip: Clip
  points: readonly AutomationPoint[]
  size: { width: number; height: number }
  grid: BeatGrid | null
  selected: ReadonlySet<number>
  /** The sequence playhead. */
  playhead: Ticks
}

export function drawAutomationEditor(ctx: CanvasRenderingContext2D, input: DrawInput): void {
  const { clip, points, size, grid } = input
  const g = editorGeometry(clip, size)
  ctx.clearRect(0, 0, size.width, size.height)
  ctx.fillStyle = '#100d14'
  ctx.fillRect(0, 0, size.width, size.height)
  ctx.fillStyle = '#15111b'
  ctx.fillRect(g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0)

  // The grid where the clip sits on the timeline: 16ths, beats, bars (with their numbers), or seconds.
  const onTimeline = (t: Ticks) => clip.start + (t - clip.sourceIn)
  const toCurve = (seq: Ticks) => seq - clip.start + clip.sourceIn
  ctx.font = '10px "SF Mono", ui-monospace, monospace'
  ctx.textBaseline = 'middle'
  if (grid) {
    const first = Math.ceil(beatAt(grid, onTimeline(g.from)) * 4)
    const last = Math.floor(beatAt(grid, onTimeline(g.to)) * 4)
    const sixteenthPx = g.xOf(toCurve(beatTime(grid, 0.25))) - g.xOf(toCurve(beatTime(grid, 0)))
    for (let k = first; k <= last; k++) {
      const beat = k / 4
      const isBeat = k % 4 === 0
      const isBar = isBeat && Math.round(beat) % grid.beatsPerBar === 0
      if (!isBeat && sixteenthPx < 6) continue
      const x = Math.round(g.xOf(toCurve(beatTime(grid, beat)))) + 0.5
      ctx.strokeStyle = isBar ? '#3d3450' : isBeat ? '#2a2336' : '#1e1928'
      ctx.beginPath()
      ctx.moveTo(x, g.y0)
      ctx.lineTo(x, g.y1)
      ctx.stroke()
      if (isBar) {
        ctx.fillStyle = '#8f86a3'
        ctx.textAlign = 'left'
        ctx.fillText(String(Math.round(beat / grid.beatsPerBar) + 1), x + 3, g.y0 - 10)
      }
    }
  } else {
    const second = secondsToTicks(1)
    for (let t = Math.ceil(onTimeline(g.from) / second) * second; t <= onTimeline(g.to); t += second) {
      const x = Math.round(g.xOf(toCurve(t))) + 0.5
      ctx.strokeStyle = '#2a2336'
      ctx.beginPath()
      ctx.moveTo(x, g.y0)
      ctx.lineTo(x, g.y1)
      ctx.stroke()
    }
  }
  // Value guides.
  ctx.textAlign = 'right'
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const y = Math.round(g.yOf(v)) + 0.5
    ctx.strokeStyle = v === 0 || v === 1 ? '#3d3450' : '#241e2e'
    ctx.beginPath()
    ctx.moveTo(g.x0, y)
    ctx.lineTo(g.x1, y)
    ctx.stroke()
    ctx.fillStyle = '#8f86a3'
    ctx.fillText(`${Math.round(v * 100)}%`, g.x0 - 6, y)
  }

  // The curve: one sample per screen column (its centre), the same function playback reads.
  const samples: Array<[number, number]> = []
  for (let x = Math.floor(g.x0); x <= Math.ceil(g.x1); x++) samples.push([x, g.yOf(automationValue(points, g.timeOf(x + 0.5)))])
  ctx.beginPath()
  ctx.moveTo(samples[0]![0], g.y1)
  for (const [x, y] of samples) ctx.lineTo(x + 0.5, y)
  ctx.lineTo(samples[samples.length - 1]![0] + 1, g.y1)
  ctx.closePath()
  ctx.fillStyle = 'rgba(106, 69, 214, 0.22)'
  ctx.fill()
  ctx.beginPath()
  samples.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x + 0.5, y) : ctx.lineTo(x + 0.5, y)))
  ctx.strokeStyle = CURVE_STROKE
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.lineWidth = 1

  // Tension handles, then points.
  points.forEach((p, i) => {
    if (!usesTension(p.shape)) return
    const h = tensionHandle(points, i)
    if (!h || h.time < g.from || h.time > g.to) return
    ctx.beginPath()
    ctx.arc(g.xOf(h.time), g.yOf(h.value), HANDLE_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = '#100d14'
    ctx.fill()
    ctx.strokeStyle = '#bb91fa'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.lineWidth = 1
  })
  points.forEach((p, i) => {
    if (p.time < g.from || p.time > g.to) return
    const selected = input.selected.has(i)
    ctx.beginPath()
    ctx.arc(g.xOf(p.time), g.yOf(p.value), POINT_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = selected ? '#ffffff' : '#bb91fa'
    ctx.fill()
    ctx.strokeStyle = '#0b0910'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.lineWidth = 1
  })

  // The playhead, when it's over the clip.
  const at = input.playhead - clip.start + clip.sourceIn
  if (at >= g.from && at <= g.to) {
    const x = Math.round(g.xOf(at)) + 0.5
    ctx.strokeStyle = '#ff5a8a'
    ctx.beginPath()
    ctx.moveTo(x, g.y0 - 14)
    ctx.lineTo(x, g.y1)
    ctx.stroke()
  }
}

/** What's under the mouse: a point (first), a stretch's tension handle, or nothing. */
export function hitEditor(points: readonly AutomationPoint[], g: EditorGeometry, x: number, y: number): { kind: 'point' | 'handle'; index: number } | null {
  let point = -1
  let pointD = Infinity
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    const d = Math.hypot(g.xOf(p.time) - x, g.yOf(p.value) - y)
    if (d <= POINT_RADIUS + 3 && d < pointD) {
      point = i
      pointD = d
    }
  }
  if (point >= 0) return { kind: 'point', index: point }
  let handle = -1
  let handleD = Infinity
  for (let i = 0; i < points.length; i++) {
    if (!usesTension(points[i]!.shape)) continue
    const h = tensionHandle(points, i)
    if (!h) continue
    const d = Math.hypot(g.xOf(h.time) - x, g.yOf(h.value) - y)
    if (d <= HANDLE_RADIUS + 3 && d < handleD) {
      handle = i
      handleD = d
    }
  }
  return handle >= 0 ? { kind: 'handle', index: handle } : null
}

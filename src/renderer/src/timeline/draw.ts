import type { MediaItem } from '@engine/project/media'
import type { Clip, Marker, Sequence } from '@engine/project/model'
import { secondsToTicks, ticksToSeconds, type Ticks } from '@engine/time'
import { transitionSpans, type TransitionSpan } from '@engine/timeline/render-plan'
import { clipEnd, sourceTimeAt, speedRamp } from '@engine/timeline/timeline'
import { barNumber, beatLength, beatsBetween } from '@engine/audio/beat-grid'
import type { MediaRuntime } from '../state/media-controller'
import { levelFor, peakRange } from '@shared/waveform'
import { RULER_HEIGHT, rulerSteps, timeToX, type Rows, type View } from './geometry'
import type { GapSelection } from './timeline-controller'

/** Everything one frame of the timeline canvas needs. */
export interface Scene {
  width: number
  height: number
  sequence: Sequence
  rows: Rows
  view: View
  scrollY: number
  fps: number
  playhead: Ticks
  selection: Set<string>
  /** The clip an effect is being dragged onto. */
  dropTarget: string | null
  transition: { clipId: string; end: 'in' | 'out' } | null
  gap: GapSelection | null
  snapLine: Ticks | null
  razorLine: { time: Ticks; trackId: string | null } | null
  marquee: { x0: number; y0: number; x1: number; y1: number } | null
  media: Map<string, MediaItem>
  runtime: (id: string) => MediaRuntime
  image: (url: string) => HTMLImageElement | null
  timecode: (time: Ticks) => string
  focused: boolean
  /** The render bar (M9): per frame 0 plain, 1 effects rendered live (yellow), 2 cached (green). */
  render: { status: Uint8Array; frame: Ticks } | null
  /** Screen pixels per CSS pixel (2 on a Retina screen): waveforms are drawn a screen pixel at a time. */
  pixelRatio?: number
}

const COLOURS = {
  bg: '#110f16',
  lane: '#17141d',
  laneAlt: '#15121b',
  divider: '#0e0c12',
  grid: 'rgba(255,255,255,0.035)',
  ruler: '#18141f',
  rulerText: '#968ea6',
  tick: '#3a3148',
  video: '#4f3aa8',
  videoSelected: '#8a66f2',
  audio: '#2f8a62',
  audioSelected: '#4fc48d',
  offline: '#a33a2e',
  clipText: '#f1f2f4',
  waveform: 'rgba(255,255,255,0.55)',
  playhead: '#bb91fa',
  marker: '#3fb27f',
  snap: '#f0c040',
  razor: '#ff6b5b',
  gap: 'rgba(187,145,250,0.18)',
  locked: 'rgba(255,255,255,0.03)',
  transition: 'rgba(214,220,235,0.82)',
  adjustment: '#8e4a86',
  adjustmentSelected: '#c879bb',
  fxBadge: '#d3b6ff',
  transitionSelected: '#ffffff',
  transitionText: '#1b1d22',
  keyframe: '#e8e8ea',
  marked: 'rgba(187,145,250,0.16)',
  markEdge: '#bb91fa',
  renderLive: '#d9b23c',
  renderCached: '#3fae5c',
  beat: 'rgba(232,176,74,0.55)',
  bar: '#e8b04a',
  barGrid: 'rgba(232,176,74,0.07)'
}

/** Premiere's speed badge: [200%], reversed as [-100%], or a frame hold. */
export function speedBadge(clip: Clip): string {
  if (clip.speed === 0) return ' [Hold]'
  if (clip.keyframes['speed']?.length && !clip.reverse) return ' [Speed ramp]'
  if (clip.speed === 1 && !clip.reverse) return ''
  const percent = Math.round(clip.speed * 1000) / 10
  return ` [${clip.reverse ? '-' : ''}${percent}%]`
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function drawRuler(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { width, view, fps } = scene
  ctx.fillStyle = COLOURS.ruler
  ctx.fillRect(0, 0, width, RULER_HEIGHT)
  const { major, minor } = rulerSteps(view.pps, fps)
  const startSeconds = view.scroll
  const endSeconds = view.scroll + width / view.pps
  ctx.strokeStyle = COLOURS.tick
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let s = Math.floor(startSeconds / minor) * minor; s <= endSeconds; s += minor) {
    const x = Math.round((s - view.scroll) * view.pps) + 0.5
    const isMajor = Math.abs(s / major - Math.round(s / major)) < 1e-6
    ctx.moveTo(x, RULER_HEIGHT - (isMajor ? 12 : 5))
    ctx.lineTo(x, RULER_HEIGHT)
  }
  ctx.stroke()
  ctx.fillStyle = COLOURS.rulerText
  ctx.font = '10px "SF Mono", ui-monospace, Menlo, monospace'
  ctx.textBaseline = 'top'
  for (let s = Math.floor(startSeconds / major) * major; s <= endSeconds; s += major) {
    const x = Math.round((s - view.scroll) * view.pps)
    ctx.fillText(scene.timecode(secondsToTicks(s)), x + 3, 4)
  }
  drawMarks(ctx, scene)
  drawRenderBar(ctx, scene)
  drawBeatGrid(ctx, scene)
  // Markers
  for (const marker of scene.sequence.markers) drawMarker(ctx, scene, marker)
  ctx.strokeStyle = '#26282d'
  ctx.beginPath()
  ctx.moveTo(0, RULER_HEIGHT - 0.5)
  ctx.lineTo(width, RULER_HEIGHT - 0.5)
  ctx.stroke()
}

/** The timeline's In and Out: the span shaded on the ruler, with a bracket at each mark. */
function drawMarks(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const marks = scene.sequence.marks
  if (marks.in === null && marks.out === null) return
  const { view, width } = scene
  const x0 = marks.in !== null ? timeToX(marks.in, view) : 0
  const x1 = marks.out !== null ? timeToX(marks.out, view) : width
  ctx.fillStyle = COLOURS.marked
  ctx.fillRect(x0, 0, x1 - x0, RULER_HEIGHT)
  ctx.strokeStyle = COLOURS.markEdge
  ctx.lineWidth = 1.5
  const bracket = (x: number, dir: 1 | -1) => {
    ctx.beginPath()
    ctx.moveTo(x + 5 * dir, 4)
    ctx.lineTo(x, 4)
    ctx.lineTo(x, RULER_HEIGHT - 4)
    ctx.lineTo(x + 5 * dir, RULER_HEIGHT - 4)
    ctx.stroke()
  }
  if (marks.in !== null) bracket(Math.round(x0) + 0.5, 1)
  if (marks.out !== null) bracket(Math.round(x1) - 0.5, -1)
}

/** Along the top of the ruler: yellow where frames have effects rendered live, green where they're cached. */
function drawRenderBar(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const render = scene.render
  if (!render) return
  const { view, width } = scene
  const first = Math.max(0, Math.floor((secondsToTicks(view.scroll) / render.frame)))
  const last = Math.min(render.status.length, Math.ceil(secondsToTicks(view.scroll + width / view.pps) / render.frame) + 1)
  let j = first
  while (j < last) {
    const status = render.status[j]!
    let k = j + 1
    while (k < last && render.status[k] === status) k++
    if (status !== 0) {
      const x0 = timeToX(j * render.frame, view)
      const x1 = timeToX(k * render.frame, view)
      ctx.fillStyle = status === 2 ? COLOURS.renderCached : COLOURS.renderLive
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), 3)
    }
    j = k
  }
}

/** Bars (numbered) and beats along the bottom of the ruler, once there's a beat grid. */
function drawBeatGrid(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const grid = scene.sequence.beatGrid
  if (!grid) return
  const { view, width } = scene
  const beatPx = (beatLength(grid) / secondsToTicks(1)) * view.pps
  const barPx = beatPx * grid.beatsPerBar
  if (barPx < 3) return
  // Number every bar, or every 2nd, 4th… when they're close together.
  let every = 1
  while (barPx * every < 26) every *= 2
  const beats = beatsBetween(grid, secondsToTicks(view.scroll), secondsToTicks(view.scroll + width / view.pps))
  ctx.font = '600 9px -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.textBaseline = 'top'
  for (const b of beats) {
    const x = Math.round((b.time / secondsToTicks(1) - view.scroll) * view.pps) + 0.5
    if (b.bar) {
      const n = barNumber(grid, b.time)
      ctx.fillStyle = COLOURS.bar
      ctx.fillRect(x - 0.5, RULER_HEIGHT - 9, 1, 9)
      if ((((n - 1) % every) + every) % every === 0) ctx.fillText(String(n), x + 3, RULER_HEIGHT - 11)
    } else if (beatPx >= 5) {
      ctx.fillStyle = COLOURS.beat
      ctx.fillRect(x - 0.5, RULER_HEIGHT - 4, 1, 4)
    }
  }
}

/** Faint bar lines through the tracks, so clips can be lined up with the music by eye. */
function drawBarLines(ctx: CanvasRenderingContext2D, scene: Scene, height: number): void {
  const grid = scene.sequence.beatGrid
  if (!grid) return
  const { view, width } = scene
  const barPx = (beatLength(grid) / secondsToTicks(1)) * view.pps * grid.beatsPerBar
  if (barPx < 8) return
  ctx.fillStyle = COLOURS.barGrid
  for (const b of beatsBetween(grid, secondsToTicks(view.scroll), secondsToTicks(view.scroll + width / view.pps))) {
    if (b.bar) ctx.fillRect(Math.round((b.time / secondsToTicks(1) - view.scroll) * view.pps), 0, 1, height)
  }
}

function drawMarker(ctx: CanvasRenderingContext2D, scene: Scene, marker: Marker): void {
  const x = Math.round(timeToX(marker.time, scene.view))
  if (x < -10 || x > scene.width + 10) return
  ctx.fillStyle = COLOURS.marker
  ctx.beginPath()
  ctx.moveTo(x - 5, RULER_HEIGHT - 14)
  ctx.lineTo(x + 5, RULER_HEIGHT - 14)
  ctx.lineTo(x + 5, RULER_HEIGHT - 6)
  ctx.lineTo(x, RULER_HEIGHT - 2)
  ctx.lineTo(x - 5, RULER_HEIGHT - 6)
  ctx.closePath()
  ctx.fill()
  if (marker.name && scene.view.pps > 4) {
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.fillStyle = COLOURS.marker
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(marker.name, x + 7, RULER_HEIGHT - 6)
  }
}

function drawWaveform(ctx: CanvasRenderingContext2D, scene: Scene, clip: Clip, x: number, y: number, w: number, h: number): void {
  const wave = scene.runtime(clip.mediaId).waveform
  if (!wave) return
  const { view } = scene
  const ratio = scene.pixelRatio ?? 1
  const mid = y + h / 2
  const half = h / 2 - 2
  // One column per screen pixel; the coarsest level of peaks that still has one for each.
  const left = Math.floor(Math.max(x, 0) * ratio)
  const right = Math.ceil(Math.min(x + w, scene.width) * ratio)
  const perColumn = 1 / (view.pps * ratio)
  const ramped = speedRamp(clip) !== null
  const level = levelFor(wave, perColumn * (ramped ? 1 : Math.max(1e-3, clip.speed)))
  // Timeline time at a column, mapped into the media (at the clip's speed, or along its ramp).
  const at = ramped ? (column: number) => ticksToSeconds(sourceTimeAt(clip, clip.start + secondsToTicks((column / ratio - x) / view.pps), 0)) : null
  const inSeconds = ticksToSeconds(clip.sourceIn)
  ctx.fillStyle = COLOURS.waveform
  ctx.beginPath()
  for (let c = left; c < right; c++) {
    const t0 = at ? at(c) : inSeconds + ((c / ratio - x) / view.pps) * clip.speed
    const t1 = at ? at(c + 1) : t0 + perColumn * clip.speed
    if (t0 >= wave.duration) break
    const range = peakRange(level, t0, t1)
    if (!range) continue
    const top = mid - range[1] * half
    ctx.rect(c / ratio, top, 1 / ratio, Math.max(1 / ratio, (range[1] - range[0]) * half))
  }
  ctx.fill()
}

/** Small diamonds along a clip's bottom edge where it has keyframes (any property). */
function drawKeyframeTicks(ctx: CanvasRenderingContext2D, scene: Scene, clip: Clip, x: number, y: number, w: number, h: number): void {
  if (h < 20 || w < 8) return
  const times = new Set<Ticks>()
  // Linked sound's copy of its picture's speed ramp isn't its own to edit, so it isn't marked.
  for (const [param, track] of Object.entries(clip.keyframes)) if (!(clip.kind === 'audio' && param === 'speed')) for (const k of track) times.add(k.time)
  for (const effect of clip.effects) for (const track of Object.values(effect.keyframes)) for (const k of track) times.add(k.time)
  if (times.size === 0) return
  const cy = y + h - 5
  ctx.fillStyle = COLOURS.keyframe
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'
  ctx.lineWidth = 1
  for (const t of times) {
    if (t < 0 || t >= clip.duration) continue
    const kx = x + ticksToSeconds(t) * scene.view.pps
    if (kx < -4 || kx > scene.width + 4) continue
    ctx.beginPath()
    ctx.moveTo(kx, cy - 3.5)
    ctx.lineTo(kx + 3.5, cy)
    ctx.lineTo(kx, cy + 3.5)
    ctx.lineTo(kx - 3.5, cy)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
}

function drawClip(ctx: CanvasRenderingContext2D, scene: Scene, clip: Clip, top: number, height: number): void {
  const { view } = scene
  const x = timeToX(clip.start, view)
  const w = (ticksToSeconds(clip.duration)) * view.pps
  if (x > scene.width || x + w < 0) return
  const y = top + 2
  const h = height - 4
  const item = scene.media.get(clip.mediaId)
  const runtime = scene.runtime(clip.mediaId)
  const selected = scene.selection.has(clip.id)
  const offline = !clip.adjustment && (!item || runtime.status === 'offline')
  const base = clip.adjustment
    ? selected
      ? COLOURS.adjustmentSelected
      : COLOURS.adjustment
    : offline
      ? COLOURS.offline
      : clip.kind === 'video'
        ? selected
          ? COLOURS.videoSelected
          : COLOURS.video
        : selected
          ? COLOURS.audioSelected
          : COLOURS.audio

  ctx.save()
  roundRect(ctx, x + 0.5, y + 0.5, Math.max(1, w - 1), h - 1, 3)
  ctx.fillStyle = base
  ctx.fill()
  ctx.clip()

  if (clip.kind === 'video' && item && runtime.thumbnailUrl && w > 30) {
    const img = scene.image(runtime.thumbnailUrl)
    if (img) {
      const thumbH = h - 14
      const thumbW = Math.min(w - 4, (img.naturalWidth / Math.max(1, img.naturalHeight)) * thumbH)
      ctx.globalAlpha = selected ? 1 : 0.9
      ctx.drawImage(img, x + 2, y + 13, thumbW, thumbH)
      ctx.globalAlpha = 1
    }
  }
  // Reversed and held sound is silent for now, so it gets no waveform.
  if (clip.kind === 'audio' && clip.speed > 0 && !clip.reverse) drawWaveform(ctx, scene, clip, x, y + 12, w, h - 12)

  if (w > 24) {
    ctx.fillStyle = COLOURS.clipText
    ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.textBaseline = 'top'
    const silent = clip.kind === 'audio' && (clip.reverse || clip.speed === 0) ? ' (silent)' : ''
    // The speed badge sits at the right of the label strip so it stays visible on short clips.
    const badge = offline ? '' : (speedBadge(clip) + silent).trim()
    let left = Math.max(x, 0) + 5
    const right = Math.min(x + w, scene.width) - 5
    // Premiere's fx badge: this clip has effects (dimmed when they're all switched off).
    if (clip.effects.length > 0 && right - left > 40) {
      const on = clip.effects.some((e) => e.enabled)
      ctx.fillStyle = on ? COLOURS.fxBadge : 'rgba(255,255,255,0.18)'
      roundRect(ctx, left - 1, y + 1.5, 15, 11, 2)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = '700 8.5px -apple-system, BlinkMacSystemFont, sans-serif'
      ctx.fillText('fx', left + 2, y + 3)
      ctx.font = '600 10.5px -apple-system, BlinkMacSystemFont, sans-serif'
      ctx.fillStyle = COLOURS.clipText
      left += 18
    }
    let badgeWidth = 0
    if (badge) {
      badgeWidth = ctx.measureText(badge).width + 6
      if (right - left > badgeWidth + 4) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)'
        ctx.fillRect(right - badgeWidth, y + 1, badgeWidth + 3, 13)
        ctx.fillStyle = '#ffd38a'
        ctx.textAlign = 'right'
        ctx.fillText(badge, right, y + 2)
        ctx.textAlign = 'left'
        ctx.fillStyle = COLOURS.clipText
      } else badgeWidth = 0
    }
    ctx.save()
    ctx.beginPath()
    ctx.rect(left - 5, y, Math.max(0, right - badgeWidth - left), 14)
    ctx.clip()
    ctx.fillText(offline ? `${clip.name} (offline)` : clip.name, left, y + 2)
    ctx.restore()
  }
  drawKeyframeTicks(ctx, scene, clip, x, y, w, h)
  ctx.restore()

  ctx.strokeStyle = scene.dropTarget === clip.id ? COLOURS.fxBadge : selected ? '#ffffff' : 'rgba(0,0,0,0.35)'
  ctx.lineWidth = scene.dropTarget === clip.id ? 2.5 : selected ? 1.5 : 1
  roundRect(ctx, x + 0.5, y + 0.5, Math.max(1, w - 1), h - 1, 3)
  ctx.stroke()
}

function drawTransition(ctx: CanvasRenderingContext2D, scene: Scene, span: TransitionSpan, top: number, height: number): void {
  const x0 = timeToX(span.from, scene.view)
  const x1 = Math.max(x0 + 6, timeToX(span.to, scene.view))
  if (x1 < 0 || x0 > scene.width) return
  const y = top + 3
  const h = Math.max(8, height / 2 - 4)
  const selected = scene.transition?.clipId === span.clip.id && scene.transition.end === span.end
  ctx.save()
  roundRect(ctx, x0 + 0.5, y + 0.5, x1 - x0 - 1, h, 2)
  ctx.fillStyle = selected ? COLOURS.transitionSelected : COLOURS.transition
  ctx.fill()
  ctx.clip()
  // A dissolve draws as a cross; a fade as one diagonal (up for in, down for out).
  ctx.strokeStyle = 'rgba(27,29,34,0.45)'
  ctx.lineWidth = 1
  ctx.beginPath()
  if (span.between || span.end === 'in') {
    ctx.moveTo(x0, y + h)
    ctx.lineTo(x1, y)
  }
  if (span.between || span.end === 'out') {
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y + h)
  }
  ctx.stroke()
  if (x1 - x0 > 90 && h >= 12) {
    ctx.fillStyle = COLOURS.transitionText
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillText('Cross Dissolve', (Math.max(x0, 0) + Math.min(x1, scene.width)) / 2, y + h / 2)
  }
  ctx.restore()
  ctx.strokeStyle = selected ? '#bb91fa' : 'rgba(0,0,0,0.5)'
  ctx.lineWidth = selected ? 1.5 : 1
  roundRect(ctx, x0 + 0.5, y + 0.5, x1 - x0 - 1, h, 2)
  ctx.stroke()
}

/** Draws the whole timeline (ruler, lanes, clips, overlays) into a canvas sized `scene.width × scene.height`. */
/** How often the timeline is drawn and how long it takes (the performance test reads it). */
export const drawStats = { count: 0, totalMs: 0 }

export function drawTimeline(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const started = performance.now()
  drawScene(ctx, scene)
  drawStats.count++
  drawStats.totalMs += performance.now() - started
}

function drawScene(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { width, height, rows, view, scrollY } = scene
  ctx.fillStyle = COLOURS.bg
  ctx.fillRect(0, 0, width, height)

  // Lanes and clips, scrolled vertically, below the ruler.
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, RULER_HEIGHT, width, height - RULER_HEIGHT)
  ctx.clip()
  ctx.translate(0, RULER_HEIGHT - scrollY)

  const { major } = rulerSteps(view.pps, scene.fps)
  rows.rows.forEach((row, i) => {
    ctx.fillStyle = i % 2 ? COLOURS.laneAlt : COLOURS.lane
    ctx.fillRect(0, row.top, width, row.height)
    if (row.track.locked) {
      ctx.fillStyle = COLOURS.locked
      for (let x = -row.height; x < width; x += 10) {
        ctx.beginPath()
        ctx.moveTo(x, row.top + row.height)
        ctx.lineTo(x + row.height, row.top)
        ctx.lineTo(x + row.height + 4, row.top)
        ctx.lineTo(x + 4, row.top + row.height)
        ctx.fill()
      }
    }
    ctx.fillStyle = '#202227'
    ctx.fillRect(0, row.top + row.height - 1, width, 1)
  })
  ctx.fillStyle = COLOURS.divider
  ctx.fillRect(0, rows.dividerTop, width, 6)
  // Faint grid on major ruler steps
  ctx.fillStyle = COLOURS.grid
  for (let s = Math.floor(view.scroll / major) * major; s <= view.scroll + width / view.pps; s += major) {
    ctx.fillRect(Math.round((s - view.scroll) * view.pps), 0, 1, rows.height)
  }
  drawBarLines(ctx, scene, rows.height)

  if (scene.gap) {
    const row = rows.rows.find((r) => r.track.id === scene.gap!.trackId)
    if (row) {
      const x0 = timeToX(scene.gap.start, view)
      const x1 = timeToX(scene.gap.end, view)
      ctx.fillStyle = COLOURS.gap
      ctx.fillRect(x0, row.top + 2, x1 - x0, row.height - 4)
    }
  }

  for (const row of rows.rows) {
    const dim = (row.track.kind === 'video' && !row.track.visible) || (row.track.kind === 'audio' && row.track.muted)
    ctx.globalAlpha = dim ? 0.45 : 1
    for (const clip of scene.sequence.clips) if (clip.trackId === row.track.id) drawClip(ctx, scene, clip, row.top, row.height)
    if (row.track.kind === 'video') for (const span of transitionSpans(scene.sequence, row.track.id)) drawTransition(ctx, scene, span, row.top, row.height)
    ctx.globalAlpha = 1
  }

  if (scene.razorLine) {
    const x = Math.round(timeToX(scene.razorLine.time, view)) + 0.5
    ctx.strokeStyle = COLOURS.razor
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    const row = scene.razorLine.trackId ? rows.rows.find((r) => r.track.id === scene.razorLine!.trackId) : null
    ctx.moveTo(x, row ? row.top : 0)
    ctx.lineTo(x, row ? row.top + row.height : rows.height)
    ctx.stroke()
    ctx.setLineDash([])
  }
  ctx.restore()

  if (scene.marquee) {
    const { x0, y0, x1, y1 } = scene.marquee
    ctx.fillStyle = 'rgba(187,145,250,0.12)'
    ctx.strokeStyle = 'rgba(187,145,250,0.8)'
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0))
  }

  drawRuler(ctx, scene)

  if (scene.snapLine !== null) {
    const x = Math.round(timeToX(scene.snapLine, view)) + 0.5
    ctx.strokeStyle = COLOURS.snap
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }

  // Playhead on top of everything.
  const px = Math.round(timeToX(scene.playhead, view)) + 0.5
  if (px >= -8 && px <= width + 8) {
    ctx.strokeStyle = COLOURS.playhead
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(px, RULER_HEIGHT - 8)
    ctx.lineTo(px, height)
    ctx.stroke()
    ctx.fillStyle = COLOURS.playhead
    ctx.beginPath()
    ctx.moveTo(px - 6, RULER_HEIGHT - 14)
    ctx.lineTo(px + 6, RULER_HEIGHT - 14)
    ctx.lineTo(px + 6, RULER_HEIGHT - 8)
    ctx.lineTo(px, RULER_HEIGHT - 2)
    ctx.lineTo(px - 6, RULER_HEIGHT - 8)
    ctx.closePath()
    ctx.fill()
  }
}


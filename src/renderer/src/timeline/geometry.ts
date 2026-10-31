import type { Sequence, Track } from '@engine/project/model'
import { secondsToTicks, ticksToSeconds, type Ticks } from '@engine/time'

export const RULER_HEIGHT = 30
export const TRACK_HEIGHT = 44
export const DIVIDER_HEIGHT = 6
/** Pixels either side of a clip edge that grab the edge instead of the clip. */
export const EDGE_GRAB = 7
/** Snap distance in pixels. */
export const SNAP_PIXELS = 8

export interface Row {
  track: Track
  top: number
  height: number
}

export interface Rows {
  rows: Row[]
  /** Top of the gap between video and audio tracks. */
  dividerTop: number
  height: number
}

/** V3, V2, V1 above the divider (V1 nearest the middle, as in Premiere), then A1, A2, A3. */
export function layoutRows(sequence: Sequence): Rows {
  const video = sequence.tracks.filter((t) => t.kind === 'video').reverse()
  const audio = sequence.tracks.filter((t) => t.kind === 'audio')
  const rows: Row[] = []
  let y = 0
  for (const track of video) {
    rows.push({ track, top: y, height: TRACK_HEIGHT })
    y += TRACK_HEIGHT
  }
  const dividerTop = y
  y += DIVIDER_HEIGHT
  for (const track of audio) {
    rows.push({ track, top: y, height: TRACK_HEIGHT })
    y += TRACK_HEIGHT
  }
  return { rows, dividerTop, height: y }
}

export function rowAt(rows: Rows, y: number): Row | null {
  return rows.rows.find((r) => y >= r.top && y < r.top + r.height) ?? null
}

export function rowFor(rows: Rows, trackId: string): Row | undefined {
  return rows.rows.find((r) => r.track.id === trackId)
}

/** Horizontal view: pixels per second and the time (seconds) at the left edge. */
export interface View {
  pps: number
  scroll: number
}

export const MIN_PPS = 0.02
export const MAX_PPS = 2400

export function timeToX(time: Ticks, view: View): number {
  return (ticksToSeconds(time) - view.scroll) * view.pps
}

export function xToTime(x: number, view: View): Ticks {
  return secondsToTicks(x / view.pps + view.scroll)
}

export function pixelsToTicks(pixels: number, view: View): Ticks {
  return secondsToTicks(pixels / view.pps)
}

/** Ruler spacing in seconds: a labelled step at least ~90 px apart, and a minor step. */
export function rulerSteps(pps: number, fps: number): { major: number; minor: number } {
  const frame = 1 / fps
  const candidates = [frame, 2 * frame, 5 * frame, 10 * frame, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  const major = candidates.find((c) => c * pps >= 90) ?? 3600
  const minor = major <= frame ? frame : major >= 60 ? major / 6 : major / 5
  return { major, minor: minor * pps >= 6 ? minor : major }
}

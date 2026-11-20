import type { MediaItem } from '../project/media'
import type { MulticamGroup, Sequence } from '../project/model'
import { sourceSize } from './motion'

/**
 * The multi-camera view (W5.3, decision 134): every angle of a group at once, in a grid on the
 * frame (2 × 2 for up to 4 angles, 3 × 3 up to 9, 4 × 3 up to 12), as a sequence of its own the
 * Program monitor plays. Each angle's takes are shown whole in their cell (fitted, upright, at
 * full opacity, with their effects); everything else is hidden. The sound is the sequence's.
 */

export interface GridCell {
  angleId: string
  key: string
  /** The cell, as fractions of the frame. */
  x: number
  y: number
  w: number
  h: number
}

export function gridShape(count: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  return { cols, rows: Math.max(1, Math.ceil(count / cols)) }
}

export function gridCells(group: MulticamGroup): GridCell[] {
  const { cols, rows } = gridShape(group.angles.length)
  return group.angles.map((a, i) => ({ angleId: a.id, key: a.key, x: (i % cols) / cols, y: Math.floor(i / cols) / rows, w: 1 / cols, h: 1 / rows }))
}

const MOTION_KEYS = ['position', 'scale', 'scaleWidth', 'rotation', 'anchor', 'opacity']

export function multicamGrid(sequence: Sequence, media: readonly MediaItem[], group: MulticamGroup): Sequence {
  const { width, height } = sequence.settings
  const cells = gridCells(group)
  const cellOf = new Map(group.angles.map((a, i) => [a.trackId, cells[i]!]))
  const tracks = sequence.tracks.map((t) => (t.kind !== 'video' ? t : { ...t, visible: cellOf.has(t.id), solo: false }))
  const clips = sequence.clips.map((clip) => {
    const cell = clip.kind === 'video' && !clip.adjustment ? cellOf.get(clip.trackId) : undefined
    if (!cell) return clip
    const size = sourceSize(media.find((m) => m.id === clip.mediaId), sequence.settings)
    const fit = Math.min((cell.w * width) / size.width, (cell.h * height) / size.height) * 100
    const keyframes = Object.fromEntries(Object.entries(clip.keyframes).filter(([k]) => !MOTION_KEYS.includes(k)))
    const modulation = Object.fromEntries(Object.entries(clip.modulation).filter(([k]) => !MOTION_KEYS.includes(k)))
    return {
      ...clip,
      motion: { positionX: (cell.x + cell.w / 2) * width, positionY: (cell.y + cell.h / 2) * height, scale: fit, scaleWidth: 100, rotation: 0, anchorX: size.width / 2, anchorY: size.height / 2 },
      opacity: 100,
      blendMode: 'normal' as const,
      transitionIn: null,
      transitionOut: null,
      mask: null,
      keyframes,
      modulation
    }
  })
  return { ...sequence, tracks, clips }
}

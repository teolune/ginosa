import type { MediaItem } from '../project/media'
import type { Motion, SequenceSettings } from '../project/model'

/**
 * Motion maths. A layer maps source pixels to sequence pixels:
 *   p = position + R(rotation) · S(scaleX, scaleY) · (s − anchor)
 * The compositor needs the inverse (for each output pixel, which source pixel?).
 */

/** Source size as displayed (after rotation metadata). Audio and unknowns get the sequence size. */
export function sourceSize(item: MediaItem | undefined, settings: SequenceSettings): { width: number; height: number } {
  const video = item?.info.video
  return video && video.width > 0 && video.height > 0 ? { width: video.width, height: video.height } : { width: settings.width, height: settings.height }
}

/** Premiere's "Set to Frame Size": the largest scale that shows the whole source inside the frame. */
export function frameFitScale(source: { width: number; height: number }, settings: SequenceSettings): number {
  return Math.min(settings.width / source.width, settings.height / source.height) * 100
}

/** Motion for a new clip: centred, fitted to the frame. */
export function defaultMotion(item: MediaItem | undefined, settings: SequenceSettings): Motion {
  const source = sourceSize(item, settings)
  return {
    positionX: settings.width / 2,
    positionY: settings.height / 2,
    scale: roundScale(frameFitScale(source, settings)),
    scaleWidth: 100,
    rotation: 0,
    anchorX: source.width / 2,
    anchorY: source.height / 2
  }
}

/** Scale values are kept to 3 decimals, like Premiere's field. */
export function roundScale(scale: number): number {
  return Math.round(scale * 1000) / 1000
}

/** A 2D affine transform: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface Affine {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/** Source pixel → sequence pixel. */
export function motionMatrix(motion: Motion): Affine {
  const sx = (motion.scale / 100) * (motion.scaleWidth / 100)
  const sy = motion.scale / 100
  const r = (motion.rotation * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const a = cos * sx
  const b = sin * sx
  const c = -sin * sy
  const d = cos * sy
  return { a, b, c, d, e: motion.positionX - (a * motion.anchorX + c * motion.anchorY), f: motion.positionY - (b * motion.anchorX + d * motion.anchorY) }
}

export function invertAffine(m: Affine): Affine | null {
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) < 1e-12) return null
  const a = m.d / det
  const b = -m.b / det
  const c = -m.c / det
  const d = m.a / det
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) }
}

export function applyAffine(m: Affine, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
}

/** Sequence pixel → source pixel, or null when the layer is scaled to nothing. */
export function inverseMotion(motion: Motion): Affine | null {
  return invertAffine(motionMatrix(motion))
}

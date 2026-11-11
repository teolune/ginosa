import { CLEF_PATH, CLEF_SIZE } from './logo-path'

/**
 * The ginosa mark (decision 113): your 8-bit treble clef, pixel for pixel (20 × 57), in your
 * Icon Composer lavender. One unit is one of its pixels; the view box adds one above and two
 * below, so at 30 px (the title bar) each pixel is exactly a screen pixel on a Retina display
 * and lands on whole pixels, and at 120 px (the title screen) four. Edges stay sharp whenever a
 * pixel covers at least one screen pixel. The outline is generated from
 * assets/logo/ginosa-clef.txt by scripts/make-logo.py.
 */
const PAD_TOP = 1
const PAD_BOTTOM = 2
const VIEW_HEIGHT = CLEF_SIZE.height + PAD_TOP + PAD_BOTTOM

export function Logo({ height = 30, className }: { height?: number; className?: string }) {
  const crisp = (height / VIEW_HEIGHT) * (window.devicePixelRatio || 1) >= 1
  return (
    <svg
      className={`logo ${className ?? ''}`}
      width={(height * CLEF_SIZE.width) / VIEW_HEIGHT}
      height={height}
      viewBox={`0 ${-PAD_TOP} ${CLEF_SIZE.width} ${VIEW_HEIGHT}`}
      shapeRendering={crisp ? 'crispEdges' : 'auto'}
      aria-hidden="true"
    >
      <path className="logo-clef" fillRule="evenodd" d={CLEF_PATH} />
    </svg>
  )
}

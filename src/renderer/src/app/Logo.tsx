import { CLEF_PATH, CLEF_SIZE, TITLE_PATH, TITLE_SIZE } from './logo-path'

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

/**
 * The title screen's logo (decision 121): your GINOSA logo, the clef and "inosa" pixel for
 * pixel, in the mark's lavender. One unit of its outline is one screen pixel on a Retina display
 * (so it's drawn at half its units in points): the clef's pixels are 7 screen pixels and the
 * letters' 5, and every edge lands on a whole pixel. Built by scripts/make-logo.py.
 */
export function TitleMark({ className }: { className?: string }) {
  const crisp = (window.devicePixelRatio || 1) >= 2
  return (
    <svg
      className={`logo title-mark ${className ?? ''}`}
      width={TITLE_SIZE.width / 2}
      height={TITLE_SIZE.height / 2}
      viewBox={`0 0 ${TITLE_SIZE.width} ${TITLE_SIZE.height}`}
      shapeRendering={crisp ? 'crispEdges' : 'auto'}
      role="img"
      aria-label="ginosa"
    >
      <path className="logo-clef" fillRule="evenodd" d={TITLE_PATH} />
    </svg>
  )
}

/**
 * The title bar's logo (decision 128): your clef alone, turned −90° (on its side, its top to the
 * left), as the Home button. Three screen pixels a pixel on a Retina display (1.5 points): 30
 * points tall in the 44-point bar and 85.5 wide, every edge on a whole screen pixel.
 */
export const CLEF_BAR_SCALE = 1.5

export function ClefBarMark({ className }: { className?: string }) {
  const crisp = Number.isInteger(CLEF_BAR_SCALE * (window.devicePixelRatio || 1))
  const { width, height } = CLEF_SIZE
  return (
    <svg
      className={`logo clef-bar-mark ${className ?? ''}`}
      width={height * CLEF_BAR_SCALE}
      height={width * CLEF_BAR_SCALE}
      viewBox={`0 0 ${height} ${width}`}
      shapeRendering={crisp ? 'crispEdges' : 'auto'}
      aria-hidden="true"
    >
      {/* rotate(−90) takes (x, y) to (y, −x); moving down by the clef's width brings it back into view. */}
      <path className="logo-clef" fillRule="evenodd" d={CLEF_PATH} transform={`translate(0 ${width}) rotate(-90)`} />
    </svg>
  )
}

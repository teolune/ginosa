import { useId } from 'react'

/**
 * The ginosa mark (decision 104): your GinosaG sketch, redrawn with natural curves: nodes at
 * the extremes with level or plumb handles, curvature flowing on across every node and changing
 * evenly along each curve; a straight stem at 8.1° with both cuts parallel to it, leaving two
 * equal 14.9-unit channels. The source is assets/logo/ginosa-logo.svg.
 * Light purple on the dark interface.
 */
const SWIRL =
  'M255.74 439.54C249.09 440.48 239.13 441.56 227.52 441.56C111.95 441.56 19.34 333.14 19.34 232.27C19.34 137.15 109.45 0.44 200.89 0.44C241.99 0.44 294.34 27.63 311.48 68.15C300.8 62.15 287.55 57.98 272.21 57.98C187.71 57.98 78.64 183.97 78.64 271.93C78.64 351.58 169.18 409.69 250.48 402.69Z'
const RING =
  'M270.98 440.9L241.46 233.89C217.48 243.19 198.77 263.99 198.77 286.63C198.77 313.58 225.31 327.62 225.31 347.86C225.31 359.57 216.25 368.37 204.86 368.37C174.32 368.37 131.99 306.01 131.99 255.89C131.99 194.75 193.88 125.59 277.26 125.59C363.55 125.59 422.66 198.5 422.66 278.95C422.66 342.98 385.19 400.63 326.95 423.27L319.29 369.51C332 347.41 340.88 320.73 340.88 297.6C340.88 258.63 315.39 234 284.23 229.27L312.78 429.39Z'

export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg className={`logo ${className ?? ''}`} width={size} height={size} viewBox="0 0 442 442" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-fill`} x1="0.15" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#ecdfff" />
          <stop offset="1" stopColor="#9a6cf6" />
        </linearGradient>
      </defs>
      <path d={SWIRL} fill={`url(#${id}-fill)`} />
      <path d={RING} fill={`url(#${id}-fill)`} />
    </svg>
  )
}

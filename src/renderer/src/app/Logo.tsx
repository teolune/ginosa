import { useId } from 'react'

/**
 * The ginosa mark (decision 104): your GinosaG sketch, redrawn with honest curves: nodes at
 * the extremes with level or plumb handles, a straight stem at 8.1° and both cuts parallel to
 * it, leaving two equal 14.9-unit channels. The source is assets/logo/ginosa-logo.svg.
 * Light purple on the dark interface.
 */
const SWIRL =
  'M254.85 439.14C246.61 440.51 239.85 440.55 231.57 440.55C116.24 440.55 19.24 344.31 19.24 229.93C19.24 142.62 103.7 0.45 200.67 0.45C242.36 0.45 294.77 27.88 310.59 67.75C296.31 60.89 289.38 57.31 272.96 57.31C183.62 57.31 77.7 186.37 77.7 272.79C77.7 334.09 136.53 383.44 192.03 397.31C214.05 402.82 227.88 401.26 249.59 402.29Z'
const RING =
  'M270.09 440.49L240.57 233.49C215.79 242.26 198.82 266.58 198.82 292.85C198.82 325.11 227.17 342.83 227.17 354.26C227.17 363.75 218.54 364.16 211.07 364.16C164.95 364.16 131.54 300.81 131.54 258.45C131.54 182.06 201.2 126.59 274.91 126.59C361.72 126.59 421.76 193.4 421.76 278.28C421.76 340.06 385.24 401.19 326.07 422.86L318.4 369.11C331.04 346.87 339.89 321.05 339.89 295.19C339.89 261.07 317.03 234.23 283.35 228.86L311.89 428.99Z'

export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg className={`logo ${className ?? ''}`} width={size} height={size} viewBox="0 0 441 441" aria-hidden="true">
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

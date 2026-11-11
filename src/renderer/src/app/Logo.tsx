import { useId } from 'react'

/**
 * The ginosa mark from the wireframe: a round "G", a disc with a wedge cut out at the upper
 * right and a play triangle inside whose tip meets the cut. Light on the dark interface.
 */
export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg className={`logo ${className ?? ''}`} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-fill`} x1="0.1" y1="0.05" x2="0.85" y2="1">
          <stop offset="0" stopColor="#e2d2ff" />
          <stop offset="1" stopColor="#8d61f2" />
        </linearGradient>
        <mask id={`${id}-cut`}>
          <rect width="100" height="100" fill="#fff" />
          <path d="M 78.5 -5 L 55 37.4 L 75.6 53 L 105 47.7 L 105 -5 Z" fill="#000" />
        </mask>
      </defs>
      <circle cx="50" cy="50" r="46" fill={`url(#${id}-fill)`} mask={`url(#${id}-cut)`} />
      <path d="M 36.5 34 L 75 54 L 36.5 75 Z" fill="none" stroke="#0e0c12" strokeWidth="4.5" />
    </svg>
  )
}

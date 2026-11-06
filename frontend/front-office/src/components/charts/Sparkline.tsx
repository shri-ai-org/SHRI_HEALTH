import { useId } from 'react'
import { cn } from '../../utils/cn'

/**
 * A tiny trend line for a figure card: the line in the hue, a soft fill
 * beneath it fading to nothing. Decorative — the figure beside it states
 * the number in words — so it is hidden from assistive technology. Scales
 * to whatever box it is given.
 */
export function Sparkline({ values, color, className }: { values: number[]; color: string; className?: string }) {
  const id = useId().replace(/:/g, '')
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const W = 100
  const H = 32
  const pad = 3
  const points = values.map((v, i) => [(i / (values.length - 1)) * W, H - pad - ((v - min) / span) * (H - pad * 2)] as const)
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  const area = `${line} L${W},${H} L0,${H} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" className={cn('overflow-visible', className)}>
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.3 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${id})`} />
      {/* Colours go in style: presentation attributes don't resolve var(). */}
      <path d={line} fill="none" style={{ stroke: color }} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// ported from src/components/charts.tsx:282-286 (`formatTick`) and 366-410 (`Sparkline`):
// change over time for one measure, small enough to sit on a row. The last value,
// its unit and its direction are written beside the line, so the line itself
// carries nothing a reader needs.

import { ArrowDown, ArrowUp } from 'lucide-react'

import { Icon } from './primitives'

export interface TrendPoint {
  at: Date
  value: number
}

function formatTick(v: number): string {
  if (Math.abs(v) >= 100) return String(Math.round(v))
  if (Math.abs(v) >= 10) return v.toFixed(0)
  return v.toFixed(1)
}

/** `bare`: the line alone, where the value is already written beside it (a vitals cell). */
export function Sparkline({ points, unit, label, bare = false, width = 96 }: { points: TrendPoint[]; unit: string; label: string; bare?: boolean; width?: number }) {
  if (points.length < 2) return null

  const w = width
  const h = 26
  const values = points.map((p) => p.value)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const x = (i: number) => (i / (points.length - 1)) * (w - 2) + 1
  const y = (v: number) => h - 3 - ((v - lo) / span) * (h - 6)
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  const rising = last.value > points[0].value

  return (
    <span className="flex shrink-0 items-center gap-[8px]">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}: ${values.map(formatTick).join(', ')} ${unit}`} className="overflow-visible">
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(points.length - 1)} cy={y(last.value)} r="2.8" fill="var(--accent)" />
      </svg>
      {!bare && (
        <span className="flex items-center gap-[4px] whitespace-nowrap text-[13px] font-semibold tabular-nums text-sh-text">
          {formatTick(last.value)}
          <span className="font-normal text-sh-text-3">{unit}</span>
          <Icon icon={rising ? ArrowUp : ArrowDown} size={12} className="text-sh-text-3" />
        </span>
      )}
    </span>
  )
}

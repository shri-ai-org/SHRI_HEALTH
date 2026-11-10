/**
 * A stroke interval's ring — ported from `src/archetypes/index.tsx`
 * (ClockRing :642-720): elapsed against target, and the state written under
 * it, because ring fill alone is unreadable at a glance and colour is never
 * the only signal.
 */

import { cn } from '../lib/cn'

export type ClockState = 'DONE' | 'RUNNING' | 'PENDING' | 'BREACH'

const STROKE: Record<ClockState, string> = { BREACH: 'var(--crit)', DONE: 'var(--norm)', RUNNING: 'var(--warn)', PENDING: 'var(--line-strong)' }
const WORD: Record<ClockState, string> = { BREACH: 'text-sh-crit-fg', DONE: 'text-sh-norm-fg', RUNNING: 'text-sh-warn-fg', PENDING: 'text-sh-text-3' }

export function ClockRing({ elapsedMin, targetMin, label, state, size = 76 }: { elapsedMin: number | null; targetMin: number | null; label: string; state: ClockState; size?: number }) {
  const pct = targetMin && elapsedMin !== null ? Math.min(1, elapsedMin / targetMin) : 0
  const stroke = 6
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  return (
    <div className="flex flex-col items-center gap-[4px]">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label={`${label}: ${state}`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={STROKE[state]}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - pct)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
        <span className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[18px] font-semibold leading-none tabular-nums text-sh-text">{elapsedMin === null ? '—' : elapsedMin}</span>
          {targetMin !== null && <span className="text-[11px] tabular-nums text-sh-text-3">/ {targetMin}</span>}
        </span>
      </div>
      {/* The text label, because ring fill alone is not enough. */}
      <span className={cn('text-[11px] font-semibold uppercase tracking-[0.06em]', WORD[state])}>{state}</span>
    </div>
  )
}

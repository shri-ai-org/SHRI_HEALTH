/**
 * One count and what it means — the old build's `StatTile`
 * (`src/components/primitives.tsx`) in this build's card: an 11px label, the
 * number in its tone, and a sub-line in words, so the tone never carries the
 * meaning alone.
 */

import type { ReactNode } from 'react'

import { cn } from '../lib/cn'
import type { Tone } from '../mocks/types'

import { Card } from './primitives'

const VALUE_TONE: Record<Tone, string> = {
  crit: 'text-sh-crit-fg',
  warn: 'text-sh-warn-fg',
  norm: 'text-sh-norm-fg',
  pend: 'text-sh-pend-fg',
  neu: 'text-sh-text',
}

export function StatTile({ label, value, sub, tone = 'neu', className }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; className?: string }) {
  return (
    <Card as="div" className={cn('min-h-[112px] justify-between', className)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">{label}</p>
      <div>
        <p className={cn('mt-[8px] text-[30px]/none font-semibold tabular-nums tracking-[-0.02em]', VALUE_TONE[tone])}>{value}</p>
        {sub && <p className="mt-[6px] text-[13px] text-sh-text-3">{sub}</p>}
      </div>
    </Card>
  )
}

/**
 * The live case-clock strip — ported from `src/screens/m18/CaseClock.tsx`
 * (CaseClockStrip :86-158). Every M-18 screen spec carries the same Z3 line:
 * "GP-05 patient banner PLUS the live case clock strip; the clock is visible
 * on EVERY CASE SCREEN in this module", so it is built once and passed to
 * `ScreenFrame` as `bannerExtra`.
 */

import { Brain, Clock, Radio } from 'lucide-react'

import { formatTime } from '@/data/format'
import { ACTIVE_CASE, maybeStrokeCase } from '@/data/stroke'
import { minutesBetween } from '@/store/stroke'

import { cn } from '../lib/cn'
import { shortLabel, useCaseNow, useLiveIntervals } from '../logic/caseClock'
import { Icon, PillTag } from '../ui/primitives'

const TONE = { BREACH: 'bg-sh-crit-bg text-sh-crit-fg', DONE: 'bg-sh-norm-bg text-sh-norm-fg', RUNNING: 'bg-sh-warn-bg text-sh-warn-fg', PENDING: 'bg-sh-inner text-sh-text-2' } as const
const WORD = { BREACH: 'text-sh-crit-fg', DONE: 'text-sh-norm-fg', RUNNING: 'text-sh-warn-fg', PENDING: 'text-sh-text-3' } as const

export function CaseClockStrip({ caseId = ACTIVE_CASE.id }: { caseId?: string }) {
  const intervals = useLiveIntervals()
  const caseNow = useCaseNow()
  // Each case reads its own last-known-well; the interval stamps belong to the index case's clock, so another case borrows nothing.
  const c = maybeStrokeCase(caseId) ?? ACTIVE_CASE
  const lkw = minutesBetween(c.lkw, caseNow)
  const headline = c.id === ACTIVE_CASE.id ? intervals.filter((i) => i.key === 'dtn' || i.key === 'dido' || i.key === 'd2ct') : []

  return (
    <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
      <PillTag tone="pend" size="sm" icon={Brain} className="font-semibold">
        STROKE/26-27/{caseId}
      </PillTag>
      <span className="flex items-center gap-[6px] text-[13px] font-semibold tabular-nums text-sh-text">
        <Icon icon={Clock} size={14} className="text-sh-text-3" />
        LKW {formatTime(c.lkw)}
        <span className="font-normal text-sh-text-2">
          · {Math.floor(lkw / 60)}h {lkw % 60}m ago
        </span>
      </span>
      {headline.map((i) => (
        <span key={i.key} className="flex items-center gap-[6px]">
          <span className="text-[12px] uppercase tracking-[0.06em] text-sh-text-2">{shortLabel(i.key)}</span>
          <span className={cn('rounded-[8px] px-[6px] py-[2px] text-[13px] font-bold tabular-nums', TONE[i.state])}>
            {i.elapsed === null ? '—' : i.elapsed}
            {i.targetMin !== null && <span className="font-normal">/{i.targetMin}</span>}
          </span>
          {/* The state in words too, never colour alone. */}
          <span className={cn('text-[11px] font-semibold uppercase tracking-[0.06em]', WORD[i.state])}>{i.state}</span>
        </span>
      ))}
      <span className="ml-auto flex items-center gap-[6px] text-[12px] tabular-nums text-sh-text-2">
        <Icon icon={Radio} size={12} />
        server {formatTime(caseNow)}:{String(caseNow.getSeconds()).padStart(2, '0')} · append-only
      </span>
    </div>
  )
}

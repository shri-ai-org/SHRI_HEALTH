/**
 * §7.5 Vitals (column B, top) — the latest observations first thing on the
 * record (`src/screens/m06/record/VitalsCard.tsx`), with when they were
 * charted. A compact grid of small cells — the measure above its value, the
 * unit small beside the number, the flag straight after it only where the
 * value is out of range — so a label and its value are never a card's width
 * apart. No cell is a button. With nothing charted the card keeps its place.
 */

import { Activity } from 'lucide-react'

import { VITALS } from '@/data/clinical'
import { formatTime } from '@/data/format'
import type { Patient } from '@/data/kit'
import { vitalsHistoryFor } from '@/data/vitals-history'

import { cn } from '../lib/cn'
import { EmptyState } from '../ui/EmptyState'
import { Card } from '../ui/primitives'
import { Sparkline } from '../ui/Sparkline'

import { ClinicalFlag } from './bits'

/** "116/72 mmHg" → the number and what follows it, so the unit can sit small beside it. Display only; the string is never re-derived. */
function split(value: string): { number: string; rest: string } {
  const m = /^([\d.,/]+%?)\s*(.*)$/.exec(value)
  return m ? { number: m[1], rest: m[2] } : { number: value, rest: '' }
}

export function VitalsCard({ patient: p, className }: { patient: Patient; className?: string }) {
  const rows = VITALS[p.id] ?? []
  const history = vitalsHistoryFor(p.id)
  return (
    <Card
      titleSize="sm"
      title="Vitals"
      right={rows[0] && <span className="text-[12px] tabular-nums text-sh-text-3">charted {formatTime(rows[0].at)}</span>}
      className={className}
    >
      {rows.length === 0 ? (
        <EmptyState compact icon={Activity} why="No observations charted" />
      ) : (
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-[8px]">
          {rows.map((r) => {
            const { number, rest } = split(r.value)
            // The line only where there is a history — never a trend drawn from one reading.
            const h = history.find((x) => x.label === r.label)
            return (
              <div key={r.label} className={cn('flex min-w-0 flex-col gap-[2px] rounded-[14px] bg-sh-inner px-[12px] py-[8px]')}>
                <dt className="truncate text-[12px] text-sh-text-2">{r.label}</dt>
                <dd className="flex min-w-0 flex-wrap items-center gap-x-[6px] gap-y-[4px]">
                  <span className="min-w-0 text-[15px] font-semibold tabular-nums text-sh-text">
                    {number}
                    {rest && <span className="text-[11px] font-normal text-sh-text-3"> {rest}</span>}
                  </span>
                  {r.flag !== 'Normal' && <ClinicalFlag flag={r.flag} />}
                </dd>
                {h && h.points.length > 1 && (
                  <dd className="mt-[2px]">
                    <Sparkline points={h.points} unit={h.unit} label={`${r.label} over ${h.points.length} readings`} bare />
                  </dd>
                )}
              </div>
            )
          })}
        </dl>
      )}
    </Card>
  )
}

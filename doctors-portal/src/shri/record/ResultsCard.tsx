/**
 * §7.5 Test results (column C) — how this patient's results fall, at a glance
 * (`src/screens/m06/record/ResultsCard.tsx`): a 112px ring of Normal / Out of
 * range / Critical with the total in the middle, a legend that says each count
 * in words, then the first three out-of-range tests, each one tap from its
 * detail. Everything else is on the Results tab. A patient with no results
 * keeps the card, saying so.
 */

import { ChevronRight, FlaskConical } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'

import { resultsFor } from '@/data/clinical'
import type { Patient } from '@/data/kit'
import { useClinical } from '@/store/clinical'

import { recordPath } from '../logic/record'
import { EmptyState } from '../ui/EmptyState'
import { Card, Chip, Icon } from '../ui/primitives'

import { ClinicalFlag, TextLink } from './bits'

type Key = 'normal' | 'out' | 'critical'
const SEGMENTS: { key: Key; label: string; color: string }[] = [
  { key: 'normal', label: 'Normal', color: 'var(--norm)' },
  { key: 'out', label: 'Out of range', color: 'var(--warn)' },
  { key: 'critical', label: 'Critical', color: 'var(--crit)' },
]

export function ResultsCard({ patient: p, className }: { patient: Patient; className?: string }) {
  const navigate = useNavigate()
  const acknowledgements = useClinical((s) => s.acknowledgements)
  const results = resultsFor(p.id)
  if (results.length === 0)
    return (
      <Card titleSize="sm" title="Test results" className={className}>
        <EmptyState compact icon={FlaskConical} why="No results yet" />
      </Card>
    )

  const critical = results.filter((r) => r.flag.includes('Critical')).length
  const normal = results.filter((r) => r.flag === 'Normal').length
  const counts: Record<Key, number> = { normal, out: results.length - normal - critical, critical }
  const toReview = results.filter((r) => !r.acknowledged && acknowledgements[r.id] === undefined).length
  // Three at most, so the card stays on the first screen; the rest are one tap away in Results.
  const flagged = results.filter((r) => r.flag !== 'Normal').slice(0, 3)

  return (
    <Card
      titleSize="sm"
      title={
        <span className="inline-flex items-center gap-[10px]">
          Test results
          {toReview > 0 && <Chip num={String(toReview)} word="to review" tone="pend" />}
        </span>
      }
      right={<TextLink onClick={() => navigate(recordPath(p, 'results'))}>See all</TextLink>}
      className={className}
    >
      {/* Centred in whatever the row leaves above the rows, so a taller neighbour never opens a hole. */}
      <div className="flex flex-1 items-center gap-[20px]">
        <Donut counts={counts} total={results.length} />
        <ul className="flex flex-col gap-[9px]" aria-label="Results by flag">
          {SEGMENTS.map((s) => (
            <li key={s.key} className="flex items-center gap-[8px] text-[13px]">
              <span className="size-[8px] shrink-0 rounded-full" style={{ background: s.color }} aria-hidden="true" />
              <span className="w-[92px] text-sh-text-2">{s.label}</span>
              <span className="font-semibold tabular-nums text-sh-text">{counts[s.key]}</span>
            </li>
          ))}
        </ul>
      </div>

      {flagged.length > 0 && (
        <ul className="mt-auto flex flex-col gap-[8px] pt-[16px]" aria-label="Out of range">
          {flagged.map((r) => (
            <li key={r.id}>
              <Link
                to={`/results/${r.id}`}
                className="flex min-h-[44px] w-full items-center gap-[8px] rounded-[14px] bg-sh-inner px-[12px] py-[6px] text-left transition-colors duration-150 hover:bg-sh-hover-strong"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-sh-text">{r.test}</span>
                <span className="shrink-0 text-[14px] font-semibold tabular-nums text-sh-text">
                  {r.value}
                  {r.unit && <span className="text-[11px] font-normal text-sh-text-3"> {r.unit}</span>}
                </span>
                <ClinicalFlag flag={r.flag} />
                <Icon icon={ChevronRight} size={16} className="shrink-0 text-sh-chev" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** r 44, stroke 14, from 12 o'clock, 2px gaps between segments. */
function Donut({ counts, total }: { counts: Record<Key, number>; total: number }) {
  const R = 44
  const C = 2 * Math.PI * R
  const present = SEGMENTS.map((s) => ({ ...s, n: counts[s.key] })).filter((s) => s.n > 0)
  const gap = present.length > 1 ? 2 : 0
  const arcs = present.reduce<{ key: string; color: string; dash: number; offset: number; start: number }[]>((acc, s) => {
    const start = acc.length ? acc[acc.length - 1].start + (acc[acc.length - 1].dash + gap) : 0
    const len = total > 0 ? (s.n / total) * C : 0
    acc.push({ key: s.key, color: s.color, dash: Math.max(0, len - gap), offset: start + gap / 2, start })
    return acc
  }, [])
  const label = `${total} results: ${SEGMENTS.map((s) => `${counts[s.key]} ${s.label.toLowerCase()}`).join(', ')}`

  return (
    <div className="relative size-[112px] shrink-0">
      <svg width="112" height="112" viewBox="0 0 112 112" role="img" aria-label={label}>
        <circle cx="56" cy="56" r={R} fill="none" stroke="var(--inner)" strokeWidth="14" />
        <g transform="rotate(-90 56 56)">
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx="56"
              cy="56"
              r={R}
              fill="none"
              stroke={a.color}
              strokeWidth="14"
              strokeLinecap="butt"
              strokeDasharray={`${a.dash} ${C - a.dash}`}
              strokeDashoffset={-a.offset}
            />
          ))}
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true">
        <span className="text-[24px]/none font-medium tabular-nums text-sh-text">{total}</span>
        <span className="mt-[4px] text-[11px]/none text-sh-text-3">results</span>
      </div>
    </div>
  )
}

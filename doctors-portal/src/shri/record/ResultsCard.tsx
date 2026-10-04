/**
 * §7.5 Test results (column C) — how this patient's results fall, at a glance
 * (`src/screens/m06/record/ResultsCard.tsx`): a ring of Normal / Out of range
 * / Critical with the total in the middle and a legend that says each count
 * in words; the cultures in one line; then every result, each against its
 * reference range and with its trend where there is one, most pressing first
 * — to review, then out of range, then newest — each one tap from its detail.
 *
 * The card takes its row's height from the cards beside it and never sets it:
 * the list scrolls inside, so a long record does not stretch the row and a
 * short one does not leave a hole. A patient with no results keeps the card,
 * saying so.
 */

import { ChevronRight, FlaskConical, Microscope } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'

import { RESULT_TRENDS, resultsFor, type ResultRow } from '@/data/clinical'
import type { Patient } from '@/data/kit'
import { microFor } from '@/data/results-ext'
import { useClinical } from '@/store/clinical'

import { recordPath } from '../logic/record'
import { EmptyState } from '../ui/EmptyState'
import { Card, Chip, Icon } from '../ui/primitives'
import { RangeBar } from '../ui/RangeBar'
import { Sparkline } from '../ui/Sparkline'

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
  const micro = microFor(p.id)
  if (results.length === 0)
    return (
      <Card titleSize="sm" title="Test results" className={className}>
        <EmptyState compact icon={FlaskConical} why="No results yet" />
      </Card>
    )

  const toReview = (r: ResultRow) => !r.acknowledged && acknowledgements[r.id] === undefined
  const critical = results.filter((r) => r.flag.includes('Critical')).length
  const normal = results.filter((r) => r.flag === 'Normal').length
  const counts: Record<Key, number> = { normal, out: results.length - normal - critical, critical }
  const reviewCount = results.filter(toReview).length
  // Most pressing first; `resultsFor` is newest first and the sort is stable.
  const ordered = [...results].sort((a, b) => Number(toReview(b)) - Number(toReview(a)) || Number(b.flag !== 'Normal') - Number(a.flag !== 'Normal'))
  const organisms = micro.filter((m) => !/^(no growth|normal|mrsa not|mtb not)/i.test(m.growth)).length

  return (
    <Card
      titleSize="sm"
      title={
        <span className="inline-flex items-center gap-[10px]">
          Test results
          {reviewCount > 0 && <Chip num={String(reviewCount)} word="to review" tone="pend" />}
        </span>
      }
      right={<TextLink onClick={() => navigate(recordPath(p, 'results'))}>See all</TextLink>}
      className={className}
    >
      <div className="flex items-center gap-[16px]">
        <Donut counts={counts} total={results.length} />
        <ul className="flex flex-col gap-[7px]" aria-label="Results by flag">
          {SEGMENTS.map((s) => (
            <li key={s.key} className="flex items-center gap-[8px] text-[13px]">
              <span className="size-[8px] shrink-0 rounded-full" style={{ background: s.color }} aria-hidden="true" />
              <span className="w-[92px] text-sh-text-2">{s.label}</span>
              <span className="font-semibold tabular-nums text-sh-text">{counts[s.key]}</span>
            </li>
          ))}
        </ul>
      </div>

      {micro.length > 0 && (
        <p className="mt-[12px] flex items-center gap-[8px] rounded-[12px] bg-sh-inner px-[12px] py-[6px] text-[13px] text-sh-text-2">
          <Icon icon={Microscope} size={14} />
          <span>
            {micro.length} {micro.length === 1 ? 'culture or swab' : 'cultures and swabs'} ·{' '}
            <span className="font-medium text-sh-text">{organisms === 0 ? 'no organism grown' : `${organisms} with an organism`}</span>
          </span>
        </p>
      )}

      <ul className="-mx-[4px] mt-[12px] flex min-h-0 flex-1 flex-col gap-[6px] overflow-y-auto px-[4px] pb-[2px]" aria-label="Every result, most pressing first">
        {ordered.map((r) => (
          <ResultRowLine key={r.id} r={r} review={toReview(r)} />
        ))}
      </ul>
    </Card>
  )
}

function ResultRowLine({ r, review }: { r: ResultRow; review: boolean }) {
  const series = RESULT_TRENDS[r.id] ?? []
  const n = Number(r.value)
  const bounded = r.refLow !== undefined && r.refHigh !== undefined && Number.isFinite(n)
  const where = !bounded ? '' : n > r.refHigh! ? 'above range' : n < r.refLow! ? 'below range' : 'within range'
  return (
    <li>
      <Link
        to={`/results/${r.id}`}
        className="grid min-h-[44px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[10px] gap-y-[4px] rounded-[14px] bg-sh-inner px-[12px] py-[7px] text-left transition-colors duration-150 hover:bg-sh-hover-strong"
      >
        <span className="flex min-w-0 items-center gap-[6px]">
          <span className="truncate text-[13px] font-medium text-sh-text">{r.test}</span>
          {review && <span className="size-[6px] shrink-0 rounded-full bg-sh-pend-fg" title="To review" aria-label="to review" />}
        </span>
        <span className="flex items-center justify-end gap-[6px]">
          <span className="text-[14px] font-semibold tabular-nums text-sh-text">
            {r.value}
            {r.unit && <span className="text-[11px] font-normal text-sh-text-3"> {r.unit}</span>}
          </span>
          {r.flag !== 'Normal' && <ClinicalFlag flag={r.flag} />}
          <Icon icon={ChevronRight} size={15} className="shrink-0 text-sh-chev" />
        </span>
        {(bounded || series.length > 1) && (
          <span className="col-span-2 flex items-center gap-[10px] text-[11px] tabular-nums text-sh-text-3">
            {bounded && (
              <>
                <RangeBar value={n} low={r.refLow!} high={r.refHigh!} label={`${r.test} ${r.value} ${r.unit}, reference ${r.refRange}, ${where}`} />
                <span className="truncate">ref {r.refRange}</span>
              </>
            )}
            {series.length > 1 && (
              <span className="ml-auto">
                <Sparkline points={series} unit={r.unit} label={`${r.test} over ${series.length} results`} bare width={56} />
              </span>
            )}
          </span>
        )}
      </Link>
    </li>
  )
}

/** r 38, stroke 12, from 12 o'clock, 2px gaps between segments. */
function Donut({ counts, total }: { counts: Record<Key, number>; total: number }) {
  const R = 38
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
    <div className="relative size-[96px] shrink-0">
      <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label={label}>
        <circle cx="48" cy="48" r={R} fill="none" stroke="var(--inner)" strokeWidth="12" />
        <g transform="rotate(-90 48 48)">
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx="48"
              cy="48"
              r={R}
              fill="none"
              stroke={a.color}
              strokeWidth="12"
              strokeLinecap="butt"
              strokeDasharray={`${a.dash} ${C - a.dash}`}
              strokeDashoffset={-a.offset}
            />
          ))}
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true">
        <span className="text-[22px]/none font-medium tabular-nums text-sh-text">{total}</span>
        <span className="mt-[4px] text-[11px]/none text-sh-text-3">results</span>
      </div>
    </div>
  )
}

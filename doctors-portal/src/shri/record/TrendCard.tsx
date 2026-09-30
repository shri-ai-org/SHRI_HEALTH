/**
 * §7.5 Trend (row 2, left) — the one trend on the record
 * (`src/screens/m06/record/TrendCard.tsx`): the lab value that matters most for
 * this patient, over time, against its reference range. "Matters most" is
 * decided in the open, in this order: a result still waiting for review, then
 * one out of range, then the newest; up to three series, switched by pills —
 * the same chart, never a second one. One chart: the reference range as a
 * shaded band, an accent line, a warning marker out of range and a critical
 * one where the value is critical, only the latest point labelled; hover
 * shows the nearest point. The values view is a plain table. A patient with
 * no repeated result keeps the card, saying so.
 */

import { ChartLine } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { trendPointsFor, type ResultRow } from '@/data/clinical'
import { formatDate } from '@/data/format'
import type { VitalSeries } from '@/data/vitals-history'

import { cn } from '../lib/cn'
import { EmptyState } from '../ui/EmptyState'
import { Card, Pill } from '../ui/primitives'

import { ClinicalFlag } from './bits'

const H = 180
const PAD_T = 38
const PAD_B = 10
const PAD_X = 14

type Point = ReturnType<typeof trendPointsFor>[number]

const VITAL = 'vital:'

/**
 * A vitals series in the shape the chart reads — used only when the patient has
 * no result with a series, so the card charts what is there (Rahul's head-injury
 * observations) instead of standing empty. It never opens a result page.
 */
function vitalRow(v: VitalSeries): ResultRow {
  const last = v.points[v.points.length - 1]
  return {
    id: `${VITAL}${v.label}`,
    patientId: '',
    test: v.label,
    value: String(last.value),
    unit: v.unit,
    refRange: v.low !== undefined && v.high !== undefined ? `${v.low} – ${v.high}` : '—',
    flag: 'Normal',
    reportedAt: last.at,
    critical: false,
    acknowledged: true,
    aiReason: '',
    band: 'HIGH',
    refLow: v.low,
    refHigh: v.high,
  }
}

export function TrendCard({
  series: results,
  vitals = [],
  title = 'Trend',
  showOpen = true,
  className,
}: {
  series: ResultRow[]
  /** Charted only when no result has a series. */
  vitals?: VitalSeries[]
  title?: string
  /** "Open result" — absent on the result's own page, where it would open itself. */
  showOpen?: boolean
  className?: string
}) {
  const navigate = useNavigate()
  const [chosen, setChosen] = useState<string | null>(null)
  const [view, setView] = useState<'chart' | 'values'>('chart')
  const fromVitals = results.length === 0
  const series = fromVitals ? vitals.filter((v) => v.points.length > 1).slice(0, 3).map(vitalRow) : results
  const r = series.find((x) => x.id === chosen) ?? series[0]
  // Nothing repeated yet: the card keeps its place and says so, rather than leaving the row a card short.
  if (!r)
    return (
      <Card titleSize="sm" title={title} className={className}>
        <EmptyState compact icon={ChartLine} why="No result has two or more values yet" />
      </Card>
    )
  const vital = fromVitals ? vitals.find((v) => `${VITAL}${v.label}` === r.id) : undefined
  const points: Point[] = vital
    ? vital.points.map((pt) => ({
        at: pt.at,
        value: pt.value,
        flag: vital.high !== undefined && pt.value > vital.high ? 'high' : vital.low !== undefined && pt.value < vital.low ? 'low' : undefined,
      }))
    : trendPointsFor(r)
  const decimals = points.some((pt) => !Number.isInteger(pt.value)) ? 1 : 0
  const fmt = (n: number) => n.toFixed(decimals)
  // Over a year or more, the axis names the month and year; otherwise the day.
  const long = points.length > 1 && points[points.length - 1].at.getTime() - points[0].at.getTime() > 300 * 86_400_000
  const when = (d: Date) => (long ? formatDate(d).slice(3) : formatDate(d).replace(/-\d{4}$/, ''))
  const range = r.refLow !== undefined && r.refHigh !== undefined ? `reference ${fmt(r.refLow)}–${fmt(r.refHigh)}` : 'no reference range'

  return (
    <Card
      titleSize="sm"
      title={title}
      right={
        series.length > 1 && (
          // Wrapped rows sit 16px apart so each pill keeps a 44px target of its own.
          <div role="group" aria-label={fromVitals ? 'Which vital sign to trend' : 'Which result to trend'} className="flex flex-wrap justify-end gap-x-[6px] gap-y-[16px]">
            {series.map((t) => {
              const on = t.id === r.id
              return (
                <Pill key={t.id} size="sm" variant={on ? 'primary' : 'control'} aria-pressed={on} onClick={() => setChosen(t.id)}>
                  {t.test}
                </Pill>
              )
            })}
          </div>
        )
      }
      className={className}
    >
      <p className="text-[12px] text-sh-text-3">
        {r.test}
        {r.unit ? ` · ${r.unit}` : ''} · {points.length} {fromVitals ? 'readings — no result has a series yet' : 'results'} · {range}
      </p>

      {view === 'chart' ? <TrendChart r={r} points={points} fmt={fmt} when={when} /> : <ValuesTable r={r} points={points} fmt={fmt} when={when} />}

      <div className="mt-auto flex items-center gap-[8px] pt-[16px]">
        <Pill variant="control" size="md" onClick={() => setView(view === 'chart' ? 'values' : 'chart')}>
          {view === 'chart' ? 'Show the values' : 'Show the chart'}
        </Pill>
        {showOpen && !fromVitals && (
          <Pill variant="primary" size="md" className="ml-auto" onClick={() => navigate(`/results/${r.id}`)}>
            Open result
          </Pill>
        )}
      </div>
    </Card>
  )
}

const X_LABEL: Record<'first' | 'mid' | 'last', string> = { first: 'translate-x-0', mid: '-translate-x-1/2', last: '-translate-x-full' }

function TrendChart({ r, points: pts, fmt, when }: { r: ResultRow; points: Point[]; fmt: (n: number) => string; when: (d: Date) => string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const update = () => setW(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const n = pts.length
  const last = n - 1
  const values = pts.map((pt) => pt.value)
  const bounded = r.refLow !== undefined && r.refHigh !== undefined
  const lo = Math.min(...(bounded ? [r.refLow!] : []), ...values)
  const hi = Math.max(...(bounded ? [r.refHigh!] : []), ...values)
  const span = hi - lo || 1
  const x = (i: number) => (n === 1 ? w / 2 : PAD_X + (i * (w - 2 * PAD_X)) / (n - 1))
  const y = (v: number) => PAD_T + (1 - (v - lo) / span) * (H - PAD_T - PAD_B)
  const path = pts.map((pt, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(pt.value).toFixed(1)}`).join(' ')
  const clamp = (v: number, half: number) => Math.min(Math.max(v, half), w - half)
  const unit = r.unit ? ` ${r.unit}` : ''

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const rect = wrap.current?.getBoundingClientRect()
    if (!rect || n === 0) return
    const px = e.clientX - rect.left
    let best = 0
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i
    setHover(best)
  }

  return (
    <div className="mt-[10px]">
      <div ref={wrap} className="relative h-[180px] w-full touch-none select-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {w > 0 && (
          <svg
            width={w}
            height={H}
            viewBox={`0 0 ${w} ${H}`}
            className="block"
            role="img"
            aria-label={`${r.test}: ${pts.map((pt) => `${when(pt.at)} ${fmt(pt.value)}${unit}`).join(', ')}`}
          >
            {bounded && <rect x="0" y={y(r.refHigh!)} width={w} height={Math.max(0, y(r.refLow!) - y(r.refHigh!))} rx="8" fill="var(--norm-bg)" />}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD_T - 22} y2={H} stroke="var(--line-strong)" strokeWidth="1" />}
            <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
            {pts.map((pt, i) =>
              pt.flag ? (
                <circle
                  key={pt.at.getTime()}
                  cx={x(i)}
                  cy={y(pt.value)}
                  r={hover === i ? 7 : 6}
                  fill={pt.flag === 'critical' ? 'var(--crit)' : 'var(--warn)'}
                  stroke="var(--card)"
                  strokeWidth="2"
                />
              ) : (
                <circle key={pt.at.getTime()} cx={x(i)} cy={y(pt.value)} r={hover === i ? 5 : 4} fill="var(--accent)" />
              ),
            )}
          </svg>
        )}
        {w > 0 && n > 0 && hover === null && (
          <span
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-full bg-sh-primary px-[8px] py-[5px] text-[11px]/none font-semibold tabular-nums text-sh-on-primary"
            style={{ left: clamp(x(last), 24), top: y(pts[last].value) - 11 }}
          >
            {fmt(pts[last].value)}
          </span>
        )}
        {w > 0 && hover !== null && (
          <span
            role="status"
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-full bg-sh-primary px-[10px] py-[5px] text-[11px]/none font-semibold tabular-nums text-sh-on-primary shadow-sh-pop"
            style={{ left: clamp(x(hover), 62), top: y(pts[hover].value) - 12 }}
          >
            {when(pts[hover].at)} · {fmt(pts[hover].value)}
            {unit}
          </span>
        )}
      </div>
      <div className="relative mt-[6px] h-[12px] text-[10px]/none tabular-nums text-sh-text-3" aria-hidden="true">
        {w > 0 &&
          pts.map((pt, i) => (
            <span key={pt.at.getTime()} className={cn('absolute top-0 whitespace-nowrap', X_LABEL[i === 0 ? 'first' : i === last ? 'last' : 'mid'])} style={{ left: x(i) }}>
              {when(pt.at)}
            </span>
          ))}
      </div>
    </div>
  )
}

function ValuesTable({ r, points, fmt, when }: { r: ResultRow; points: Point[]; fmt: (n: number) => string; when: (d: Date) => string }) {
  const rows = [...points].reverse()
  const range = r.refLow !== undefined && r.refHigh !== undefined ? `${fmt(r.refLow)}–${fmt(r.refHigh)}` : '—'
  return (
    <table className="mt-[10px] w-full border-collapse text-[13px] tabular-nums">
      <thead>
        <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">
          <th scope="col" className="h-[28px] font-semibold">
            When
          </th>
          <th scope="col" className="h-[28px] font-semibold">
            Value
          </th>
          <th scope="col" className="h-[28px] font-semibold">
            Range
          </th>
          <th scope="col" className="h-[28px]">
            <span className="sr-only">Flag</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((pt) => (
          <tr key={pt.at.getTime()} className="border-t border-sh-line">
            <td className="h-[40px] text-sh-text-2">{when(pt.at)}</td>
            <td className="h-[40px] font-semibold text-sh-text">
              {fmt(pt.value)} {r.unit && <span className="text-[11px] font-normal text-sh-text-3">{r.unit}</span>}
            </td>
            <td className="h-[40px] text-sh-text-2">{range}</td>
            <td className="h-[40px] text-right">
              {/* Without a reference range a value is neither in nor out of it. */}
              {pt.flag ? <ClinicalFlag flag={pt.flag} /> : range !== '—' && <ClinicalFlag flag="Normal" />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

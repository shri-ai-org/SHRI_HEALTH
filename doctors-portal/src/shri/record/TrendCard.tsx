/**
 * §7.5 Trend (row 2, left) — the one trend on the record
 * (`src/screens/m06/record/TrendCard.tsx`): the lab value that matters most for
 * this patient, over time, against its reference range. "Matters most" is
 * decided in the open, in this order: a result still waiting for review, then
 * one out of range, then the newest; up to three series, switched by pills —
 * the same chart, never a second one. Above it, the latest value, the change
 * since the reading before, and the spread of the readings. The chart's scale
 * follows the readings (the axis says what it is), so a change shows as one;
 * the reference range is a shaded band with its limits marked where they fall
 * in view; a smooth line over a soft fill, each reading labelled, the latest
 * ringed, a warning marker out of range and a critical one where the value is
 * critical; hover shows the nearest point. The values view is a plain table. A patient with
 * no repeated result keeps the card, saying so.
 */

import { ChartLine, Minus, TrendingDown, TrendingUp } from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { trendPointsFor, type ResultRow } from '@/data/clinical'
import { formatDate } from '@/data/format'
import type { VitalSeries } from '@/data/vitals-history'

import { cn } from '../lib/cn'
import { EmptyState } from '../ui/EmptyState'
import { Card, Icon, Pill } from '../ui/primitives'

import { ClinicalFlag } from './bits'

const H = 180
const PAD_T = 38
const PAD_B = 10

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

      <TrendStats r={r} points={points} fmt={fmt} when={when} />
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
const PAD_L = 34
const PAD_R = 18

/** A smooth line through every point that never overshoots between them (monotone cubic, Fritsch–Carlson). */
function smoothPath(xs: number[], ys: number[]): string {
  const n = xs.length
  if (n < 2) return n ? `M${xs[0]} ${ys[0]}` : ''
  const dx = xs.slice(1).map((v, i) => v - xs[i])
  const m = dx.map((d, i) => (ys[i + 1] - ys[i]) / (d || 1))
  const t = xs.map((_, i) => (i === 0 ? m[0] : i === n - 1 ? m[n - 2] : m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2))
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0
      t[i + 1] = 0
      continue
    }
    const a = t[i] / m[i]
    const b = t[i + 1] / m[i]
    const h = Math.hypot(a, b)
    if (h > 3) {
      t[i] = (3 * a * m[i]) / h
      t[i + 1] = (3 * b * m[i]) / h
    }
  }
  let d = `M${xs[0].toFixed(1)} ${ys[0].toFixed(1)}`
  for (let i = 0; i < n - 1; i++) {
    const c = dx[i] / 3
    d += ` C${(xs[i] + c).toFixed(1)} ${(ys[i] + t[i] * c).toFixed(1)} ${(xs[i + 1] - c).toFixed(1)} ${(ys[i + 1] - t[i + 1] * c).toFixed(1)} ${xs[i + 1].toFixed(1)} ${ys[i + 1].toFixed(1)}`
  }
  return d
}

/** Three round tick values across a domain. */
function ticks(lo: number, hi: number): number[] {
  const raw = (hi - lo) / 3
  const mag = 10 ** Math.floor(Math.log10(raw || 1))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) ?? 10 * mag
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)))
  return out
}

/**
 * The scale follows the readings, so a change shows as a change: the readings
 * with room around them, widened to take in a reference limit only when that
 * keeps the readings at least half the height. The axis says what the scale is.
 */
function domainOf(values: number[], refLow?: number, refHigh?: number): [number, number] {
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  const pad = Math.max((hi - lo) * 0.35, Math.abs(hi) * 0.06, 0.1)
  lo -= pad
  hi += pad
  const own = hi - lo
  for (const b of [refLow, refHigh]) {
    if (b === undefined) continue
    const nlo = Math.min(lo, b)
    const nhi = Math.max(hi, b)
    if (nhi - nlo <= own * 2) {
      lo = nlo
      hi = nhi
    }
  }
  return [lo, hi]
}

function TrendStats({ r, points: pts, fmt, when }: { r: ResultRow; points: Point[]; fmt: (n: number) => string; when: (d: Date) => string }) {
  const last = pts[pts.length - 1]
  const prev = pts[pts.length - 2]
  const diff = prev ? last.value - prev.value : 0
  const values = pts.map((p) => p.value)
  const unit = r.unit ? ` ${r.unit}` : ''
  const Arrow = diff > 0 ? TrendingUp : diff < 0 ? TrendingDown : Minus
  return (
    <div className="mt-[12px] grid grid-cols-3 gap-[8px]">
      <div className="min-w-0 rounded-[14px] bg-sh-inner px-[12px] py-[8px]">
        <p className="text-[11px] text-sh-text-3">Latest · {when(last.at)}</p>
        <p className="mt-[2px] flex items-baseline gap-[4px] truncate">
          <span className="text-[20px]/[24px] font-semibold tabular-nums text-sh-text">{fmt(last.value)}</span>
          <span className="text-[11px] text-sh-text-3">{r.unit}</span>
        </p>
      </div>
      <div className="min-w-0 rounded-[14px] bg-sh-inner px-[12px] py-[8px]">
        <p className="text-[11px] text-sh-text-3">{prev ? `Since ${when(prev.at)}` : 'Change'}</p>
        <p className="mt-[2px] flex items-center gap-[5px] truncate">
          <span className={cn('inline-flex size-[22px] shrink-0 items-center justify-center rounded-full', last.flag ? 'bg-sh-warn-bg text-sh-warn-fg' : 'bg-sh-accent-soft text-sh-text')}>
            <Icon icon={Arrow} size={13} />
          </span>
          <span className="text-[16px]/[24px] font-semibold tabular-nums text-sh-text">
            {diff > 0 ? '+' : diff < 0 ? '−' : ''}
            {fmt(Math.abs(diff))}
          </span>
          {prev && prev.value !== 0 && <span className="text-[11px] tabular-nums text-sh-text-3">{Math.round((Math.abs(diff) / Math.abs(prev.value)) * 100)}%</span>}
        </p>
      </div>
      <div className="min-w-0 rounded-[14px] bg-sh-inner px-[12px] py-[8px]">
        <p className="text-[11px] text-sh-text-3">{pts.length} readings</p>
        <p className="mt-[2px] truncate text-[16px]/[24px] font-semibold tabular-nums text-sh-text">
          {fmt(Math.min(...values))}–{fmt(Math.max(...values))}
          <span className="text-[11px] font-normal text-sh-text-3">{unit}</span>
        </p>
      </div>
    </div>
  )
}

function TrendChart({ r, points: pts, fmt, when }: { r: ResultRow; points: Point[]; fmt: (n: number) => string; when: (d: Date) => string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const gradient = useId()
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
  const [lo, hi] = domainOf(values, r.refLow, r.refHigh)
  const span = hi - lo || 1
  const x = (i: number) => (n === 1 ? w / 2 : PAD_L + (i * (w - PAD_L - PAD_R)) / (n - 1))
  const y = (v: number) => PAD_T + (1 - (v - lo) / span) * (H - PAD_T - PAD_B)
  const xs = pts.map((_, i) => x(i))
  const ys = pts.map((pt) => y(pt.value))
  const line = smoothPath(xs, ys)
  const area = n > 1 ? `${line} L${xs[last].toFixed(1)} ${H - PAD_B} L${xs[0].toFixed(1)} ${H - PAD_B} Z` : ''
  const clamp = (v: number, half: number) => Math.min(Math.max(v, half), w - half)
  const unit = r.unit ? ` ${r.unit}` : ''
  const inView = (v?: number) => v !== undefined && v >= lo && v <= hi
  const bandTop = r.refHigh !== undefined ? y(Math.min(r.refHigh, hi)) : undefined
  const bandBottom = r.refLow !== undefined ? y(Math.max(r.refLow, lo)) : undefined
  const showBand = r.refLow !== undefined && r.refHigh !== undefined && r.refHigh >= lo && r.refLow <= hi
  const labelled = n <= 8

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
            className="block overflow-visible"
            role="img"
            aria-label={`${r.test}: ${pts.map((pt) => `${when(pt.at)} ${fmt(pt.value)}${unit}`).join(', ')}`}
          >
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {ticks(lo, hi).map((t) => (
              <g key={t}>
                <line x1={PAD_L} x2={w - PAD_R} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
                <text x={PAD_L - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill="var(--muted)" className="tabular-nums">
                  {Number.isInteger(t) ? t : t.toFixed(1)}
                </text>
              </g>
            ))}
            {showBand && <rect x={PAD_L} y={bandTop} width={w - PAD_L - PAD_R} height={Math.max(0, bandBottom! - bandTop!)} rx="6" fill="var(--norm-bg)" opacity="0.8" />}
            {[r.refHigh, r.refLow].map(
              (b, k) =>
                inView(b) && (
                  <g key={k}>
                    <line x1={PAD_L} x2={w - PAD_R} y1={y(b!)} y2={y(b!)} stroke="var(--free-edge)" strokeWidth="1" strokeDasharray="4 4" />
                    <text x={w - PAD_R} y={y(b!) + (k === 0 ? -5 : 12)} textAnchor="end" fontSize="10" fontWeight="600" fill="var(--norm-fg)">
                      {k === 0 ? 'upper' : 'lower'} {fmt(b!)}
                    </text>
                  </g>
                ),
            )}
            {area && <path d={area} fill={`url(#${gradient})`} />}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD_T - 22} y2={H - PAD_B} stroke="var(--line-strong)" strokeWidth="1" />}
            <path d={line} fill="none" stroke="var(--busy-edge)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
            {n > 0 && <circle cx={xs[last]} cy={ys[last]} r="11" fill="var(--accent)" opacity="0.28" />}
            {pts.map((pt, i) => {
              const tone = pt.flag === 'critical' ? 'var(--crit)' : pt.flag ? 'var(--warn)' : i === last ? 'var(--busy-edge)' : 'var(--card)'
              return (
                <g key={pt.at.getTime()}>
                  <circle cx={xs[i]} cy={ys[i]} r={hover === i || i === last ? 6 : 4.5} fill={tone} stroke={pt.flag ? 'var(--card)' : 'var(--busy-edge)'} strokeWidth="2" />
                  {labelled && hover === null && i !== last && (
                    <text x={xs[i]} y={ys[i] - 11} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--text-2)" className="tabular-nums">
                      {fmt(pt.value)}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        )}
        {w > 0 && n > 0 && hover === null && (
          <span
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-full bg-sh-primary px-[8px] py-[5px] text-[11px]/none font-semibold tabular-nums text-sh-on-primary"
            style={{ left: clamp(x(last), 24), top: y(pts[last].value) - 14 }}
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

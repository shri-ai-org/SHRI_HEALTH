/**
 * SHRI_HEALTH: the Test results tab's trends (S-06-13), above the reports. One small graph per test
 * with two or more numeric values (logic/labTrends.ts): its values over time on a time axis in the
 * clinic's calendar, the reference range as a shaded band, each high, low or abnormal value drawn
 * as a diamond and named in words, the latest value with its unit, and the range in a plain line
 * ("High (above 5.6)"). A test with one value shows the value only; a text result has no graph.
 * The drawing is TrendCard's (smooth line, band, ticks); each point takes keyboard focus and says
 * its date, value and flag. Every time is the clinic's (D40).
 */

import { ChartLine } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

import { formatDate } from '../../../shri-health/format'
import type { LabReport } from '../../../shri-health/results'
import { cn } from '../lib/cn'
import { FLAG_WORD, formatValue, labSeries, rangeLine, trendSummary, type LabReading, type LabSeries } from '../logic/labTrends'
import { Card, Icon } from '../ui/primitives'

import { domainOf, smoothPath, ticks } from './TrendCard'

const H = 132
const PAD_T = 14
const PAD_B = 10
const PAD_L = 34
const PAD_R = 14

const day = (at: string) => formatDate(at)
const unitOf = (s: LabSeries) => (s.unit ? ` ${s.unit}` : '')
const isCritical = (r: LabReading) => r.flag === 'critical-high' || r.flag === 'critical-low'

function pointLabel(s: LabSeries, r: LabReading): string {
  return `${day(r.at)}: ${formatValue(r.value)}${unitOf(s)}${r.flag ? `, ${FLAG_WORD[r.flag].toLowerCase()}` : ''}`
}

export function LabTrendCard({ reports }: { reports: LabReport[] }) {
  const series = labSeries(reports)
  const trended = series.filter((s) => s.readings.length > 1)
  const single = series.filter((s) => s.readings.length === 1)
  if (trended.length === 0) return null
  return (
    <Card
      aria-label="Trends"
      titleSize="sm"
      title={
        <span className="inline-flex items-center gap-[10px]">
          <Icon icon={ChartLine} size={16} className="text-sh-text-2" />
          Trends
        </span>
      }
    >
      <p className="-mt-[6px] mb-[12px] text-[12px] text-sh-text-3">Each test with two or more results, oldest to newest. The shaded band is the reference range.</p>
      <ul className="grid grid-cols-1 gap-[12px] lg:grid-cols-2" aria-label="Tests over time">
        {trended.map((s) => (
          <li key={s.key}>
            <TrendPanel s={s} />
          </li>
        ))}
      </ul>
      {single.length > 0 && (
        <div className="mt-[14px]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">One result so far</p>
          <ul className="mt-[6px] flex flex-wrap gap-[8px]" aria-label="Tests with one result">
            {single.map((s) => {
              const r = s.readings[0]
              return (
                <li key={s.key} className="rounded-[12px] bg-sh-inner px-[10px] py-[6px] text-[12px] text-sh-text-2">
                  <span className="font-medium text-sh-text">{s.name}</span> {formatValue(r.value)}
                  {unitOf(s)}
                  {r.flag && <span className="font-semibold text-sh-text"> · {FLAG_WORD[r.flag]}</span>}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </Card>
  )
}

function TrendPanel({ s }: { s: LabSeries }) {
  const latest = s.readings[s.readings.length - 1]
  return (
    <section className="rounded-[16px] bg-sh-inner px-[14px] pb-[10px] pt-[12px]" aria-label={s.name}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-[10px] gap-y-[2px]">
        <h3 className="text-[14px] font-semibold text-sh-text">{s.name}</h3>
        <p className="tabular-nums">
          <span className="text-[17px] font-semibold text-sh-text">{formatValue(latest.value)}</span>
          {s.unit && <span className="ml-[4px] text-[12px] text-sh-text-3">{s.unit}</span>}
          <span className="ml-[6px] text-[11px] text-sh-text-3">latest, {day(latest.at)}</span>
        </p>
      </div>
      <p className={cn('mt-[2px] text-[12px] font-medium', latest.flag ? 'text-sh-text' : 'text-sh-text-2')}>{rangeLine(s)}</p>
      <TrendGraph s={s} />
    </section>
  )
}

function TrendGraph({ s }: { s: LabSeries }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [active, setActive] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const update = () => setW(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pts = s.readings
  const times = pts.map((r) => Date.parse(r.at))
  const t0 = times[0]
  const tSpan = times[times.length - 1] - t0 || 1
  // Unlike TrendCard's, the scale always takes in the reference range, so the band is always there to read against.
  const [lo, hi] = domainOf([...pts.map((r) => r.value), ...[s.low, s.high].filter((b): b is number => b !== undefined)])
  const span = hi - lo || 1
  // A time axis: the space between two points is the time between them.
  const x = (i: number) => PAD_L + ((times[i] - t0) / tSpan) * (w - PAD_L - PAD_R)
  const y = (v: number) => PAD_T + (1 - (v - lo) / span) * (H - PAD_T - PAD_B)
  const xs = pts.map((_, i) => x(i))
  const ys = pts.map((r) => y(r.value))
  const showBand = s.low !== undefined && s.high !== undefined && s.high >= lo && s.low <= hi
  const bandTop = s.high !== undefined ? y(Math.min(s.high, hi)) : 0
  const bandBottom = s.low !== undefined ? y(Math.max(s.low, lo)) : 0
  const clamp = (v: number, half: number) => Math.min(Math.max(v, half), w - half)
  const shown = active ?? pts.length - 1

  return (
    <div className="mt-[8px]">
      <p className="sr-only">{trendSummary(s, day)}</p>
      <div ref={wrap} className="relative h-[132px] w-full select-none">
        {w > 0 && (
          <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} className="block overflow-visible" role="group" aria-label={`${s.name}: ${trendSummary(s, day)}`}>
            {ticks(lo, hi).map((t) => (
              <g key={t} aria-hidden="true">
                <line x1={PAD_L} x2={w - PAD_R} y1={y(t)} y2={y(t)} stroke="var(--line-strong)" strokeWidth="1" />
                <text x={PAD_L - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill="var(--muted)" className="tabular-nums">
                  {formatValue(t)}
                </text>
              </g>
            ))}
            {showBand && <rect aria-hidden="true" x={PAD_L} y={bandTop} width={w - PAD_L - PAD_R} height={Math.max(0, bandBottom - bandTop)} rx="6" fill="var(--norm-bg)" opacity="0.9" />}
            <path aria-hidden="true" d={smoothPath(xs, ys)} fill="none" stroke="var(--busy-edge)" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
            {pts.map((r, i) => {
              const on = shown === i
              const label = pointLabel(s, r)
              return (
                <g
                  key={r.at}
                  tabIndex={0}
                  role="img"
                  aria-label={label}
                  className="cursor-default outline-none [&:focus-visible>.focus-mark]:opacity-100"
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive(null)}
                >
                  <title>{label}</title>
                  <circle className="focus-mark opacity-0" cx={xs[i]} cy={ys[i]} r="11" fill="none" stroke="var(--busy-edge)" strokeWidth="2" />
                  {/* A transparent target, 22px across, so a point is easy to hover. */}
                  <circle cx={xs[i]} cy={ys[i]} r="11" fill="transparent" />
                  {r.flag ? (
                    <rect
                      x={xs[i] - 5.5}
                      y={ys[i] - 5.5}
                      width="11"
                      height="11"
                      transform={`rotate(45 ${xs[i]} ${ys[i]})`}
                      fill={isCritical(r) ? 'var(--crit)' : 'var(--warn)'}
                      stroke="var(--card)"
                      strokeWidth="2"
                    />
                  ) : (
                    <circle cx={xs[i]} cy={ys[i]} r={on ? 5.5 : 4.5} fill={i === pts.length - 1 ? 'var(--busy-edge)' : 'var(--card)'} stroke="var(--busy-edge)" strokeWidth="2" />
                  )}
                </g>
              )
            })}
          </svg>
        )}
        {w > 0 && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-full bg-sh-primary px-[9px] py-[4px] text-[11px]/none font-semibold tabular-nums text-sh-on-primary"
            style={{ left: clamp(xs[shown], 70), top: ys[shown] - 10 }}
          >
            {active === null ? formatValue(pts[shown].value) : `${day(pts[shown].at)} · ${formatValue(pts[shown].value)}${unitOf(s)}`}
            {pts[shown].flag && ` · ${FLAG_WORD[pts[shown].flag!]}`}
          </span>
        )}
      </div>
      <div className="mt-[4px] flex justify-between text-[10px]/none tabular-nums text-sh-text-3" aria-hidden="true">
        <span style={{ marginLeft: PAD_L }}>{day(pts[0].at)}</span>
        <span>{day(pts[pts.length - 1].at)}</span>
      </div>
    </div>
  )
}

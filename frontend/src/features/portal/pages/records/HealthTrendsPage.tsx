import { BarChart3, List } from 'lucide-react'
import { useState } from 'react'
import { EmptyState, formatHeightFeetInches, toUsDisplay } from '../../../../design-system'
import { cn } from '../../../../design-system/lib/cn'
import { usePortalApi } from '../../api/portalApi'
import type { Vital } from '../../api/types'
import { useResource } from '../../api/useResource'
import { AsyncPanel, Card, formatInstantShort, PageHeader, Pager, usePaged } from '../../ui'

const TZ = 'America/Chicago'

interface Series {
  label: string
  /** A token class for the stroke, so dark mode works. */
  stroke: string
  dash?: string
  values: Array<number | undefined>
}

/** A line chart drawn in SVG. The List view has the same numbers, so nothing depends on seeing lines. */
function LineChart({ title, unit, dates, series }: { title: string; unit: string; dates: string[]; series: Series[] }) {
  const W = 560
  const H = 200
  const pad = { l: 40, r: 12, t: 12, b: 28 }
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== undefined))
  if (all.length < 2) return <EmptyState title={`Not enough ${title.toLowerCase()} readings for a chart`} />
  const min = Math.floor(Math.min(...all) * 0.95)
  const max = Math.ceil(Math.max(...all) * 1.05)
  const x = (i: number) => pad.l + (dates.length === 1 ? 0 : (i * (W - pad.l - pad.r)) / (dates.length - 1))
  const y = (v: number) => pad.t + ((max - v) * (H - pad.t - pad.b)) / (max - min || 1)
  const latest = series.map((s) => `${s.label} ${s.values[s.values.length - 1] ?? '—'}`).join(', ')
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title} over ${dates.length} visits. Latest: ${latest} ${unit}.`}>
        {[min, Math.round((min + max) / 2), max].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="stroke-border-soft" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="fill-ink-subtle text-[11px]">
              {t}
            </text>
          </g>
        ))}
        {dates.map((d, i) => (
          <text key={d} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle'} className="fill-ink-subtle text-[11px]">
            {new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: '2-digit', year: '2-digit' }).format(new Date(d))}
          </text>
        ))}
        {series.map((s) => {
          const pts = s.values.map((v, i) => (v === undefined ? null : ([x(i), y(v)] as const))).filter((p): p is readonly [number, number] => p !== null)
          return (
            <g key={s.label}>
              <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" className={s.stroke} strokeWidth={2.5} strokeDasharray={s.dash} strokeLinejoin="round" />
              {pts.map(([px, py], i) => (
                <circle key={i} cx={px} cy={py} r={4} className={`${s.stroke} fill-surface-1`} strokeWidth={2} />
              ))}
            </g>
          )
        })}
      </svg>
      {series.length > 1 ? (
        <figcaption className="mt-2 flex flex-wrap gap-4 text-xs text-ink-muted">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5">
              <svg width="24" height="8" aria-hidden="true">
                <line x1="0" x2="24" y1="4" y2="4" className={s.stroke} strokeWidth={2.5} strokeDasharray={s.dash} />
              </svg>
              {s.label}
            </span>
          ))}
        </figcaption>
      ) : null}
    </figure>
  )
}

/** The old list view: one column per visit (newest first), one row per measurement, 3 visits a page. */
function TrendTable({ vitals }: { vitals: Vital[] }) {
  const paged = usePaged([...vitals].reverse(), 3)
  const q = (v: Vital['weight']) => (v ? toUsDisplay(v).text : '—')
  const rows: Array<[string, (v: Vital) => string]> = [
    ['Blood Pressure', (v) => (v.systolic && v.diastolic ? `${v.systolic}/${v.diastolic} mmHg` : '—')],
    ['Pulse', (v) => (v.pulse ? `${v.pulse} /min` : '—')],
    ['Height', (v) => (v.height ? formatHeightFeetInches(v.height) : '—')],
    ['Weight', (v) => q(v.weight)],
    ['Waist Circ', (v) => q(v.waistCircumference)],
    ['Head Circ', (v) => q(v.headCircumference)],
    ['BMI', (v) => v.bmi?.toFixed(1) ?? '—'],
    ['BMI Status', (v) => v.bmiStatus ?? '—'],
  ]
  return (
    <>
      <div className="overflow-x-auto rounded-2xl border border-(--accent-line) bg-surface-1 shadow-card">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Vitals by visit</caption>
          <thead className="bg-(--accent-soft) text-xs font-bold tracking-wide text-(--accent-text) uppercase">
            <tr>
              <th scope="col" className="px-3 py-2.5 font-semibold">Date</th>
              {paged.rows.map((v) => (
                <th key={v.id} scope="col" className="px-3 py-2.5 font-semibold">
                  {formatInstantShort(v.takenAt, TZ)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, fn]) => (
              <tr key={label} className="border-t border-border-soft">
                <th scope="row" className="px-3 py-2.5 font-medium text-ink">{label}</th>
                {paged.rows.map((v) => (
                  <td key={v.id} className="px-3 py-2.5 tabular-nums">{fn(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager {...paged} />
    </>
  )
}

export function HealthTrendsPage() {
  const api = usePortalApi()
  const vitals = useResource(() => api.listVitals(), [])
  const [view, setView] = useState<'charts' | 'list'>('charts')
  const toggle = (
    <div role="group" aria-label="View" className="flex rounded-lg border border-border bg-surface-1 p-0.5">
      {(
        [
          ['charts', 'Charts', BarChart3],
          ['list', 'List', List],
        ] as const
      ).map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          onClick={() => setView(id)}
          className={cn('flex min-h-10 items-center gap-1.5 rounded-md px-3 text-sm font-medium', view === id ? 'bg-primary-600 text-on-primary' : 'text-ink-muted hover:bg-surface-2')}
        >
          <Icon aria-hidden="true" size={16} /> {label}
        </button>
      ))}
    </div>
  )
  return (
    <>
      <PageHeader title="Health Trends" back={{ to: '/', label: 'Home' }} actions={toggle} />
      <AsyncPanel resource={vitals} label="your vitals">
        {(list) => {
          if (!list.length) return <EmptyState title="No vitals on file yet" />
          const sorted = [...list].sort((a, b) => a.takenAt.localeCompare(b.takenAt))
          const dates = sorted.map((v) => v.takenAt)
          if (view === 'list') return <TrendTable vitals={sorted} />
          return (
            <div className="grid gap-5 xl:grid-cols-2">
              <Card title="BMI Value">
                <LineChart title="BMI" unit="" dates={dates} series={[{ label: 'BMI', stroke: 'stroke-success-fg', values: sorted.map((v) => v.bmi) }]} />
              </Card>
              <Card title="Blood Pressure (mmHg)">
                <LineChart
                  title="Blood pressure"
                  unit="mmHg"
                  dates={dates}
                  series={[
                    { label: 'Systolic', stroke: 'stroke-primary-600', values: sorted.map((v) => v.systolic) },
                    { label: 'Diastolic', stroke: 'stroke-warning-fg', dash: '6 4', values: sorted.map((v) => v.diastolic) },
                  ]}
                />
              </Card>
              <Card title="Heart Rate Value (beats per minute)">
                <LineChart title="Heart rate" unit="beats per minute" dates={dates} series={[{ label: 'Heart rate', stroke: 'stroke-critical-fg', values: sorted.map((v) => v.pulse) }]} />
              </Card>
            </div>
          )
        }}
      </AsyncPanel>
    </>
  )
}

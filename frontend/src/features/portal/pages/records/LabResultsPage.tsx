import type { PortalLabObservation, PortalLabObservationInterpretation, PortalLabResult } from '../../../../api/generated/model'
import { Badge, type BadgeTone } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import { useResource } from '../../api/useResource'
import { useClinicTimeZone } from '../../clinicZone'
import { AsyncPanel, Card, formatInstantShort, PageHeader } from '../../ui'

/*
 * Test Results with the real API (listPortalLabResults, #398; D90, Q32): the patient's own lab
 * reports, newest first, read through the portal session (no patient ID anywhere in the address).
 * Each analyte shows its value and unit, the lab's reference range and a flag in words. A test
 * with two or more numeric values gets a graph over time with the reference range shaded and
 * out-of-range points marked by shape and in words. A report the clinician holds (D90) comes back
 * with its ID only: it is listed as not released yet, never with a value.
 */

export const HELD_TEXT = "This result isn't released yet. Your clinic will share it when it's ready."

const FLAG: Record<PortalLabObservationInterpretation, { label: string; tone: BadgeTone }> = {
  N: { label: 'Within range', tone: 'success' },
  H: { label: 'High', tone: 'warning' },
  L: { label: 'Low', tone: 'warning' },
  A: { label: 'Needs attention', tone: 'critical' },
}

/** The flag in plain words, or null when the lab gave none. */
export const flagWords = (i?: PortalLabObservationInterpretation): string | null => (i ? FLAG[i].label : null)

/** A report's name for the patient: its short name, the lab's text, or the LOINC display. */
export const reportName = (r: PortalLabResult): string => r.shortName ?? r.code?.text ?? r.code?.display ?? 'Lab test'
export const analyteName = (o: PortalLabObservation): string => o.shortName ?? o.code.text ?? o.code.display ?? 'Result'
const analyteKey = (o: PortalLabObservation): string => o.code.code ?? analyteName(o)

/** "0–20 mm/h", "Above 60", "Below 5", the lab's text, or null. */
export function rangeText(o: PortalLabObservation): string | null {
  const r = o.referenceRange
  if (!r) return null
  const unit = o.value?.unit ? ` ${o.value.unit}` : ''
  if (r.low !== undefined && r.high !== undefined) return `${r.low}–${r.high}${unit}`
  if (r.low !== undefined) return `${r.low}${unit} or more`
  if (r.high !== undefined) return `${r.high}${unit} or less`
  return r.text ?? null
}

export const valueText = (o: PortalLabObservation): string => (o.value ? `${o.value.value} ${o.value.unit}`.trim() : (o.text ?? '—'))

/** When a report was taken: collected, else issued. */
const takenAt = (r: PortalLabResult): string | undefined => r.effectiveAt ?? r.issuedAt

export interface TrendPoint {
  at: string
  value: number
  flag?: PortalLabObservationInterpretation
}

export interface Trend {
  key: string
  name: string
  unit: string
  /** The latest report's reference range, shaded on the graph. */
  low?: number
  high?: number
  points: TrendPoint[]
}

/**
 * One series per analyte with two or more numeric values, oldest first. Held reports never take
 * part; a value in another unit than the latest is left out rather than drawn on the wrong scale.
 */
export function trendsOf(results: PortalLabResult[]): Trend[] {
  const byKey = new Map<string, { name: string; rows: Array<{ at: string; o: PortalLabObservation }> }>()
  for (const r of results) {
    const at = takenAt(r)
    if (r.releaseStatus !== 'available' || !at) continue
    for (const o of r.results ?? []) {
      if (!o.value || !Number.isFinite(o.value.value)) continue
      const k = analyteKey(o)
      const entry = byKey.get(k) ?? { name: analyteName(o), rows: [] }
      entry.rows.push({ at, o })
      byKey.set(k, entry)
    }
  }
  const trends: Trend[] = []
  for (const [key, { name, rows }] of byKey) {
    rows.sort((a, b) => a.at.localeCompare(b.at))
    const last = rows.at(-1)
    if (!last) continue
    const latest = last.o
    const unit = latest.value!.unit
    const same = rows.filter((row) => row.o.value!.unit === unit)
    if (same.length < 2) continue
    trends.push({
      key,
      name,
      unit,
      ...(latest.referenceRange?.low !== undefined ? { low: latest.referenceRange.low } : {}),
      ...(latest.referenceRange?.high !== undefined ? { high: latest.referenceRange.high } : {}),
      points: same.map((row) => ({ at: row.at, value: row.o.value!.value, ...(row.o.interpretation ? { flag: row.o.interpretation } : {}) })),
    })
  }
  return trends
}

/** Out of range by the lab's flag, or else by the shaded range. */
export function outOfRange(p: TrendPoint, t: Pick<Trend, 'low' | 'high'>): 'high' | 'low' | null {
  if (p.flag === 'H') return 'high'
  if (p.flag === 'L') return 'low'
  if (p.flag === 'N') return null
  if (t.high !== undefined && p.value > t.high) return 'high'
  if (t.low !== undefined && p.value < t.low) return 'low'
  return null
}

export function LabResultsPage() {
  const api = usePortalApi()
  const results = useResource(() => api.listLabResults(), [])
  return (
    <>
      <PageHeader title="Test Results" back={{ to: '/', label: 'Home' }} />
      <AsyncPanel resource={results} label="your test results">
        {(list) =>
          list.length === 0 ? (
            <Card>
              <p className="py-6 text-center text-sm text-ink-muted">No test results on your record yet.</p>
            </Card>
          ) : (
            <div className="max-w-4xl space-y-5">
              <Trends trends={trendsOf(list)} />
              <ReportList list={list} />
              <p className="text-sm text-ink-muted">If you have questions about your test results, please contact your clinic.</p>
            </div>
          )
        }
      </AsyncPanel>
    </>
  )
}

function ReportList({ list }: { list: PortalLabResult[] }) {
  const tz = useClinicTimeZone()
  return (
    <ul aria-label="Your test results" className="divide-y divide-border-soft overflow-hidden rounded-2xl border border-(--accent-line) bg-surface-1 shadow-card">
      {list.map((r) => {
        if (r.releaseStatus === 'held')
          return (
            <li key={r.id} className="px-4 py-3.5 sm:px-5">
              <p className="text-sm text-ink-muted">{HELD_TEXT}</p>
            </li>
          )
        const at = takenAt(r)
        return (
          <li key={r.id} className="px-4 py-3.5 sm:px-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h2 className="text-base font-semibold text-ink">{reportName(r)}</h2>
              {at ? <span className="text-sm text-ink-muted">Collected {formatInstantShort(at, tz)}</span> : null}
            </div>
            {(r.results ?? []).length > 0 ? (
              <dl className="mt-2 space-y-2">
                {(r.results ?? []).map((o, i) => {
                  const range = rangeText(o)
                  const flag = o.interpretation ? FLAG[o.interpretation] : null
                  return (
                    <div key={`${analyteKey(o)}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <dt className="min-w-40 text-sm text-ink">{analyteName(o)}</dt>
                      <dd className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                        <span className="font-semibold text-ink tabular-nums">{valueText(o)}</span>
                        {range ? <span className="text-ink-muted">Range {range}</span> : null}
                        {flag ? <Badge tone={flag.tone}>{flag.label}</Badge> : null}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            ) : null}
            {r.conclusion ? <p className="mt-2 text-sm text-ink">{r.conclusion}</p> : null}
          </li>
        )
      })}
    </ul>
  )
}

function Trends({ trends }: { trends: Trend[] }) {
  if (trends.length === 0) return null
  return (
    <section aria-labelledby="lab-trends" className="space-y-3">
      <h2 id="lab-trends" className="text-lg font-semibold text-ink">
        Over time
      </h2>
      <div className="grid gap-5 xl:grid-cols-2">
        {trends.map((t) => (
          <Card key={t.key} title={`${t.name} (${t.unit})`}>
            <TrendChart trend={t} />
          </Card>
        ))}
      </div>
    </section>
  )
}

/**
 * The smallest line graph in the portal's own tokens (Health Trends draws the same way): the
 * reference range is a shaded band; a high point is an upward triangle, a low one a downward
 * triangle, each labelled in words. The values are also listed in text under the graph.
 */
function TrendChart({ trend: t }: { trend: Trend }) {
  const tz = useClinicTimeZone()
  const W = 560
  const H = 200
  const pad = { l: 44, r: 16, t: 18, b: 28 }
  const values = t.points.map((p) => p.value)
  const lo = Math.min(...values, t.low ?? Infinity)
  const hi = Math.max(...values, t.high ?? -Infinity)
  const span = hi - lo || Math.abs(hi) || 1
  const min = lo - span * 0.1
  const max = hi + span * 0.1
  const n = t.points.length
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / (n - 1)
  const y = (v: number) => pad.t + ((max - v) * (H - pad.t - pad.b)) / (max - min)
  const date = (at: string) => formatInstantShort(at, tz)
  const fmt = (v: number) => String(Math.round(v * 100) / 100)
  const latest = t.points[n - 1]
  const bandTop = y(t.high ?? max)
  const bandBottom = y(t.low ?? min)
  const words = (p: TrendPoint) => {
    const out = outOfRange(p, t)
    return out === 'high' ? 'High' : out === 'low' ? 'Low' : t.low !== undefined || t.high !== undefined ? 'Within range' : null
  }
  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={latest ? `${t.name} over ${n} results. Latest: ${fmt(latest.value)} ${t.unit} on ${date(latest.at)}${words(latest) ? `, ${words(latest)?.toLowerCase()}` : ''}.` : t.name}
      >
        {t.low !== undefined || t.high !== undefined ? <rect x={pad.l} width={W - pad.l - pad.r} y={bandTop} height={Math.max(bandBottom - bandTop, 1)} className="fill-success-bg" /> : null}
        {[min, (min + max) / 2, max].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="stroke-border-soft" strokeWidth={1} />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="fill-ink-subtle text-[11px]">
              {fmt(v)}
            </text>
          </g>
        ))}
        {t.points.map((p, i) => (
          <text key={p.at} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="fill-ink-subtle text-[11px]">
            {date(p.at)}
          </text>
        ))}
        <polyline points={t.points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} fill="none" className="stroke-primary-600" strokeWidth={2.5} strokeLinejoin="round" />
        {t.points.map((p, i) => {
          const out = outOfRange(p, t)
          const cx = x(i)
          const cy = y(p.value)
          if (!out) return <circle key={p.at} cx={cx} cy={cy} r={4} className="fill-surface-1 stroke-primary-600" strokeWidth={2} />
          const tri = out === 'high' ? `${cx},${cy - 7} ${cx - 6},${cy + 5} ${cx + 6},${cy + 5}` : `${cx},${cy + 7} ${cx - 6},${cy - 5} ${cx + 6},${cy - 5}`
          return (
            <g key={p.at}>
              <polygon points={tri} className="fill-critical-fg" />
              <text x={cx} y={out === 'high' ? cy - 10 : cy + 18} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="fill-critical-fg text-[11px] font-semibold">
                {out === 'high' ? 'High' : 'Low'}
              </text>
            </g>
          )
        })}
      </svg>
      <figcaption className="mt-2 text-xs text-ink-muted">
        {t.low !== undefined || t.high !== undefined ? <p>Shaded: the lab&rsquo;s range for the latest result.</p> : null}
        <ul aria-label={`${t.name} values`} className="mt-1 space-y-0.5">
          {[...t.points].reverse().map((p) => (
            <li key={p.at}>
              {date(p.at)}: {fmt(p.value)} {t.unit}
              {words(p) ? ` (${words(p)})` : ''}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  )
}

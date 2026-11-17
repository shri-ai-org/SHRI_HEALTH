/**
 * SHRI_HEALTH: "At a glance" — the first card on the record overview (S-06-11) with the API (item 4
 * of the demo plan, #85). Six rows, each from a read the record already uses (logic/glance.ts),
 * read together under one skeleton: the active problems, the current medications, the allergies,
 * the latest vitals, the latest abnormal lab results and the last visit. A row whose read fails
 * says so and retries alone; the others stay. A restricted chart goes to the route's sealed card.
 * Each row's title opens its tab, where the record has one (Condition, Prescriptions, Test results,
 * Appointments); allergies and vitals have no tab of their own. Every time is the clinic's (D40).
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import type { Patient } from '@/data/kit'

import { formatClinicDateTime, formatDate } from '../../../shri-health/format'
import { cn } from '../lib/cn'
import { GLANCE_KEYS, isRestricted, loadGlance, loadRow, type Glance, type GlanceKey, type Listed } from '../logic/glance'
import { recordPath, type RecordSection } from '../logic/record'
import { Card, Skeleton } from '../ui/primitives'

const TITLE: Record<GlanceKey, string> = {
  problems: 'Active problems',
  medications: 'Current medications',
  allergies: 'Allergies',
  vitals: 'Latest vitals',
  labs: 'Latest abnormal results',
  lastVisit: 'Last visit',
}
/** The tab each row opens; allergies and vitals have none. */
const TAB: Partial<Record<GlanceKey, RecordSection>> = { problems: 'condition', medications: 'prescriptions', labs: 'results', lastVisit: 'appointments' }

const NONE = 'None recorded'

export function GlanceCard({ patient: p }: { patient: Patient }) {
  const [glance, setGlance] = useState<Glance | null>(null)
  const [restricted, setRestricted] = useState<unknown>(null)
  const [retrying, setRetrying] = useState<Partial<Record<GlanceKey, boolean>>>({})

  useEffect(() => {
    let live = true
    setGlance(null)
    loadGlance(p.id).then(
      (g) => live && setGlance(g),
      (e: unknown) => live && setRestricted(e),
    )
    return () => {
      live = false
    }
  }, [p.id])

  // A restricted chart: the route's sealed card, never part of the chart.
  if (restricted) throw restricted

  function retry(key: GlanceKey) {
    setRetrying((r) => ({ ...r, [key]: true }))
    loadRow(key, p.id).then(
      (data) => setGlance((g) => g && { ...g, [key]: { status: 'ok', data } }),
      (e: unknown) => (isRestricted(e) ? setRestricted(e) : setGlance((g) => g && { ...g, [key]: { status: 'error' } })),
    ).finally(() => setRetrying((r) => ({ ...r, [key]: false })))
  }

  return (
    <Card titleSize="sm" title="At a glance" aria-label="At a glance" aria-busy={glance === null}>
      <dl className="grid grid-cols-1 gap-x-[20px] md:grid-cols-2 xl:grid-cols-3">
        {GLANCE_KEYS.map((key) => (
          <div key={key} className="min-w-0 border-t border-sh-line py-[12px]">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">
              {TAB[key] ? (
                <Link to={recordPath(p, TAB[key]!)} className="rounded-[4px] underline decoration-sh-line-strong underline-offset-[3px] hover:text-sh-text hover:decoration-current">
                  {TITLE[key]}
                </Link>
              ) : (
                TITLE[key]
              )}
            </dt>
            <dd className="mt-[6px] text-[13px]/[1.45] text-sh-text">
              {glance === null ? (
                <span className="flex flex-col gap-[6px]">
                  <Skeleton className="h-[14px] w-4/5" />
                  <Skeleton className="h-[14px] w-3/5" />
                </span>
              ) : glance[key].status === 'error' ? (
                <span className="flex flex-wrap items-center gap-x-[8px] text-sh-text-2">
                  Couldn't load.
                  <button
                    type="button"
                    disabled={retrying[key]}
                    onClick={() => retry(key)}
                    className="inline-flex min-h-[28px] items-center rounded-[6px] px-[2px] font-medium text-sh-text underline decoration-sh-line-strong underline-offset-[3px] hover:decoration-current disabled:opacity-60"
                  >
                    Try again
                  </button>
                </span>
              ) : (
                <RowValue glance={glance} k={key} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-sh-text-3">{children}</span>
}

function ListedLines<T>({ list, line }: { list: Listed<T>; line: (item: T) => ReactNode }) {
  if (list.items.length === 0) return <Muted>{NONE}</Muted>
  return (
    <ul className="flex flex-col gap-[2px]">
      {list.items.map((item, i) => (
        <li key={i} className="line-clamp-2">
          {line(item)}
        </li>
      ))}
      {list.more > 0 && <li className="text-sh-text-3">and {list.more} more</li>}
    </ul>
  )
}

function RowValue({ glance, k }: { glance: Glance; k: GlanceKey }) {
  const row = glance[k]
  if (row.status !== 'ok') return null
  switch (k) {
    case 'problems': {
      const d = glance.problems.status === 'ok' ? glance.problems.data : null
      return d && <ListedLines list={d} line={(name) => name} />
    }
    case 'medications': {
      const d = glance.medications.status === 'ok' ? glance.medications.data : null
      return (
        d && (
          <ListedLines
            list={d}
            line={(m) => (
              <>
                <span className="font-medium">{m.name}</span>
                {m.directions && <span className="text-sh-text-2"> · {m.directions}</span>}
              </>
            )}
          />
        )
      )
    }
    case 'allergies': {
      const d = glance.allergies.status === 'ok' ? glance.allergies.data : null
      if (!d) return null
      if (d.kind === 'none-known') return <span>No known allergies</span>
      if (d.kind === 'not-recorded') return <Muted>Not recorded</Muted>
      return (
        <ul className="flex flex-col gap-[2px]">
          {d.items.map((a, i) => (
            <li key={i} className="truncate">
              <span className="font-medium">{a.substance}</span>
              {a.reaction && <span className="text-sh-text-2"> · {a.reaction}</span>}
            </li>
          ))}
        </ul>
      )
    }
    case 'vitals': {
      const d = glance.vitals.status === 'ok' ? glance.vitals.data : null
      if (!d) return <Muted>{NONE}</Muted>
      return (
        <>
          <p className="flex flex-wrap gap-x-[12px] gap-y-[2px] tabular-nums">
            {d.readings.map((r) => (
              <span key={r.label}>
                <span className="text-sh-text-3">{r.label}</span> {r.value}
              </span>
            ))}
          </p>
          <p className="mt-[2px] text-[12px] text-sh-text-3">{formatClinicDateTime(d.at)}</p>
        </>
      )
    }
    case 'labs': {
      const d = glance.labs.status === 'ok' ? glance.labs.data : null
      if (!d) return null
      if (d.length === 0) return <Muted>{NONE}</Muted>
      return (
        <ul className="flex flex-col gap-[2px]">
          {d.map((l, i) => (
            <li key={i} className="truncate tabular-nums">
              <span className="font-medium">{l.test}</span> {l.value}
              {l.unit && ` ${l.unit}`} · <span className={cn('font-semibold', l.flag.startsWith('Critical') ? 'text-sh-crit-fg' : 'text-sh-warn-fg')}>{l.flag}</span>
              <span className="text-sh-text-3"> · {formatDate(l.at)}</span>
            </li>
          ))}
        </ul>
      )
    }
    case 'lastVisit': {
      const d = glance.lastVisit.status === 'ok' ? glance.lastVisit.data : null
      if (!d) return <Muted>{NONE}</Muted>
      return (
        <>
          <p>
            <span className="font-medium">{formatDate(d.at)}</span>
            {d.type && <span className="text-sh-text-2"> · {d.type}</span>}
          </p>
          {d.clinician && <p className="text-[12px] text-sh-text-3">{d.clinician}</p>}
        </>
      )
    }
  }
}

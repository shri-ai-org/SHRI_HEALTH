/**
 * §5.5 — OPD / Inpatients tabs over the old build's lists (`opdList`,
 * `inpatientList`, in their own order: whoever the hospital is acting on
 * first), the KPI filter chip, and rows that open the record. The stroke
 * network's personas get the telestroke queue instead. The list scrolls on its
 * own and fades at the bottom while there is more.
 */

import { Ambulance, BedDouble, Check, ChevronRight, HeartPulse, RefreshCw, RotateCw, UserRound, Video, X, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { ageSex } from '@/data/format'
import type { PatientListRow, RowMark } from '@/data/myday'

import { P } from '../app/paths'
import { cn } from '../lib/cn'
import type { PatientFilter, Place, Tone } from '../mocks/types'
import { forceState } from '../state/ai'
import { useShri } from '../state/store'
import { iconFor } from '../ui/icons'
import { Card, CountBubble, Icon, Pill, StatusPill } from '../ui/primitives'

import { rowPatient, useMyDay } from './useMyDay'

const PLACE_KEY: Record<string, Place> = { OPD: 'opd', Teleconsult: 'tele', Telestroke: 'tele', Ward: 'ward', ICU: 'icu', ED: 'ed' }
const PLACE_ICON: Record<Place, LucideIcon> = { opd: UserRound, tele: Video, ward: BedDouble, icu: HeartPulse, ed: Ambulance }
const MARK_TONE: Record<RowMark['tone'], Tone> = { critical: 'crit', attention: 'warn', normal: 'norm', neutral: 'neu' }

const FILTER_WORD: Record<PatientFilter, string> = { waiting: 'Waiting', inroom: 'In room', admissions: 'Admitted today', icu: 'ICU' }

/** A KPI card's filter, applied to the tab it belongs to. */
function filtered(rows: PatientListRow[], filter: PatientFilter | null): PatientListRow[] {
  if (!filter) return rows
  if (filter === 'icu') return rows.filter((r) => r.place.label === 'ICU')
  return rows.filter((r) => r.status?.label === FILTER_WORD[filter])
}

export function PatientsToday({ className }: { className?: string }) {
  const d = useMyDay()
  const patientTab = useShri((st) => st.patientTab)
  const setPatientTab = useShri((st) => st.setPatientTab)
  const patientFilter = useShri((st) => st.patientFilter)
  const clearFilter = useShri((st) => st.clearFilter)
  const partial = d.forced === 'PARTIAL'

  const rows = d.stroke ? d.telestroke : filtered(patientTab === 'opd' ? d.opd : d.inpatients, patientFilter)
  const regionDown = partial && (d.stroke || patientTab === 'ip')

  /* Bottom fade only while there is more below the fold. */
  const listRef = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  const measure = useCallback(() => {
    const el = listRef.current
    if (!el) return
    setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 2)
  }, [])
  useEffect(() => {
    measure()
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure, rows.length, patientTab])

  let empty: ReactNode = null
  if (regionDown) {
    // PARTIAL: one region is down; the rest of the screen stays current and usable.
    empty = (
      <>
        <p className="font-medium text-sh-text">{d.stroke ? 'Telestroke queue' : 'Bed state'} is unavailable</p>
        <p className="mt-[4px] max-w-[320px]">Last reached 08:12. Everything else on this screen is current and usable.</p>
        <Pill variant="control" size="md" icon={RefreshCw} className="mt-[10px]" onClick={() => forceState(null)}>
          Retry
        </Pill>
      </>
    )
  } else if (rows.length === 0) {
    empty = patientFilter ? (
      <>
        <p>No patients match this filter.</p>
        <Pill variant="control" size="sm" className="mt-[10px]" onClick={clearFilter}>
          Clear filter
        </Pill>
      </>
    ) : d.stroke ? (
      <p>No spoke is waiting on a telestroke consult.</p>
    ) : patientTab === 'opd' ? (
      <p>No one is booked into OPD today.</p>
    ) : (
      <p>No inpatients are assigned to you. An admission under your name would put them here.</p>
    )
  }

  return (
    <Card
      className={className}
      title="Patients Today"
      headerClassName="flex-wrap gap-y-[8px]"
      right={
        d.stroke ? undefined : (
          <>
            {patientFilter && (
              <button
                type="button"
                onClick={clearFilter}
                aria-label={`Clear the ${FILTER_WORD[patientFilter]} filter`}
                title="Clear filter"
                className="inline-flex h-[32px] shrink-0 items-center gap-[5px] rounded-full bg-sh-accent-soft pl-[9px] pr-[7px] text-[12px] font-medium text-sh-text transition-colors duration-150 hover:bg-sh-hover-strong"
              >
                <Icon icon={Check} size={13} strokeWidth={2.4} />
                {FILTER_WORD[patientFilter]}
                <Icon icon={X} size={13} strokeWidth={2.2} className="text-sh-text-3" />
              </button>
            )}
            <div role="tablist" aria-label="Patients Today" className="flex items-center gap-[4px]">
              <Tab active={patientTab === 'opd'} icon={UserRound} label="OPD" count={d.opd.length} onClick={() => setPatientTab('opd')} />
              <Tab active={patientTab === 'ip'} icon={BedDouble} label="Inpatients" count={d.inpatients.length} onClick={() => setPatientTab('ip')} />
            </div>
          </>
        )
      }
    >
      {d.stroke && (
        <p className="mb-[8px] flex items-center gap-[8px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">
          Telestroke queue <CountBubble>{d.telestroke.length}</CountBubble>
        </p>
      )}
      <div
        ref={listRef}
        onScroll={measure}
        role={d.stroke ? undefined : 'tabpanel'}
        aria-label={d.stroke ? 'Telestroke requests from the spokes' : patientTab === 'opd' ? "Today's OPD patients" : 'Inpatients under you'}
        className={cn(
          // A 6px gutter whose thumb shows on hover; Firefox (no ::-webkit-scrollbar) gets its thin bar instead.
          '-mx-[6px] min-h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-[6px] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent [&:hover::-webkit-scrollbar-thumb]:bg-sh-line-strong supports-[not_selector(::-webkit-scrollbar)]:[scrollbar-width:thin]',
          more && 'sh-fade-bottom',
        )}
      >
        {empty ? (
          <div className="flex h-full min-h-[120px] flex-col items-center justify-center text-center text-[14px] text-sh-text-2">{empty}</div>
        ) : (
          <ul className="flex flex-col gap-[2px] pb-[6px]">
            {rows.map((r) => (
              <li key={r.patientId}>
                <PatientRowItem row={r} showKind={!d.stroke && patientTab === 'opd'} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

function Tab({ active, icon, label, count, onClick }: { active: boolean; icon: LucideIcon; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-[40px] shrink-0 items-center gap-[5px] rounded-full pl-[11px] pr-[7px] text-[13px] font-semibold uppercase tracking-[0.03em] transition-colors duration-150',
        active ? 'bg-sh-primary text-sh-on-primary' : 'bg-sh-control text-sh-text hover:bg-sh-hover-strong',
      )}
    >
      <Icon icon={icon} size={15} strokeWidth={2} />
      {label}
      <CountBubble active={active}>{count}</CountBubble>
    </button>
  )
}

function PatientRowItem({ row, showKind }: { row: PatientListRow; showKind: boolean }) {
  const p = rowPatient(row)
  const place = PLACE_KEY[row.place.label] ?? 'opd'
  const critical = row.status?.tone === 'critical'
  const followUp = row.kind?.label === 'Follow-up'
  return (
    <Link
      to={P.record(p.uhid)}
      className={cn(
        'grid items-center gap-[12px] rounded-[14px] px-[6px] py-[7px] text-sh-text transition-colors duration-150 hover:bg-sh-hover',
        // The status column is sized to the widest pill ("Admission in progress" wraps to its icon and word).
        showKind ? 'grid-cols-[44px_minmax(0,1fr)_40px_minmax(0,150px)_16px]' : 'grid-cols-[44px_minmax(0,1fr)_minmax(0,150px)_16px]',
        row.done && 'opacity-55',
      )}
    >
      <span
        className="sh-place relative inline-flex size-[42px] items-center justify-center rounded-[14px] bg-(--p-bg) text-(--p-fg)"
        data-place={place}
        title={row.place.label}
        aria-label={row.place.label}
        role="img"
      >
        <Icon icon={PLACE_ICON[place]} size={20} />
        {critical && <span className="absolute -right-[3px] -top-[3px] size-[14px] rounded-full border-2 border-sh-card bg-sh-crit" aria-hidden="true" />}
      </span>

      <span className="min-w-0">
        <span className="block truncate text-[14px]/[18px] font-medium">{p.name}</span>
        <span className="block truncate text-[12px]/[16px] tabular-nums text-sh-text-3">
          {ageSex(p.age, p.sex)} · {row.detail ?? p.uhid}
        </span>
      </span>

      {showKind && (
        <span className="flex justify-center">
          {row.kind &&
            (followUp ? (
              <span className="inline-flex size-[30px] items-center justify-center rounded-full bg-sh-control text-sh-text" title="Follow-up" aria-label="Follow-up" role="img">
                <Icon icon={RotateCw} size={14} strokeWidth={2} />
              </span>
            ) : (
              <span className="inline-flex h-[24px] items-center rounded-full bg-sh-primary px-[8px] text-[11px] font-semibold text-sh-on-primary" title={row.kind.label}>
                New
              </span>
            ))}
        </span>
      )}

      <span className="min-w-0">
        {row.status && (
          <StatusPill icon={iconFor(row.status.icon)} word={row.status.label} tone={MARK_TONE[row.status.tone]} className="max-w-full gap-[6px] px-[9px]" />
        )}
      </span>

      <Icon icon={ChevronRight} size={16} className="text-sh-chev" />
    </Link>
  )
}

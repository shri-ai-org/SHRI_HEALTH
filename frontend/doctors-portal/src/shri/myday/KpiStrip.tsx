/**
 * §5.2 — six stat cards in one row. Every card is a filter on Patients Today
 * or a shortcut into the Quick-Panel; colours come from `.sh-kpi[data-kpi]`.
 * 1024–1279px wraps them 3 × 2; under 768px they stay one row that scrolls
 * sideways and snaps card by card, running to the screen edges, with a fade on
 * whichever edge still hides a card.
 *
 * The strip is this build's own; every number on it is a real count from the
 * old build's lists (`opdList`, `inpatientList`, the attention ranking and the
 * unacknowledged critical results). The stroke network's day has no clinic
 * lists, so for those personas there is no strip.
 */

import { motion } from 'framer-motion'
import { BedDouble, Check, Clock, HeartPulse, OctagonAlert, Stethoscope, Users, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { patient } from '@/data/kit'

import { cn } from '../lib/cn'
import { EASE } from '../lib/motion'
import type { KpiId, PatientFilter, PatientTab } from '../mocks/types'
import { useShri } from '../state/store'
import { Icon } from '../ui/primitives'

import { useMyDay, type MyDay } from './useMyDay'

const ACTION: Record<Exclude<KpiId, 'critical'>, { tab: PatientTab; filter: PatientFilter | null }> = {
  today: { tab: 'opd', filter: null },
  waiting: { tab: 'opd', filter: 'waiting' },
  inroom: { tab: 'opd', filter: 'inroom' },
  admissions: { tab: 'ip', filter: 'admissions' },
  icu: { tab: 'ip', filter: 'icu' },
}

const HINT: Record<KpiId, string> = {
  today: 'Show everyone booked today',
  waiting: 'Show who is waiting',
  inroom: 'Show who is in the room',
  admissions: "Show today's admissions",
  icu: 'Show ICU patients',
  critical: 'Open the critical result',
}

interface KpiValue {
  id: KpiId
  label: string
  icon: LucideIcon
  value: number
  sub: string
}

const surname = (id: string) => patient(id).name.split(' ').slice(-1)[0]

function kpis(d: MyDay): KpiValue[] {
  const status = (r: { status?: { label: string } }) => r.status?.label
  const waiting = d.opd.filter((r) => status(r) === 'Waiting')
  const inroom = d.opd.filter((r) => status(r) === 'In room')
  const admitting = d.opd.filter((r) => status(r) === 'Admission in progress')
  const admittedToday = d.inpatients.filter((r) => status(r) === 'Admitted today')
  const icu = d.inpatients.filter((r) => r.place.label === 'ICU')
  // The count Today's morning brief gives as "N critical": results no one has acknowledged yet.
  const top = d.criticalResults[0]
  return [
    { id: 'today', label: 'Patients Today', icon: Users, value: d.opd.length, sub: `${d.opd.filter((r) => r.kind?.label === 'New patient').length} new` },
    { id: 'waiting', label: 'Waiting', icon: Clock, value: waiting.length, sub: waiting[0] ? `${surname(waiting[0].patientId)} next` : 'No one waiting' },
    { id: 'inroom', label: 'In Room', icon: Stethoscope, value: inroom.length, sub: inroom[0] ? surname(inroom[0].patientId) : 'Room free' },
    { id: 'admissions', label: 'Admissions', icon: BedDouble, value: admitting.length + admittedToday.length, sub: `${admitting.length} in progress` },
    { id: 'icu', label: 'ICU', icon: HeartPulse, value: icu.length, sub: icu.length > 0 ? icu.map((r) => r.detail).filter(Boolean).join(' · ') : 'No ICU patients' },
    {
      id: 'critical',
      label: 'Critical',
      icon: OctagonAlert,
      value: d.criticalResults.length,
      sub: top ? `${top.test} ${top.value}${top.unit ? ` ${top.unit}` : ''} · ${surname(top.patientId)}` : 'None unacknowledged',
    },
  ]
}

export function KpiStrip() {
  const d = useMyDay()
  const patientTab = useShri((st) => st.patientTab)
  const patientFilter = useShri((st) => st.patientFilter)
  const applyKpiFilter = useShri((st) => st.applyKpiFilter)
  const openQuickPanel = useShri((st) => st.openQuickPanel)
  const cards = kpis(d)
  const row = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  // Which edges still hide a card — only ever true while the row scrolls (under 768px).
  const measure = useCallback(() => {
    const el = row.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }))
  }, [])
  useEffect(() => {
    const el = row.current
    if (!el) return
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  function onClick(k: KpiValue) {
    if (k.id === 'critical') {
      // The Quick-Panel on the top result's own attention item — still there after its patient is marked seen.
      const top = d.criticalResults[0]
      const item = top && d.attention.find((i) => i.urgency === 'critical' && i.patientId === top.patientId)
      if (item) openQuickPanel(item)
      else applyKpiFilter('ip', null)
      return
    }
    const a = ACTION[k.id]
    applyKpiFilter(a.tab, a.filter)
  }

  if (d.stroke) return null

  return (
    <div
      ref={row}
      onScroll={measure}
      className={cn(
        'mb-[2px] mt-[14px] grid h-[74px] grid-cols-6 gap-[12px] max-lg:h-auto max-lg:grid-cols-3',
        'sh-scroll-none max-sm:flex max-sm:snap-x max-sm:snap-mandatory max-sm:overflow-x-auto max-sm:py-[2px]',
        'max-sm:-ml-[max(16px,var(--sa-l))] max-sm:-mr-[max(16px,var(--sa-r))] max-sm:px-[max(16px,var(--sa-l))] max-sm:scroll-px-[max(16px,var(--sa-l))]',
        // Only a scrolling row has hidden edges, so these only ever apply under 768px.
        edges.left && edges.right ? 'sh-fade-x' : edges.right ? 'sh-fade-right' : edges.left ? 'sh-fade-left' : undefined,
      )}
      role="group"
      aria-label="Today at a glance"
    >
      {cards.map((k) => {
        const a = k.id === 'critical' ? null : ACTION[k.id]
        const isFilter = Boolean(a?.filter)
        const active = isFilter && a !== null && patientTab === a.tab && patientFilter === a.filter
        const zero = k.value === 0
        const pulse = k.id === 'critical' && k.value > 0
        return (
          <motion.button
            key={k.id}
            type="button"
            data-kpi={k.id}
            aria-pressed={isFilter ? active : undefined}
            title={HINT[k.id]}
            whileHover={{ y: -2 }}
            transition={{ duration: 0.2, ease: EASE }}
            onClick={() => onClick(k)}
            className={cn(
              'sh-kpi relative flex h-[74px] items-center gap-[12px] rounded-sh-kpi border border-(--k-border) bg-(--k-bg) px-[16px] py-[12px] text-left hover:shadow-sh-pop',
              'max-sm:w-[min(52vw,212px)] max-sm:shrink-0 max-sm:snap-start',
              active && 'inset-ring-2 inset-ring-(--k-badge)',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex size-[44px] shrink-0 items-center justify-center rounded-[14px]',
                zero ? 'bg-sh-control text-sh-muted' : 'bg-(--k-badge) text-(--k-icon)',
                pulse && 'sh-badge-pulse',
              )}
              style={zero ? undefined : { boxShadow: '0 6px 14px color-mix(in srgb, var(--k-badge) 35%, transparent)' }}
            >
              <Icon icon={k.icon} size={22} strokeWidth={2} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('block text-[26px]/[26px] font-semibold tabular-nums', zero ? 'text-sh-muted' : 'text-(--k-num)')}>{k.value}</span>
              <span className="mt-[1px] block truncate text-[13px]/[14px] font-medium text-(--kpi-label)">{k.label}</span>
              <span className="block truncate text-[11px]/[12px] text-(--kpi-sub)">{k.sub}</span>
            </span>
            {active && (
              <span aria-hidden="true" className="absolute right-[8px] top-[8px] inline-flex size-[18px] items-center justify-center rounded-full bg-(--k-badge) text-(--k-icon)">
                <Icon icon={Check} size={12} strokeWidth={3} />
              </span>
            )}
          </motion.button>
        )
      })}
    </div>
  )
}

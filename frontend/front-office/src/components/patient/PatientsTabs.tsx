import { REAL_API } from '../../../shri-health/client'
import { useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { loadAppointments } from '../../../shri-health/scheduling'
import { todayKey } from '../../domain/time'
import type { LucideIcon } from 'lucide-react'
import { BedDouble, CalendarClock, Users } from 'lucide-react'
import { useStoreValue } from '../../hooks/useStore'
import { useNow } from '../../hooks/useNow'
import { getPatientRows } from '../../domain/patientSelectors'
import { getOutpatients } from '../../domain/outpatientSelectors'
import { getInpatientRows } from '../../domain/admissionSelectors'
import { cn } from '../../utils/cn'

/**
 * The three views of the one Patients place: everyone registered, today's
 * outpatients (bookings and the queue) and the inpatients (beds,
 * admissions, discharges). Each tab carries its live count.
 */
export function PatientsTabs() {
  const now = useNow(60000)
  const all = useStoreValue(getPatientRows).length
  const outpatients = useStoreValue(getOutpatients, now, 'today', false, '').counts.today
  // SHRI_HEALTH: today's bookings on every Patients tab, as the Dashboard and Outpatients read them,
  // so the counts are right on a fresh open (the tabs counted only what another page had loaded).
  const today = todayKey(new Date(now))
  useEffect(() => {
    if (REAL_API) void loadAppointments(today, 1).catch(() => undefined)
  }, [today])
  const inpatients = useStoreValue(getInpatientRows, now).length

  const tabs: { to: string; label: string; icon: LucideIcon; count: number; end?: boolean; title: string }[] = [
    // SHRI_HEALTH: there is no all-patients list (D65); the tab holds the patients this session has
    // read (today's bookings, searches, registrations), and Inpatients is India's (2026-11-05).
    REAL_API
      ? { to: '/patients', label: 'This session', icon: Users, count: all, end: true, title: 'Patients opened, searched or booked in this session (no all-patients list, D65)' }
      : { to: '/patients', label: 'All patients', icon: Users, count: all, end: true, title: 'Every registered patient' },
    { to: '/patients/outpatients', label: 'Outpatients', icon: CalendarClock, count: outpatients, title: 'Booked for today' },
    ...(REAL_API ? [] : [{ to: '/patients/inpatients', label: 'Inpatients', icon: BedDouble, count: inpatients, title: 'Admitted now' }]),
  ]

  return (
    <nav aria-label="Patients" className="scrollbar-hide flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border-soft">
      {tabs.map(({ to, label, icon: Icon, count, end, title }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          title={title}
          className={({ isActive }) =>
            cn(
              'focus-ring -mb-px inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-lg border-b-2 px-3 text-sm font-medium transition-colors',
              isActive ? 'border-primary-600 text-primary-text' : 'border-transparent text-ink-subtle hover:text-ink',
            )
          }
        >
          {({ isActive }) => (
            <>
              <Icon size={16} className="shrink-0" strokeWidth={isActive ? 2.2 : 1.8} aria-hidden="true" />
              {label}
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums',
                  isActive
                    ? 'bg-[image:var(--gradient-primary)] text-on-primary shadow-card-sm'
                    : 'bg-[color-mix(in_oklab,var(--color-hue-blue)_12%,var(--color-surface-1))] text-[color-mix(in_oklab,var(--color-hue-blue)_var(--tone-ink-amount),var(--tone-ink-mix))]',
                )}
              >
                {count}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

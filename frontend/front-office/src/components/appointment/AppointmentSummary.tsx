import type { ReactNode } from 'react'
import { Building2, Clock, MapPin, Phone, Video } from 'lucide-react'
import { Avatar } from '../ui/Avatar'
import { formatRupees } from '../../utils/billing'
import { formatDateKey, relativeDayLabel } from '../../utils/dates'
import { initialsOf } from '../../utils/format'
import { dayStartTimestamp, formatTime, slotLabel, slotToTimestamp } from '../../domain/time'
import type { Patient } from '../../types/patient'
import type { Provider } from '../../types/doctor'
import type { ConsultMode } from '../../types/appointment'
import type { PaymentItem } from '../../types/payment'

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * An appointment, read back in full before it is booked: when (date, time
 * range, length, place), who (patient, doctor), the visit, and the bill line by
 * line.
 */
export function AppointmentSummary({
  patient,
  provider,
  date,
  slot,
  mode,
  reason,
  items,
  today,
}: {
  patient: Patient
  provider: Provider
  date: string
  slot: string
  mode: ConsultMode
  reason?: string | null
  items: PaymentItem[]
  today: string
}) {
  const total = items.reduce((sum, item) => sum + item.amount, 0)

  return (
    <div className="flex flex-col gap-3.5">
      <AppointmentWhen provider={provider} date={date} slot={slot} mode={mode} today={today} />
      <AppointmentPeople patient={patient} provider={provider} />

      {/* The reason, when given, and the bill. */}
      {reason ? (
        <p className="rounded-xl border border-border-soft px-3.5 py-2.5 text-sm">
          <span className="text-ink-muted">Reason · </span>
          <span className="break-words text-ink">{reason}</span>
        </p>
      ) : null}
      <div className="rounded-xl border border-border-soft px-3.5 py-3 text-sm">
        <ul className="flex flex-col gap-1">
          {items.map((item, index) => (
            <li key={`${item.description}-${index}`} className="flex justify-between gap-3 text-ink-muted">
              <span className="min-w-0">{item.description}</span>
              <span className="tabular-nums text-ink">{formatRupees(item.amount)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 flex justify-between gap-3 border-t border-border-soft pt-2 font-semibold text-ink">
          <span>Total</span>
          <span className="tabular-nums">{formatRupees(total)}</span>
        </p>
      </div>

    </div>
  )
}

/** When — a calendar tile, the date, the time range, its length and place.
 *  Shared by the review before booking and the confirmation after it. */
export function AppointmentWhen({
  provider,
  date,
  slot,
  mode,
  today,
}: {
  provider: Provider
  date: string
  slot: string
  mode: ConsultMode
  today: string
}) {
  const day = new Date(dayStartTimestamp(date))
  const minutes = provider.schedule.slotMinutes
  const end = slotLabel(slotToTimestamp(date, slot) + minutes * 60000)
  const relative = relativeDayLabel(date, today)
  const teleconsult = mode === 'Teleconsult'
  return (
    <div className="flex items-stretch gap-3.5 rounded-xl border border-primary-200/70 bg-primary-50/60 p-3 dark:border-primary-500/25 dark:bg-primary-500/10">
      <div className="flex w-14 shrink-0 flex-col overflow-hidden rounded-lg border border-primary-200/80 bg-surface-1 text-center shadow-card-sm dark:border-primary-500/30">
        <span className="bg-[image:var(--gradient-primary)] py-0.5 text-2xs font-bold uppercase tracking-wider text-on-primary">{MONTH[day.getMonth()]}</span>
        <span className="flex flex-1 items-center justify-center text-xl font-bold tabular-nums text-ink">{day.getDate()}</span>
      </div>
      <div className="min-w-0 self-center">
        <p className="text-xs font-medium text-ink-muted">
          {relative === 'Today' || relative === 'Tomorrow' ? `${relative} · ` : ''}
          {formatDateKey(date)}
        </p>
        <p className="text-lg font-bold tracking-tight text-ink">
          <span className="whitespace-nowrap">{formatTime(slot)}</span> <span className="font-medium text-ink-subtle">–</span>{' '}
          <span className="whitespace-nowrap">{formatTime(end)}</span>
        </p>
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-ink-muted">
          <span className="inline-flex items-center gap-1">
            <Clock size={12} aria-hidden="true" />
            {minutes} min
          </span>
          <span className="inline-flex items-center gap-1">
            {teleconsult ? <Video size={12} aria-hidden="true" /> : <Building2 size={12} aria-hidden="true" />}
            {teleconsult ? 'Teleconsult' : 'In person'}
          </span>
          {!teleconsult && provider.room ? (
            <span className="inline-flex items-center gap-1">
              <MapPin size={12} aria-hidden="true" />
              {provider.room}
            </span>
          ) : null}
        </p>
      </div>
    </div>
  )
}

/** Who — the patient and the doctor, side by side. */
export function AppointmentPeople({ patient, provider }: { patient: Patient; provider: Provider }) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <Person label="Patient" name={patient.name}>
        <span className="block truncate tabular-nums">{patient.uhid}</span>
        <span className="block">{patient.age ? `${patient.age} ${patient.sex.charAt(0)}` : patient.sex}</span>
        {patient.mobile ? (
          <span className="mt-0.5 hidden items-center gap-1 tabular-nums sm:flex">
            <Phone size={11} aria-hidden="true" />
            {patient.mobile}
          </span>
        ) : null}
      </Person>
      <Person label="Doctor" name={provider.name}>
        <span className="line-clamp-2">{provider.specialty}</span>
        <span className="mt-0.5 block truncate">{provider.department}</span>
      </Person>
    </div>
  )
}

function Person({ label, name, children }: { label: string; name: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 rounded-xl border border-border-soft px-3 py-2.5">
      <Avatar name={name} initials={initialsOf(name)} size="sm" className="max-[399px]:hidden" />
      <div className="min-w-0">
        <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-subtle">{label}</p>
        <p className="truncate text-sm font-semibold text-ink" title={name}>
          {name}
        </p>
        <div className="text-xs text-ink-muted">{children}</div>
      </div>
    </div>
  )
}

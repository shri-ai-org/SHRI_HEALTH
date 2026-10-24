import { useId } from 'react'
import { formatTime } from '../format/datetime'

/** Appointment status (FHIR codes, contract `AppointmentStatus`). */
export type AppointmentStatus = 'booked' | 'arrived' | 'checked-in' | 'fulfilled' | 'cancelled' | 'noshow'
/** Visit step on the status board (contract `VisitStatus`). */
export type VisitStatus = 'arrived' | 'checked-in' | 'roomed' | 'with-provider' | 'checked-out'

const VISIT_LABEL: Record<VisitStatus, string> = {
  arrived: 'Arrived',
  'checked-in': 'Checked in',
  roomed: 'In exam room',
  'with-provider': 'With provider',
  'checked-out': 'Checked out',
}

const APPOINTMENT_LABEL: Record<AppointmentStatus, string> = {
  booked: 'Scheduled',
  arrived: 'Arrived',
  'checked-in': 'Checked in',
  fulfilled: 'Completed',
  cancelled: 'Canceled',
  noshow: 'No-show',
}

/** Visit step if there is one, else the appointment status; unknown values are shown as sent. */
export function statusLabel(status: string, visitStatus?: string): string {
  if (visitStatus && visitStatus in VISIT_LABEL) return VISIT_LABEL[visitStatus as VisitStatus]
  if (status in APPOINTMENT_LABEL) return APPOINTMENT_LABEL[status as AppointmentStatus]
  return visitStatus ?? status
}

/**
 * One row of the shared board (`GET /status-board?view=shared`). This type has no name, birth date,
 * provider or room on purpose: a waiting-room screen shows initials, time and status only
 * (SECURITY_MODEL §8 rule 11, D47).
 */
export interface SharedBoardItem {
  appointmentId: string
  initials: string
  startAt: string
  status: string
  visitStatus?: string
}

const INITIALS = /^[A-Z]{1,4}$/

/** Shows initials only if they look like initials; anything else (e.g. a full name by mistake) is hidden. */
export function safeInitials(value: string): string {
  const v = value.trim().toUpperCase().replace(/\./g, '')
  return INITIALS.test(v) ? v : '—'
}

export interface SharedStatusBoardProps {
  items: SharedBoardItem[]
  /** Facility time zone from the response (`timeZone`). */
  timeZone: string
  heading?: string
}

/** Waiting-room or hallway display: large type, initials plus appointment time and status. */
export function SharedStatusBoard({ items, timeZone, heading = "Today's patients" }: SharedStatusBoardProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-border-soft bg-surface-1 p-6">
      <h2 id={headingId} className="text-2xl font-semibold text-ink">
        {heading}
      </h2>
      {items.length === 0 ? (
        <p className="mt-6 text-xl text-ink-muted">No appointments to show.</p>
      ) : (
        <table className="mt-4 w-full border-collapse text-left">
          <caption className="sr-only">Patients by initials, appointment time and status</caption>
          <thead>
            <tr className="border-b border-border-soft text-sm text-ink-muted">
              <th scope="col" className="py-2 font-semibold">Patient</th>
              <th scope="col" className="py-2 font-semibold">Time</th>
              <th scope="col" className="py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.appointmentId} className="border-b border-border-soft text-2xl last:border-0">
                <td className="py-3 font-bold tracking-widest text-ink">{safeInitials(item.initials)}</td>
                <td className="py-3 text-ink tabular-nums">{formatTime(item.startAt, timeZone, { withZone: false })}</td>
                <td className="py-3 text-ink-muted">{statusLabel(item.status, item.visitStatus)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

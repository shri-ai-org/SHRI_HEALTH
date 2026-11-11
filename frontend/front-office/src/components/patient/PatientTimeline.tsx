import type { CSSProperties, ElementType } from 'react'
import { Link } from 'react-router-dom'
import { BedDouble, CalendarClock, FileWarning, IdCard, IndianRupee, LogOut, Printer, Stethoscope, Ticket, UserPlus, Video, XCircle } from 'lucide-react'
import { Card, CardHeader } from '../ui/Card'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { CheckInToggle } from '../appointment/CheckInToggle'
import { EmptyState } from '../ui/EmptyState'
import { BILL_STATUS_LABEL, BILL_STATUS_TONE, formatRupees } from '../../utils/billing'
import { appointmentStatusLabel } from '../../utils/appointment'
import { relativeDayLabel, formatDateKey } from '../../utils/dates'
import { formatClock } from '../../utils/format'
import { formatTime, todayKey } from '../../domain/time'
import { printBill } from '../../utils/printBill'
import type { PatientTimeline as Timeline, TimelineKind, UpcomingItem } from '../../domain/patientSelectors'
import type { BillDisplayStatus } from '../../types/payment'

const KIND_ICON: Record<TimelineKind, ElementType> = {
  registered: UserPlus,
  encounter: Stethoscope,
  'walk-in': Ticket,
  bill: IndianRupee,
  admitted: BedDouble,
  discharged: LogOut,
  'admission-cancelled': XCircle,
  mlc: FileWarning,
  'guest-pass': IdCard,
}

/** Each kind of event keeps one hue, so a patient's story reads at a glance. */
const KIND_HUE: Record<TimelineKind, string> = {
  registered: 'var(--color-hue-teal)',
  encounter: 'var(--color-hue-blue)',
  'walk-in': 'var(--color-hue-orange)',
  bill: 'var(--color-hue-amber)',
  admitted: 'var(--color-hue-violet)',
  discharged: 'var(--color-hue-pink)',
  'admission-cancelled': 'var(--color-ink-subtle)',
  mlc: 'var(--color-hue-red)',
  'guest-pass': 'var(--color-hue-indigo)',
}

/**
 * The patient's story on one card: what is coming up today and after (with
 * the one thing to do for each), then everything that has happened —
 * encounters, bills, admissions, medico-legal cases, guest passes.
 */
export function PatientTimeline({
  timeline,
  today,
  onReschedule,
  onCancel,
}: {
  timeline: Timeline
  today: string
  /** Moves a booking to another time. `unpaid`: nothing has been paid for it yet. */
  onReschedule: (appointmentId: string, unpaid: boolean) => void
  /** Cancels a booking. `unpaid`: nothing has been paid for it yet. */
  onCancel: (appointmentId: string, unpaid: boolean) => void
}) {
  return (
    <Card accentTone="info" className="min-w-0">
      <CardHeader icon={CalendarClock} iconTone="info" title="Visit History" />

      {/* Today & upcoming shows only when something is booked — no empty message. */}
      {timeline.upcoming.length > 0 ? (
        <section aria-label="Today and upcoming" className="border-t border-border-soft">
          <h3 className="px-5 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wide text-ink-subtle">Today &amp; upcoming</h3>
          <ul className="divide-y divide-border-soft">
            {timeline.upcoming.map((item) => (
              <UpcomingRow key={item.id} item={item} today={today} onReschedule={onReschedule} onCancel={onCancel} />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="History" className="border-t border-border-soft">
        <h3 className="px-5 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wide text-ink-subtle">History</h3>
        {timeline.history.length === 0 ? (
          <EmptyState title="Nothing yet" />
        ) : (
          <ol className="divide-y divide-border-soft">
            {timeline.history.map((event) => {
              const Icon = KIND_ICON[event.kind]
              const status = event.status
              const badge =
                status === undefined ? null : event.kind === 'bill' ? (
                  <Badge tone={BILL_STATUS_TONE[status as BillDisplayStatus]}>{BILL_STATUS_LABEL[status as BillDisplayStatus]}</Badge>
                ) : (
                  <Badge tone={event.kind === 'mlc' && status === 'Open' ? 'critical' : status === 'Incomplete' ? 'warning' : undefined} status={status}>
                    {event.statusLabel ?? status}
                  </Badge>
                )
              return (
                <li key={event.id} className="flex items-start gap-3 px-5 py-3">
                  <span
                    style={{ '--tone': KIND_HUE[event.kind] } as CSSProperties}
                    className="ink-tone mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(145deg,color-mix(in_oklab,var(--tone)_24%,var(--color-surface-1)),color-mix(in_oklab,var(--tone)_10%,var(--color-surface-1)))] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--tone)_24%,transparent)]"
                  >
                    <Icon className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    {event.paymentId ? (
                      <Link to={`/payments/${event.paymentId}`} className="focus-ring -my-3 block truncate rounded py-3 text-sm font-medium text-ink hover:text-primary-text">
                        {event.title}
                      </Link>
                    ) : (
                      <p className="truncate text-sm font-medium text-ink">{event.title}</p>
                    )}
                    <p className="truncate text-xs text-ink-muted">{event.detail}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {badge}
                    <time className="text-2xs tabular-nums text-ink-subtle" dateTime={new Date(event.at).toISOString()}>
                      {formatDateKey(todayKey(new Date(event.at)))} · {formatClock(event.at)}
                    </time>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </Card>
  )
}

function UpcomingRow({
  item,
  today,
  onReschedule,
  onCancel,
}: {
  item: UpcomingItem
  today: string
  onReschedule: (appointmentId: string, unpaid: boolean) => void
  onCancel: (appointmentId: string, unpaid: boolean) => void
}) {
  if (item.kind === 'walk-in') {
    return (
      <li className="flex items-center gap-3 px-5 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-info-bg">
          <Ticket className="h-4 w-4 text-info-fg" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">
            {item.token.tokenNumber} · {item.provider?.name ?? 'Doctor'}
          </p>
          <p className="truncate text-xs text-ink-muted">Walk-in today · {item.provider?.room ?? item.provider?.department ?? ''}</p>
        </div>
        <Badge status={item.token.status}>{item.token.status}</Badge>
      </li>
    )
  }

  const { appointment, bill, token } = item
  const isToday = appointment.date === today
  const unpaid = (appointment.status === 'Payment Pending' || appointment.status === 'Scheduled') && bill && bill.balance > 0
  const tele = appointment.mode === 'Teleconsult'
  // Booked but nothing paid yet: it can still be moved or dropped at once — an accidental tap undone.
  const fresh = Boolean(unpaid && bill && bill.paidAmount === 0)
  const canChange = fresh || appointment.status === 'Confirmed'
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <span className={tele ? 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-therapy-bg' : 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-info-bg'}>
        {tele ? (
          <Video className="h-4 w-4 text-therapy-fg" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Stethoscope className="h-4 w-4 text-info-fg" strokeWidth={1.75} aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink">
          {relativeDayLabel(appointment.date, today)} · {formatTime(appointment.slot)} · {appointment.provider?.name ?? 'Doctor'}
        </p>
        <p className="truncate text-xs text-ink-muted">
          {tele ? 'Teleconsult' : 'Doctor visit'} · {appointment.department}
          {!tele && appointment.provider?.room ? ` · ${appointment.provider.room}` : ''}
        </p>
      </div>
      {/* Checked in: where the patient is in the queue — Waiting, Called, In consultation. */}
      {appointment.status === 'Checked-in' && token ? (
        <Badge status={token.status}>{token.status}</Badge>
      ) : (
        <Badge status={appointment.status}>
          {appointmentStatusLabel(appointment.status)}
          {/* What is still owed for this visit, paid at the billing counter. */}
          {unpaid ? <span className="tabular-nums"> · {formatRupees(bill.balance)} due</span> : null}
        </Badge>
      )}
      {/* The bill to take to the billing counter — the booking is confirmed once it is paid. */}
      {unpaid && bill ? (
        <button
          type="button"
          onClick={() => printBill(bill.paymentId)}
          aria-label="Print bill"
          title="Print bill"
          className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg bg-primary-600 text-on-primary shadow-card-sm transition-colors hover:bg-primary-700"
        >
          <Printer className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}
      {/* An unpaid booking can't be checked in yet. */}
      {unpaid ? null : isToday ? (
        <CheckInToggle appointment={appointment} />
      ) : null}
      {canChange ? (
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={() => onReschedule(appointment.appointmentId, fresh)}>
            <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Reschedule
          </Button>
          <Button size="xs" variant="outline" className="text-critical-fg" onClick={() => onCancel(appointment.appointmentId, fresh)}>
            <XCircle className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Cancel
          </Button>
        </div>
      ) : null}
    </li>
  )
}

import { useState } from 'react'
import { Link } from 'react-router'
import { Badge, Button, DataTable, formatDateTime, formatTime, minutesBetween, statusLabel, todayIn, type BadgeTone, type Column } from '../../design-system'
import { CheckInDialog, UndoCheckInDialog } from './CheckInDialogs'
import { dateIn, isZoned, type ScheduledAppointment, type ZonedAppointment } from './reference'
import { RescheduleDialog } from './RescheduleDialog'

const TONE: Record<string, BadgeTone> = { booked: 'primary', arrived: 'info', 'checked-in': 'success', fulfilled: 'neutral', cancelled: 'neutral', noshow: 'warning' }

/** Booked or arrived, on the facility's today: check-in is same day only. */
const canCheckIn = (a: ZonedAppointment) => (a.status === 'booked' || a.status === 'arrived') && dateIn(a.startAt, a.timeZone) === todayIn(a.timeZone)
const canReschedule = (a: ScheduledAppointment) => a.status === 'booked' || a.status === 'arrived'
/** Only before rooming (D55); the server also refuses once there is clinical data. */
const canUndoCheckIn = (a: ScheduledAppointment) => a.status === 'checked-in' && (a.visitStatus === undefined || a.visitStatus === 'arrived' || a.visitStatus === 'checked-in')

type Dialog = { kind: 'check-in' | 'undo' | 'reschedule'; appointment: ZonedAppointment } | null

/**
 * Appointments with the front-desk actions: check in, undo a check-in, reschedule. Used by the day
 * schedule (times only) and the patient page (date and time).
 */
export function AppointmentTable({
  caption,
  appointments,
  view,
  onChanged,
  emptyTitle,
}: {
  caption: string
  appointments: ScheduledAppointment[]
  view: 'day' | 'patient'
  onChanged: () => void
  emptyTitle: string
}) {
  const [dialog, setDialog] = useState<Dialog>(null)
  const done = () => {
    setDialog(null)
    onChanged()
  }

  const columns: Column<ScheduledAppointment>[] = [
    {
      key: 'time',
      header: view === 'day' ? 'Time' : 'Date and time',
      render: (a) => <span className="tabular-nums">{view === 'day' ? formatTime(a.startAt, a.timeZone, { withZone: false }) : formatDateTime(a.startAt, a.timeZone)}</span>,
    },
    ...(view === 'day'
      ? [
          {
            key: 'patient',
            header: 'Patient',
            render: (a: ScheduledAppointment) => (
              <span className="flex flex-wrap items-center gap-2">
                <Link to={`/patients/${a.patient.id}`} className="font-medium text-primary-700 underline-offset-2 hover:underline">
                  {a.patient.displayName}
                </Link>
                {a.patient.restricted ? <Badge tone="warning">Restricted</Badge> : null}
              </span>
            ),
          },
        ]
      : []),
    { key: 'provider', header: 'Provider', render: (a) => a.provider.displayName },
    { key: 'type', header: 'Type', render: (a) => `${a.appointmentType.name} · ${minutesBetween(a.startAt, new Date(a.endAt))} min` },
    {
      key: 'status',
      header: 'Status',
      render: (a) => <Badge tone={TONE[a.status] ?? 'neutral'}>{statusLabel(a.status, a.visitStatus)}</Badge>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (a) =>
        !isZoned(a) ? (
          // Without the facility's time, "today" and the times can't be trusted, so nothing is offered.
          <span className="text-xs text-ink-muted">Facility time unknown</span>
        ) : (
        <span className="flex flex-wrap gap-1">
          {canCheckIn(a) ? (
            <Button size="sm" onClick={() => setDialog({ kind: 'check-in', appointment: a })} aria-label={`Check in ${a.patient.displayName}`}>
              Check in
            </Button>
          ) : null}
          {canUndoCheckIn(a) ? (
            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'undo', appointment: a })} aria-label={`Undo check-in of ${a.patient.displayName}`}>
              Undo check-in
            </Button>
          ) : null}
          {canReschedule(a) ? (
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'reschedule', appointment: a })} aria-label={`Reschedule ${a.patient.displayName}`}>
              Reschedule
            </Button>
          ) : null}
        </span>
        ),
    },
  ]

  return (
    <>
      <DataTable caption={caption} columns={columns} rows={appointments} rowKey={(a) => a.id} emptyTitle={emptyTitle} />
      {dialog?.kind === 'check-in' ? <CheckInDialog appointment={dialog.appointment} onClose={() => setDialog(null)} onDone={done} onStale={onChanged} /> : null}
      {dialog?.kind === 'undo' ? <UndoCheckInDialog appointment={dialog.appointment} onClose={() => setDialog(null)} onDone={done} onStale={onChanged} /> : null}
      {dialog?.kind === 'reschedule' ? <RescheduleDialog appointment={dialog.appointment} onClose={() => setDialog(null)} onMoved={done} /> : null}
    </>
  )
}

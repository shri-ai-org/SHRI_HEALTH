import type { ReactNode } from 'react'
import { Avatar } from '../ui/Avatar'
import { initialsOf } from '../../utils/format'
import { Activity, ListChecks } from 'lucide-react'
import type { ActivityEvent, ActivityType } from '../../domain/reportSelectors'

type DetailType = Exclude<ActivityType, 'PAYMENT_COMPLETED'>
import { timeLabel } from '../../utils/activityFormat'
import { Badge } from '../ui/Badge'
import { Card, CardHeader } from '../ui/Card'
import { ResponsiveTable } from '../ui/ResponsiveTable'
import type { Column as TableColumn } from '../ui/ResponsiveTable'
import { EmptyState } from '../ui/EmptyState'

/** The most records the table lists; it scrolls inside its card. */
const MAX_ROWS = 50

/** How each summary card names itself above its records. */
const DETAIL_TITLE: Record<DetailType, string> = {
  PATIENT_REGISTERED: 'Patients Registered',
  APPOINTMENT_SCHEDULED: 'Appointments Scheduled',
  PATIENT_CHECKED_IN: 'Patients Checked In',
  GUEST_PASS_ISSUED: 'Guest Passes Issued',
  PATIENT_ADMITTED: 'Admissions',
  PATIENT_DISCHARGED: 'Discharges',
}

interface Column {
  header: string
  cell: (event: ActivityEvent, withDate: boolean) => ReactNode
  /** Right-align numbers. */
  numeric?: boolean
}

const dash = <span className="text-ink-subtle">—</span>
const text = (value: string | undefined | null) => (value ? value : dash)
const statusBadge = (event: ActivityEvent) => <Badge tone={event.status === 'Completed' ? 'stable' : 'neutral'}>{event.status}</Badge>

const at = (header: string): Column => ({ header, cell: (e, withDate) => timeLabel(e.timestamp, withDate) })
const patient: Column = {
  header: 'Patient',
  cell: (e) =>
    e.patientName ? (
      <span className="flex min-w-0 items-center gap-2">
        <Avatar name={e.patientName} initials={initialsOf(e.patientName)} size="xs" />
        <span className="truncate font-medium text-ink">{e.patientName}</span>
      </span>
    ) : (
      <span className="font-medium text-ink">{text(e.patientName)}</span>
    ),
}
const patientId = (header = 'Patient ID'): Column => ({ header, cell: (e) => <span className="tabular-nums">{text(e.uhid ?? e.patientId)}</span> })
const doctor: Column = { header: 'Doctor', cell: (e) => text(e.doctorName) }
const status: Column = { header: 'Status', cell: statusBadge }
/** A booked slot: the time alone when it is the same day as the activity, else with its date. */
const bookedAt: Column = {
  header: 'Appointment Time',
  cell: (e) =>
    e.appointmentAt === undefined
      ? dash
      : timeLabel(e.appointmentAt, new Date(e.appointmentAt).toDateString() !== new Date(e.timestamp).toDateString()),
}

const COLUMNS: Record<DetailType, Column[]> = {
  PATIENT_REGISTERED: [at('Time'), patient, patientId('Patient ID / UHID'), { header: 'Registered By', cell: (e) => e.staffName }, status],
  APPOINTMENT_SCHEDULED: [
    at('Time'),
    patient,
    patientId(),
    doctor,
    { header: 'Department', cell: (e) => text(e.department) },
    bookedAt,
    status,
  ],
  PATIENT_CHECKED_IN: [at('Check-in Time'), patient, patientId(), doctor, bookedAt, status],
  GUEST_PASS_ISSUED: [
    at('Time'),
    patient,
    patientId(),
    { header: 'Guest Name', cell: (e) => text(e.guestName) },
    { header: 'Pass Type', cell: (e) => text(e.passType) },
    { header: 'Issued By', cell: (e) => e.staffName },
    status,
  ],
  PATIENT_ADMITTED: [
    at('Admission Time'),
    patient,
    patientId(),
    { header: 'Ward', cell: (e) => text(e.ward) },
    { header: 'Bed', cell: (e) => text(e.bed) },
    { header: 'Admission Type', cell: (e) => text(e.admissionType) },
    doctor,
    status,
  ],
  PATIENT_DISCHARGED: [
    at('Discharge Time'),
    patient,
    patientId(),
    { header: 'Ward', cell: (e) => text(e.ward) },
    doctor,
    { header: 'Discharge Status', cell: (e) => <Badge tone="stable">{e.dischargeType ?? 'Discharged'}</Badge> },
  ],
}

/**
 * The records behind one summary card — read-only, on the same page. The
 * columns follow the kind of activity; every value is read off the record the
 * activity came from.
 */
export function ActivityDetails({
  type,
  events,
  periodLabel,
  withDate,
}: {
  type: DetailType
  events: ActivityEvent[]
  periodLabel: string
  withDate: boolean
}) {
  const columns = COLUMNS[type]
  const rows = events.slice(0, MAX_ROWS)
  const count = `${events.length} ${events.length === 1 ? 'record' : 'records'}`
  return (
    <Card accentTone="brand">
      <CardHeader
        icon={ListChecks}
        iconTone="brand"
        title={DETAIL_TITLE[type]}
        subtitle={`${count} · ${periodLabel}`}
      />
      {events.length === 0 ? (
        <EmptyState icon={Activity} title="No records found" />
      ) : (
        <>
          <ResponsiveTable
            rows={rows}
            rowKey={(event) => event.id}
            caption={DETAIL_TITLE[type]}
            listLimit={15}
            columns={columns.map(
              (column, index): TableColumn<ActivityEvent> => ({
                key: column.header,
                header: column.header,
                numeric: column.numeric,
                className: 'whitespace-nowrap text-ink-muted',
                // Phones: the patient heads the record, its time under it, the
                // status beside it, everything else as labelled values.
                mobile: column.header === 'Patient' ? 'title' : index === 0 ? 'subtitle' : /status/i.test(column.header) ? 'aside' : 'meta',
                cell: (event) => column.cell(event, withDate),
              }),
            )}
          />
          {events.length > rows.length ? (
            <p className="border-t border-border-soft px-5 py-3 text-xs text-ink-muted">
              Showing the latest {rows.length} of {events.length}
            </p>
          ) : null}
        </>
      )}
    </Card>
  )
}


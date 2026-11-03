import type { ReactNode } from 'react'
import { Avatar } from '../ui/Avatar'
import { initialsOf } from '../../utils/format'
import { Link } from 'react-router-dom'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { AppointmentIllustration } from '../ui/illustrations/AppointmentIllustration'
import { formatClock } from '../../utils/format'
import { appointmentStatusLabel } from '../../utils/appointment'
import type { AppointmentRow } from '../../types/appointment'
import { PatientStatusIcons } from '../patient/PatientStatusIcons'
import { ModeBadge } from './ModeBadge'
import { usePatientCareStatus } from '../../hooks/useCareStatus'
import { ResponsiveTable } from '../ui/ResponsiveTable'
import type { Column } from '../ui/ResponsiveTable'
import { formatTime } from '../../domain/time'

// Arrival column shows the real check-in timestamp from the linked Visit —
// blank until the patient actually arrives, never a placeholder time.
export function AppointmentsTable({
  appointments,
  renderActions,
  renderStatus,
  actionsLabel,
  compact = false,
  maxRows,
  emptyAction,
}: {
  appointments: AppointmentRow[]
  renderActions?: (appointment: AppointmentRow) => ReactNode
  /** Overrides the Status column's content (default: the generic status
   *  Badge). Lets a specific view — e.g. a simplified check-in status —
   *  replace it without affecting every other place this table is used. */
  renderStatus?: (appointment: AppointmentRow) => ReactNode
  /** Header label for the trailing actions column (default: none, matching
   *  every existing usage, which treats it as an unlabeled action strip). */
  actionsLabel?: string
  compact?: boolean
  /** Truncates the row list (default: show everything) — independent of
   *  `compact`, which only controls column density. A full-list "view all"
   *  page can use the narrower compact columns without losing rows. */
  maxRows?: number
  emptyAction?: ReactNode
}) {
  const care = usePatientCareStatus()
  if (appointments.length === 0) {
    return (
      <EmptyState
        illustration={<AppointmentIllustration className="h-11 w-11" />}
        title="No appointments today"
        action={emptyAction}
      />
    )
  }

  const rows = typeof maxRows === 'number' ? appointments.slice(0, maxRows) : appointments

  const columns: Column<AppointmentRow>[] = [
    {
      key: 'time',
      header: 'Time',
      className: 'whitespace-nowrap font-medium tabular-nums text-ink',
      mobile: 'subtitle',
      sortValue: (a) => a.slot,
      cell: (a) => formatTime(a.slot),
    },
    {
      key: 'patient',
      header: 'Patient',
      mobile: 'title',
      sortValue: (a) => a.patient?.name ?? '',
      cell: (a) => (
        <span className="flex min-w-0 items-center gap-2.5">
          {a.patient ? (
            // In the table only — a phone card keeps the room for the name.
            <span className="hidden shrink-0 tbl:inline-flex">
              <Avatar name={a.patient.name} initials={initialsOf(a.patient.name)} size="sm" />
            </span>
          ) : null}
          <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5 text-ink tbl:max-w-[14rem]">
            {a.patient ? (
              <Link
                to={`/patients/${a.patient.uhid}`}
                title={`Open ${a.patient.name}'s profile`}
                className="focus-ring -my-3 truncate rounded py-3 font-medium text-ink underline-offset-2 hover:text-primary-text hover:underline"
              >
                {a.patient.name}
              </Link>
            ) : (
              <span className="truncate">—</span>
            )}
            <PatientStatusIcons status={care[a.patientId]} />
          </span>
          {compact ? null : <span className="block text-2xs font-normal text-ink-subtle">{a.patient?.uhid}</span>}
          </span>
        </span>
      ),
    },
    {
      key: 'doctor',
      header: 'Doctor',
      sortValue: (a) => a.provider?.name ?? '',
      cell: (a) => (
        <>
          <span className="block text-ink-muted tbl:max-w-[11rem] tbl:truncate" title={a.provider?.name}>
            {a.provider?.name ?? '—'}
          </span>
          {a.mode === 'Teleconsult' ? <ModeBadge mode="Teleconsult" /> : null}
        </>
      ),
    },
    ...(compact
      ? []
      : [{ key: 'department', header: 'Department', className: 'whitespace-nowrap text-ink-muted', cell: (a: AppointmentRow) => a.department } satisfies Column<AppointmentRow>]),
    {
      key: 'status',
      header: 'Status',
      className: 'whitespace-nowrap',
      mobile: 'aside',
      cell: (a) =>
        renderStatus ? (
          renderStatus(a)
        ) : (
          <Badge status={a.status} className={compact ? 'px-2' : undefined}>
            {appointmentStatusLabel(a.status)}
          </Badge>
        ),
    },
    ...(compact
      ? []
      : [
          {
            key: 'checkedIn',
            header: 'Checked in',
            className: 'whitespace-nowrap tabular-nums text-ink-muted',
            cell: (a: AppointmentRow) =>
              a.visit?.checkInTime ? <span title="When the patient checked in">{formatClock(a.visit.checkInTime)}</span> : <span className="text-ink-subtle">—</span>,
          } satisfies Column<AppointmentRow>,
        ]),
    // Omitted entirely (not just left empty) when there's nothing to act on.
    ...(renderActions
      ? [
          {
            key: 'actions',
            header: actionsLabel ?? <span className="sr-only">Actions</span>,
            className: 'whitespace-nowrap',
            mobile: 'actions',
            cell: (a: AppointmentRow) => <div className="flex flex-wrap items-center gap-1.5">{renderActions(a)}</div>,
          } satisfies Column<AppointmentRow>,
        ]
      : []),
  ]

  return (
    <ResponsiveTable
      rows={rows}
      columns={columns}
      rowKey={(a) => a.appointmentId}
      caption="Appointments"
    />
  )
}

import type { ReactNode } from 'react'
import { initialsOf } from '../../utils/format'
import { Avatar } from '../ui/Avatar'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { AppointmentIllustration } from '../ui/illustrations/AppointmentIllustration'
import { PatientStatusIcons } from '../patient/PatientStatusIcons'
import { usePatientCareStatus } from '../../hooks/useCareStatus'
import { appointmentStatusLabel } from '../../utils/appointment'
import { relativeDayLabel } from '../../utils/dates'
import type { OutpatientRow } from '../../domain/outpatientSelectors'
import type { Tone } from '../../utils/tone'
import { formatTime } from '../../domain/time'

/** What the row's status reads as, and the time beside it. */
function statusOf(row: OutpatientRow): { label: string; tone: Tone; note: string | null } {
  const token = row.token
  switch (row.stage) {
    case 'upcoming':
      return { label: appointmentStatusLabel(row.appointment!.status), tone: 'info', note: null }
    case 'to-check-in':
      if (row.appointment && row.appointment.status !== 'Confirmed') return { label: 'Payment pending', tone: 'warning', note: null }
      return {
        label: 'To check in',
        tone: row.lateMinutes ? 'warning' : 'neutral',
        note: row.lateMinutes ? `${row.lateMinutes} min late` : null,
      }
    case 'waiting':
      return {
        label: 'Waiting for consultation',
        tone: 'info',
        // How long since check-in, and their place in the doctor's queue — in words.
        note:
          token?.waitingMinutes != null
            ? `Waiting ${token.waitingMinutes} min${token.position ? ` · ${ordinal(token.position)} in queue` : ''}`
            : null,
      }
    case 'called':
      return { label: 'Called', tone: 'info', note: token?.calledMinutes != null ? `Called ${token.calledMinutes} min ago` : null }
    case 'in-room':
      return { label: 'In room', tone: 'stable', note: token?.consultingMinutes != null ? `In the room for ${token.consultingMinutes} min` : null }
    case 'done': {
      const word = token?.status === 'No-show' ? 'No-show' : token ? 'Completed' : row.appointment ? appointmentStatusLabel(row.appointment.status) : 'Completed'
      return { label: word, tone: word === 'Completed' ? 'stable' : word === 'Cancelled' || word === 'No-show' ? 'neutral' : 'info', note: null }
    }
  }
}

function ordinal(n: number): string {
  const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'
  return `${n}${suffix}`
}

/**
 * Outpatients, one row each — booked time or walk-in token, the patient,
 * the doctor and where (room), the stage, and
 * that stage's actions. Rows wrap on a phone rather than scroll sideways.
 */
export function OutpatientList({
  rows,
  today,
  onOpenPatient,
  renderActions,
  emptyTitle,
  emptyDescription,
}: {
  rows: OutpatientRow[]
  today: string
  onOpenPatient: (patientId: string) => void
  renderActions: (row: OutpatientRow) => ReactNode
  emptyTitle: string
  emptyDescription?: string
}) {
  const care = usePatientCareStatus()
  if (rows.length === 0) {
    return <EmptyState illustration={<AppointmentIllustration className="h-11 w-11" />} title={emptyTitle} description={emptyDescription} />
  }
  return (
    <ul className="divide-y divide-border-soft">
      {rows.map((row) => {
        const status = statusOf(row)
        return (
          <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-surface-2 sm:px-5">
            {/* Just the time — the booked slot, or a walk-in's arrival. */}
            <div className="w-20 shrink-0">
              <p className="text-sm font-semibold tabular-nums text-ink">{formatTime(row.time)}</p>
              {row.stage === 'upcoming' ? <p className="truncate text-2xs text-ink-subtle">{relativeDayLabel(row.date, today)}</p> : null}
            </div>
            <div className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
              {row.patient ? <Avatar name={row.patient.name} initials={initialsOf(row.patient.name)} size="sm" /> : null}
              <div className="min-w-0 flex-1">
              <p className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => row.patient && onOpenPatient(row.patient.patientId)}
                  className="focus-ring -my-3 truncate rounded py-3 text-left text-sm font-medium text-ink underline-offset-2 hover:underline"
                >
                  {row.patient?.name ?? '—'}
                </button>
                <PatientStatusIcons status={row.patient ? care[row.patient.patientId] : undefined} />
              </p>
              <p className="truncate text-xs text-ink-muted">
                {row.provider?.name ?? '—'} ·{' '}
                {row.provider?.room ?? 'In person'}{' '}
                · {row.patient?.uhid}
              </p>
              </div>
            </div>
            <div className="flex min-w-0 shrink-0 flex-col items-start gap-0.5 sm:w-56">
              <Badge tone={status.tone}>{status.label}</Badge>
              {status.note ? (
                <span className={row.lateMinutes ? 'text-2xs font-medium text-warning-fg' : 'text-2xs tabular-nums text-ink-muted'}>{status.note}</span>
              ) : null}
            </div>
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:ml-auto sm:w-[21rem] sm:shrink-0 sm:justify-end">{renderActions(row)}</div>
          </li>
        )
      })}
    </ul>
  )
}

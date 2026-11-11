import { useState } from 'react'
import type { FormEvent } from 'react'
import { CalendarClock, CalendarX2, Trash2, XCircle } from 'lucide-react'
import { Card, CardBody, CardHeader } from '../ui/Card'
import { Button } from '../ui/Button'
import { Alert } from '../ui/Alert'
import { Modal } from '../ui/Modal'
import { BookingDialog } from '../appointment/BookingDialog'
import { useStoreValue } from '../../hooks/useStore'
import { useNow } from '../../hooks/useNow'
import { useToast } from '../../hooks/useToast'
import { useFlow } from '../../flows/useFlow'
import { getDoctorDayBookings, getDoctorLeaves, getDoctorQueueCount } from '../../domain/selectors'
import { addDoctorLeave, cancelDoctorDayBookings, removeDoctorLeave } from '../../domain/actions'
import { formatTime, todayKey } from '../../domain/time'
import { formatRupees } from '../../utils/billing'
import { formatDateKey } from '../../utils/dates'

/**
 * Leave for one doctor. A day with bookings can't be leave until each is
 * moved (reschedule) or cancelled — as doctor unavailable, so the patient
 * is refunded in full; "Cancel all" clears the day in one go.
 */
export function DoctorLeaveCard({ providerId, providerName }: { providerId: string; providerName: string }) {
  const today = todayKey(new Date(useNow(60000)))
  const { notify } = useToast()
  const { openFlow } = useFlow()
  const leaves = useStoreValue(getDoctorLeaves, providerId)
  const [date, setDate] = useState('')
  const [reason, setReason] = useState('Leave')
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const bookings = useStoreValue(getDoctorDayBookings, providerId, date)
  const inQueue = useStoreValue(getDoctorQueueCount, providerId)
  const queueBlocks = date === today && inQueue > 0
  const totalRefund = bookings.reduce((sum, booking) => sum + booking.paid, 0)

  function run(action: () => void, done: string, detail?: string): boolean {
    setError(null)
    try {
      action()
      notify(done, { detail })
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      notify('Could not do that', { tone: 'error', detail: message })
      return false
    }
  }

  function recordLeave(event: FormEvent) {
    event.preventDefault()
    if (run(() => addDoctorLeave(providerId, date, reason.trim() || 'Leave'), 'Leave recorded', `${providerName} · ${formatDateKey(date)}`)) {
      setDate('')
    }
  }

  function cancelAll() {
    setConfirmAll(false)
    setError(null)
    try {
      const result = cancelDoctorDayBookings({ providerId, date, note: `${providerName} unavailable` })
      notify(`${result.cancelled} booking${result.cancelled === 1 ? '' : 's'} cancelled`, { detail: `${formatRupees(result.refunded)} refunded in full` })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card accentTone="warning">
      <CardHeader icon={CalendarX2} iconTone="warning" title="Leave & unavailability" />
      <CardBody className="flex flex-col gap-3">
        {error ? <Alert tone="warning">{error}</Alert> : null}
        <form onSubmit={recordLeave} className="flex flex-col gap-2">
          <input
            type="date"
            value={date}
            min={today}
            onChange={(event) => {
              setError(null)
              setDate(event.target.value)
            }}
            aria-label="Leave date"
            className="focus-ring min-h-11 w-full rounded-lg border border-border bg-surface-1 px-3 text-sm text-ink"
          />
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason"
            aria-label="Reason"
            maxLength={60}
            className="focus-ring min-h-11 w-full rounded-lg border border-border bg-surface-1 px-3 text-sm text-ink"
          />

          {queueBlocks ? (
            <Alert tone="warning">
              {inQueue} patient{inQueue === 1 ? ' is' : 's are'} in {providerName}'s queue today — see them or send them to another doctor first.
            </Alert>
          ) : null}

          {bookings.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-xl border border-warning-fg/25 bg-warning-bg/40 p-3">
              <p className="text-xs font-medium text-warning-fg">
                {bookings.length} booking{bookings.length === 1 ? '' : 's'} on {formatDateKey(date)} — move or cancel {bookings.length === 1 ? 'it' : 'them'} first.
              </p>
              <ul className="divide-y divide-border-soft">
                {bookings.map(({ appointment, patient, paid }) => (
                  <li key={appointment.appointmentId} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {formatTime(appointment.slot)} · {patient?.name ?? 'Patient'}
                      </span>
                      <span className="block text-xs text-ink-muted">{formatRupees(paid)} paid</span>
                    </span>
                    <Button type="button" size="sm" variant="secondary" onClick={() => openFlow('reschedule', { appointment: appointment.appointmentId })}>
                      <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.75} />
                      Reschedule
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="text-critical-fg" onClick={() => setCancelling(appointment.appointmentId)}>
                      Cancel
                    </Button>
                  </li>
                ))}
              </ul>
              <Button type="button" size="sm" variant="danger" onClick={() => setConfirmAll(true)}>
                <XCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
                Cancel all — doctor unavailable
              </Button>
            </div>
          ) : null}

          <Button type="submit" size="sm" variant="secondary" disabled={!date || bookings.length > 0 || queueBlocks}>
            Record leave
          </Button>
        </form>

        {leaves.length === 0 ? (
          <p className="text-xs text-ink-subtle">No leave recorded.</p>
        ) : (
          <div className="divide-y divide-border-soft border-t border-border-soft">
            {leaves.map((leave) => (
              <div key={leave.leaveId} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-ink">{formatDateKey(leave.date)}</p>
                  <p className="truncate text-xs text-ink-muted">{leave.reason}</p>
                </div>
                <button
                  type="button"
                  onClick={() => run(() => removeDoctorLeave(leave.leaveId), 'Leave removed', formatDateKey(leave.date))}
                  className="focus-ring tap-target rounded-lg text-ink-subtle transition-colors hover:bg-surface-2 hover:text-critical-fg"
                  aria-label={`Remove leave on ${formatDateKey(leave.date)}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardBody>

      {cancelling ? (
        <BookingDialog
          key={cancelling}
          appointmentId={cancelling}
          startWith="cancel"
          presetBy="Doctor"
          onClose={() => setCancelling(null)}
          onReschedule={(appointmentId) => {
            setCancelling(null)
            openFlow('reschedule', { appointment: appointmentId })
          }}
        />
      ) : null}

      <Modal
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title="Cancel every booking that day?"
        description={`${bookings.length} booking${bookings.length === 1 ? '' : 's'} with ${providerName} on ${date ? formatDateKey(date) : ''} will be cancelled as doctor unavailable, and ${formatRupees(totalRefund)} refunded in full to the patients.`}
      >
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmAll(false)}>
            Keep bookings
          </Button>
          <Button variant="danger" onClick={cancelAll}>
            Cancel {bookings.length} and refund
          </Button>
        </div>
      </Modal>
    </Card>
  )
}

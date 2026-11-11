import { useState } from 'react'
import { CalendarClock, XCircle } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Alert } from '../ui/Alert'
import { useStoreValue } from '../../hooks/useStore'
import { useToast } from '../../hooks/useToast'
import { getAppointmentById, getBillsForAppointment, getPatientById, getProviderById, getToday } from '../../domain/selectors'
import { cancelAppointment } from '../../domain/actions'
import { billNumberFor, formatRupees } from '../../utils/billing'
import { dayWithDate } from '../../utils/dates'
import { cn } from '../../utils/cn'
import type { UnavailableParty } from '../../types/appointment'
import { inputClass } from '../../utils/formClasses'
import { formatTime } from '../../domain/time'

/**
 * One booking's options when the patient or the doctor can't keep it:
 * move it (the reschedule flow) or cancel it. Cancelling asks who can't
 * make it — a doctor's absence is refunded in full, a patient's
 * cancellation keeps the fee — and says which before anything is saved.
 */
export function BookingDialog({
  appointmentId,
  startWith = 'choose',
  presetBy = null,
  onClose,
  onReschedule,
}: {
  appointmentId: string | null
  /** Open on the choice of reschedule or cancel, or straight on cancelling. */
  startWith?: 'choose' | 'cancel'
  /** Who can't make it, when the page already knows — a doctor's leave. */
  presetBy?: UnavailableParty | null
  onClose: () => void
  /** Closes the dialog and opens the reschedule flow. */
  onReschedule: (appointmentId: string) => void
}) {
  const { notify } = useToast()
  const today = useStoreValue(getToday)
  const appointment = useStoreValue(getAppointmentById, appointmentId ?? '')
  const patient = useStoreValue(getPatientById, appointment?.patientId ?? '')
  const provider = useStoreValue(getProviderById, appointment?.providerId ?? '')
  const bills = useStoreValue(getBillsForAppointment, appointmentId ?? '')
  const [view, setView] = useState(startWith)
  const [by, setBy] = useState<UnavailableParty | null>(presetBy)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!appointmentId || !appointment) return null

  const paid = bills.reduce((sum, bill) => sum + bill.paidAmount, 0)
  const methods = [...new Set(bills.flatMap((bill) => bill.transactions.map((t) => t.method)))].join(' + ')
  const billNumbers = bills.filter((bill) => bill.paidAmount > 0).map(billNumberFor).join(', ')
  const when = `${dayWithDate(appointment.date, today)} · ${formatTime(appointment.slot)}`

  function confirmCancel() {
    if (!by) return
    setError(null)
    try {
      cancelAppointment({ appointmentId: appointment!.appointmentId, by, note })
      notify('Booking cancelled', {
        detail: by === 'Doctor' && paid > 0 ? `${formatRupees(paid)} refunded to ${methods}` : paid > 0 ? 'Fee kept — the patient cancelled' : undefined,
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={view === 'cancel' ? 'Cancel booking' : 'Change booking'}
      description={`${patient?.name ?? 'Patient'} · ${provider?.name ?? 'Doctor'} · ${when}${appointment.mode === 'Teleconsult' ? ' · Teleconsult' : ''}`}
    >
      {view === 'choose' ? (
        <div className="flex flex-col gap-2">
          <Button size="lg" onClick={() => onReschedule(appointment.appointmentId)}>
            <CalendarClock className="h-4 w-4" strokeWidth={1.75} />
            Reschedule
          </Button>
          <Button size="lg" variant="secondary" className="text-critical-fg" onClick={() => setView('cancel')}>
            <XCircle className="h-4 w-4" strokeWidth={1.75} />
            Cancel booking
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {error ? <Alert tone="critical">{error}</Alert> : null}
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium text-ink-muted">Who can't make it?</legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Who can't make it">
              {(['Patient', 'Doctor'] as UnavailableParty[]).map((party) => (
                <button
                  key={party}
                  type="button"
                  role="radio"
                  aria-checked={by === party}
                  onClick={() => setBy(party)}
                  className={cn(
                    'focus-ring min-h-11 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors',
                    by === party ? 'border-primary-600 bg-primary-50 font-semibold text-ink' : 'border-border text-ink-muted hover:bg-surface-2',
                  )}
                >
                  {party === 'Patient' ? 'The patient' : 'The doctor'}
                </button>
              ))}
            </div>
          </fieldset>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Note (optional) — e.g. patient unwell, doctor on leave"
            aria-label="Note (optional)"
            maxLength={120}
            className={inputClass}
          />
          {by ? (
            <p className={cn('rounded-xl px-4 py-3 text-sm', by === 'Doctor' ? 'bg-success-bg text-success-fg' : 'bg-surface-2 text-ink')}>
              {paid === 0
                ? 'Nothing was paid on this booking.'
                : by === 'Doctor'
                  ? `The billing counter refunds the ${formatRupees(paid)} paid by ${methods} in full (${billNumbers}).`
                  : `The patient cancelled — the ${formatRupees(paid)} fee is kept.`}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Keep booking
            </Button>
            <Button variant="danger" disabled={!by} onClick={confirmCancel}>
              Cancel booking
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

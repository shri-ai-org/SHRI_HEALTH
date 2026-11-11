import { Check, LogIn, Video } from 'lucide-react'
import { Button } from '../ui/Button'
import { useStoreValue } from '../../hooks/useStore'
import { useToast } from '../../hooks/useToast'
import { checkInAppointment, undoCheckIn } from '../../domain/actions'
import type { Appointment } from '../../types/appointment'
import type { AppState } from '../../types/store'

function tokenStatusOf(state: AppState, visitId: string): string | null {
  return state.queueTokens.find((t) => t.visitId === visitId)?.status ?? null
}

/**
 * Check in, and take it back: a booking still to arrive shows "Check in";
 * once checked in it stays as a pressed "Checked in" that a second click
 * undoes — for a mistaken check-in — until the doctor calls the patient.
 */
export function CheckInToggle({
  appointment,
  patientName,
  pressedLabel,
}: {
  appointment: Appointment
  patientName?: string
  /** What the checked-in state reads as — "Waiting" where the list shows status. */
  pressedLabel?: string
}) {
  const { notify } = useToast()
  const tokenStatus = useStoreValue(tokenStatusOf, appointment.visitId ?? '')
  const tele = appointment.mode === 'Teleconsult'

  function run(action: () => string | undefined, done: string) {
    try {
      const detail = action()
      notify(done, { detail })
    } catch (err) {
      notify('Could not do that', { tone: 'error', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  if (appointment.status === 'Confirmed') {
    return (
      <Button
        size="sm"
        onClick={() =>
          run(() => {
            const result = checkInAppointment(appointment.appointmentId)
            return [`Token ${result.tokenNumber}`, patientName].filter(Boolean).join(' · ')
          }, tele ? 'Joined' : 'Checked in')
        }
      >
        {tele ? <Video className="h-3.5 w-3.5" strokeWidth={1.75} /> : <LogIn className="h-3.5 w-3.5" strokeWidth={1.75} />}
        {tele ? 'Mark joined' : 'Check in'}
      </Button>
    )
  }

  if (appointment.status === 'Checked-in' && tokenStatus === 'Waiting') {
    return (
      <Button
        size="sm"
        variant="secondary"
        aria-pressed
        title="Checked in by mistake? Click again to undo"
        onClick={() =>
          run(() => {
            undoCheckIn(appointment.appointmentId)
            return patientName ? `${patientName} · back to "to check in"` : 'Back to "to check in"'
          }, 'Check-in undone')
        }
      >
        <Check className="h-3.5 w-3.5" strokeWidth={2} />
        {pressedLabel ?? (tele ? 'Joined' : 'Checked in')}
      </Button>
    )
  }

  return null
}

import { useRef, useState } from 'react'
import { Check, LogIn, Video } from 'lucide-react'
import { Button } from '../ui/Button'
import { useStoreValue } from '../../hooks/useStore'
import { useToast } from '../../hooks/useToast'
import { checkInAppointment, undoCheckIn } from '../../domain/actions'
import { checkInOnServer, isServerAppointment, undoCheckInOnServer } from '../../../shri-health/scheduling'
import { newIdempotencyKey, problemMessage } from '../../../shri-health/client'
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

  // A SHRI_HEALTH booking is checked in (or back) on the server first; Care Entry's own check-in
  // then adds the visit and the token, which the contract does not have.
  const server = isServerAppointment(appointment.appointmentId)
  const [busy, setBusy] = useState(false)
  // Kept while the same check-in is retried, so the server does it only once.
  const checkInKey = useRef<string | null>(null)

  async function run(action: () => string | undefined, done: string, before?: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try {
      if (before) await before()
      const detail = action()
      notify(done, { detail })
    } catch (err) {
      notify('Could not do that', { tone: 'error', detail: problemMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  if (appointment.status === 'Confirmed') {
    return (
      <Button
        size="sm"
        disabled={busy}
        onClick={() =>
          void run(
            () => {
              const result = checkInAppointment(appointment.appointmentId)
              checkInKey.current = null
              return [`Token ${result.tokenNumber}`, patientName].filter(Boolean).join(' · ')
            },
            tele ? 'Joined' : 'Checked in',
            server ? () => checkInOnServer(appointment.appointmentId, (checkInKey.current ??= newIdempotencyKey())) : undefined,
          )
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
        disabled={busy}
        onClick={() =>
          void run(
            () => {
              undoCheckIn(appointment.appointmentId)
              return patientName ? `${patientName} · back to "to check in"` : 'Back to "to check in"'
            },
            'Check-in undone',
            // The contract asks why; this button is only for a check-in pressed by mistake.
            server ? () => undoCheckInOnServer(appointment.appointmentId, 'Checked in by mistake') : undefined,
          )
        }
      >
        <Check className="h-3.5 w-3.5" strokeWidth={2} />
        {pressedLabel ?? (tele ? 'Joined' : 'Checked in')}
      </Button>
    )
  }

  return null
}

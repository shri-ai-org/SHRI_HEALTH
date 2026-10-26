import { useRef, useState } from 'react'
import { ApiError, newIdempotencyKey } from '../../api/client'
import { checkInAppointment, undoCheckIn } from '../../api/generated/endpoints/scheduling/scheduling'
import type { ScheduledAppointment } from './reference'
import { Button, Field, formatTime, isOverLimit, Modal, ProblemAlert, Textarea, useToast, type Problem } from '../../design-system'

const REASON_LIMIT = 500

/**
 * Checks the patient in (inventory #56, D16): one transaction creates the encounter and queues a
 * real-time eligibility check (D15). Same day only. The Idempotency-Key is required and kept for
 * retries of this dialog, so a repeat replays the first result instead of checking in twice.
 */
export function CheckInDialog({ appointment, onClose, onDone }: { appointment: ScheduledAppointment; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [selfPay, setSelfPay] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)
  const idempotencyKey = useRef<string | null>(null)

  async function confirm() {
    idempotencyKey.current ??= newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    try {
      const res = await checkInAppointment(appointment.id, { 'Idempotency-Key': idempotencyKey.current }, selfPay ? { selfPay: true } : {})
      if (res.status === 200) {
        toast.show(`${appointment.patient.displayName} checked in`)
        onDone()
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      setProblem(error.problem)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title={`Check in ${appointment.patient.displayName}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void confirm()}>
            Check in
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p>
          {formatTime(appointment.startAt, appointment.timeZone)} with {appointment.provider.displayName}, {appointment.appointmentType.name}. The patient’s active insurance is checked
          now.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={selfPay}
            onChange={(e) => {
              setSelfPay(e.target.checked)
              idempotencyKey.current = null
            }}
          />
          Self-pay visit (don’t use insurance)
        </label>
        {problem ? <ProblemAlert problem={problem} /> : null}
      </div>
    </Modal>
  )
}

/**
 * Reverses a check-in made by mistake (D55): only before rooming and before any clinical data. The
 * encounter becomes entered-in-error with the reason; nothing is deleted.
 */
export function UndoCheckInDialog({ appointment, onClose, onDone }: { appointment: ScheduledAppointment; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)

  async function confirm() {
    const text = reason.trim()
    if (!text) return setError('Explain why the check-in was a mistake.')
    if (isOverLimit(text, REASON_LIMIT)) return setError(`Shorten the reason to ${REASON_LIMIT} characters or fewer.`)
    setError(null)
    setBusy(true)
    setProblem(null)
    try {
      const res = await undoCheckIn(appointment.id, { reason: text })
      if (res.status === 200) {
        toast.show('Check-in undone')
        onDone()
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e
      setProblem(e.problem)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title={`Undo the check-in of ${appointment.patient.displayName}?`}
      onClose={onClose}
      initialFocus={reasonRef}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Keep checked in
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            Undo check-in
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p>The appointment goes back to booked, and the visit opened at check-in is marked entered in error. Not possible once the patient is roomed.</p>
        <Field label="Reason" hint="For example: wrong patient checked in" required error={error ?? undefined}>
          {(p) => <Textarea {...p} ref={reasonRef} value={reason} limit={REASON_LIMIT} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {problem ? <ProblemAlert problem={problem} /> : null}
      </div>
    </Modal>
  )
}

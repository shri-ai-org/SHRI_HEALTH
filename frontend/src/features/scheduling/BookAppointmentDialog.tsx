import { useId, useRef, useState, type FormEvent } from 'react'
import { ApiError, newIdempotencyKey } from '../../api/client'
import { bookAppointment } from '../../api/generated/endpoints/scheduling/scheduling'
import type { Appointment, AppointmentCreate } from '../../api/generated/model'
import { Button, Field, formatDateTime, isOverLimit, Modal, ProblemAlert, Textarea, useToast, type Problem } from '../../design-system'
import { useBookingReference } from './reference'
import { EMPTY_CHOICE, SlotFields, validateChoice, type SlotChoice, type SlotErrors } from './SlotFields'

const NOTE_LIMIT = 1000

/**
 * Books an appointment for a patient (inventory #51). Booking queues an eligibility check (D15). A
 * time someone else took meanwhile gives `409 booking-conflict`: the free times are read again.
 */
export function BookAppointmentDialog({ patientId, patientName, onClose, onBooked }: { patientId: string; patientName: string; onClose: () => void; onBooked: (a: Appointment) => void }) {
  const toast = useToast()
  const formId = useId()
  const reference = useBookingReference()
  const [choice, setChoice] = useState<SlotChoice>(EMPTY_CHOICE)
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<SlotErrors & { reason?: string | undefined }>({})
  const [problem, setProblem] = useState<Problem | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [busy, setBusy] = useState(false)
  // One key per user action: kept while the same booking is retried, replaced when anything changes.
  const idempotencyKey = useRef<string | null>(null)

  function changeChoice(next: SlotChoice) {
    setChoice(next)
    idempotencyKey.current = null
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const found: SlotErrors & { reason?: string } = validateChoice(choice)
    if (isOverLimit(reason, NOTE_LIMIT)) found.reason = `Shorten the reason to ${NOTE_LIMIT} characters or fewer.`
    setErrors(found)
    if (Object.keys(found).length > 0 || !choice.slot) return
    const body: AppointmentCreate = {
      patientId,
      providerId: choice.slot.providerId,
      facilityId: choice.facilityId,
      appointmentTypeId: choice.appointmentTypeId,
      startAt: choice.slot.startAt,
    }
    if (choice.slot.locationId) body.locationId = choice.slot.locationId
    if (choice.slot.overbook) body.overbook = true
    if (reason.trim()) body.reasonForVisit = reason.trim()
    idempotencyKey.current ??= newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    try {
      const res = await bookAppointment(body, { 'Idempotency-Key': idempotencyKey.current })
      if (res.status === 201) {
        toast.show(`Booked for ${formatDateTime(res.data.startAt, res.data.timeZone)}`)
        onBooked(res.data)
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      setProblem(error.problem)
      if (error.code === 'booking-conflict') {
        // Someone else took the time: show the free times as they are now.
        setChoice((c) => ({ ...c, slot: null }))
        idempotencyKey.current = null
        setRefreshKey((k) => k + 1)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      size="lg"
      title={`Book an appointment for ${patientName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            Book appointment
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        <SlotFields reference={reference} value={choice} onChange={changeChoice} errors={errors} refreshKey={refreshKey} />
        <Field label="Reason for visit" hint="Optional; shown to the care team" error={errors.reason}>
          {(p) => <Textarea {...p} value={reason} limit={NOTE_LIMIT} rows={2} onChange={(e) => {
                setReason(e.target.value)
                idempotencyKey.current = null
              }} />}
        </Field>
        {problem ? <ProblemAlert problem={problem} /> : null}
      </form>
    </Modal>
  )
}

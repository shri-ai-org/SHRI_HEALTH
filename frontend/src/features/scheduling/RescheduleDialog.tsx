import { useId, useRef, useState, type FormEvent } from 'react'
import { ApiError, newIdempotencyKey } from '../../api/client'
import { rescheduleAppointment } from '../../api/generated/endpoints/scheduling/scheduling'
import type { Appointment, RescheduleRequest } from '../../api/generated/model'
import { Button, Field, formatDateTime, isOverLimit, Modal, ProblemAlert, Select, Textarea, useToast, type Problem } from '../../design-system'
import { dateIn, RESCHEDULE_REASONS, useBookingReference, type ScheduledAppointment } from './reference'
import { SlotFields, validateChoice, type SlotChoice, type SlotErrors } from './SlotFields'

const NOTE_LIMIT = 500

type Errors = SlotErrors & { reasonCode?: string | undefined; reasonText?: string | undefined }

/**
 * Moves an appointment (D61): the only way to change its time, provider, facility or type. In one
 * transaction the old one is cancelled with the reason and a new one is booked, carrying
 * `rescheduledFromId`. Starts from the current facility, type and provider.
 */
export function RescheduleDialog({ appointment, onClose, onMoved }: { appointment: ScheduledAppointment; onClose: () => void; onMoved: (a: Appointment) => void }) {
  const toast = useToast()
  const formId = useId()
  const reference = useBookingReference()
  const [choice, setChoice] = useState<SlotChoice>({
    facilityId: appointment.facilityId,
    appointmentTypeId: appointment.appointmentType.id,
    providerId: appointment.provider.id,
    date: dateIn(appointment.startAt, appointment.timeZone),
    slot: null,
  })
  const [reasonCode, setReasonCode] = useState('')
  const [reasonText, setReasonText] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [problem, setProblem] = useState<Problem | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [busy, setBusy] = useState(false)
  // One key per user action: kept while the same move is retried, replaced when anything changes.
  const idempotencyKey = useRef<string | null>(null)
  const touch = () => {
    idempotencyKey.current = null
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const found: Errors = validateChoice(choice)
    if (!reasonCode) found.reasonCode = 'Choose why the appointment is moving.'
    if (reasonCode === 'other' && !reasonText.trim()) found.reasonText = 'Explain the reason.'
    if (isOverLimit(reasonText, NOTE_LIMIT)) found.reasonText = `Shorten the note to ${NOTE_LIMIT} characters or fewer.`
    setErrors(found)
    if (Object.keys(found).length > 0 || !choice.slot) return
    const body: RescheduleRequest = { startAt: choice.slot.startAt, reasonCode }
    // Only what changed is sent; the server keeps the rest from the old appointment.
    if (choice.slot.providerId !== appointment.provider.id) body.providerId = choice.slot.providerId
    if (choice.facilityId !== appointment.facilityId) body.facilityId = choice.facilityId
    if (choice.appointmentTypeId !== appointment.appointmentType.id) body.appointmentTypeId = choice.appointmentTypeId
    if (choice.slot.locationId) body.locationId = choice.slot.locationId
    if (reasonText.trim()) body.reasonText = reasonText.trim()
    idempotencyKey.current ??= newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    try {
      const res = await rescheduleAppointment(appointment.id, body, { 'Idempotency-Key': idempotencyKey.current })
      if (res.status === 201) {
        toast.show(`Moved to ${formatDateTime(res.data.startAt, res.data.timeZone)}`)
        onMoved(res.data)
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      setProblem(error.problem)
      if (error.code === 'booking-conflict') {
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
      title={`Reschedule ${appointment.patient.displayName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Keep the appointment
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            Reschedule
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        <p className="text-sm text-ink-muted">
          Now: {formatDateTime(appointment.startAt, appointment.timeZone)} with {appointment.provider.displayName}, {appointment.appointmentType.name}.
        </p>
        <SlotFields
          reference={reference}
          value={choice}
          onChange={(next) => {
            setChoice(next)
            touch()
          }}
          errors={errors}
          refreshKey={refreshKey}
          current={{ startAt: appointment.startAt, providerId: appointment.provider.id }}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Reason" required error={errors.reasonCode}>
            {(p) => (
              <Select
                {...p}
                value={reasonCode}
                onChange={(e) => {
                  setReasonCode(e.target.value)
                  touch()
                }}
              >
                <option value="">Choose…</option>
                {RESCHEDULE_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Note" hint={reasonCode === 'other' ? 'Required for Other' : 'Optional'} required={reasonCode === 'other'} error={errors.reasonText}>
          {(p) => (
            <Textarea
              {...p}
              value={reasonText}
              limit={NOTE_LIMIT}
              rows={2}
              onChange={(e) => {
                setReasonText(e.target.value)
                touch()
              }}
            />
          )}
        </Field>
        {problem ? <ProblemAlert problem={problem} /> : null}
      </form>
    </Modal>
  )
}

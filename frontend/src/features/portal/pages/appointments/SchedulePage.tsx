import { Clock } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { newIdempotencyKey } from '../../../../api/client'
import type { PortalAppointment, PortalBookingFacility, PortalSlot } from '../../../../api/generated/model'
import { Alert, Button, DateInput, EmptyState, Field, formatDate, formatTime, Modal, problemCopy, Select, Spinner, todayIn } from '../../../../design-system'
import { cn } from '../../../../design-system/lib/cn'
import { usePortalApi } from '../../api/portalApi'
import { toProblem, useResource } from '../../api/useResource'
import { useRouter } from '../../router'
import { AsyncPanel, ErrorSummary, formatLongDay, PageHeader } from '../../ui'

/*
 * The old "Schedule an appointment" page, on the contract's booking flow (M20): location, then the
 * visit types offered there (each with its length), then the providers for that type, then a date
 * and the free times (`GET /portal/me/slots`). A taken time (`409 booking-conflict`) reads the free
 * times again. Rescheduling keeps the location and visit type and moves the time (and provider).
 */

const REASONS = ['New Medical Problem Visit', 'Medical Problem Followup Visit', 'Annual Physical', 'Well child checkup', 'Others']

/** The bookable window: today plus 30 days. */
const WINDOW_DAYS = 30

interface Form {
  facilityId: string
  appointmentTypeId: string
  reason: string
  providerId: string
  date: string | null
  slot: PortalSlot | null
}

export function SchedulePage({ rescheduleId }: { rescheduleId?: string }) {
  const api = usePortalApi()
  const refs = useResource(() => Promise.all([api.listBookingFacilities(), rescheduleId ? api.getAppointment(rescheduleId) : Promise.resolve(null)]), [rescheduleId])
  return (
    <>
      <PageHeader
        title={rescheduleId ? 'Reschedule an appointment' : 'Schedule an appointment'}
        back={rescheduleId ? { to: `/appointments/${rescheduleId}`, label: 'Upcoming Visit Details' } : { to: '/appointments', label: 'My Appointments' }}
      />
      <AsyncPanel resource={refs} label="scheduling options">
        {([facilities, existing]) => <ScheduleForm facilities={facilities} existing={existing} />}
      </AsyncPanel>
    </>
  )
}

function ScheduleForm({ facilities, existing }: { facilities: PortalBookingFacility[]; existing: PortalAppointment | null }) {
  const api = usePortalApi()
  const { navigate } = useRouter()
  const [f, setF] = useState<Form>(() => ({
    facilityId: existing?.facility.id ?? '',
    appointmentTypeId: existing?.appointmentType.id ?? '',
    reason: existing?.reasonForVisit ?? '',
    providerId: existing?.provider.id ?? '',
    date: existing ? todayIn(existing.timeZone, new Date(existing.startAt)) : '',
    slot: null,
  }))
  const facility = facilities.find((x) => x.id === f.facilityId)
  // Dates and times are the facility's (D40).
  const tz = facility?.timeZone ?? existing?.timeZone ?? facilities[0]?.timeZone ?? 'UTC'
  // When the form opened; the bookable window counts from then.
  const [openedAt] = useState(() => Date.now())
  const today = todayIn(tz, new Date(openedAt))
  const lastDay = todayIn(tz, new Date(openedAt + WINDOW_DAYS * 86_400_000))

  const types = useResource(() => (f.facilityId ? api.listBookingAppointmentTypes(f.facilityId) : Promise.resolve([])), [f.facilityId])
  const providers = useResource(
    () => (f.facilityId && f.appointmentTypeId ? api.listBookingProviders(f.facilityId, f.appointmentTypeId) : Promise.resolve([])),
    [f.facilityId, f.appointmentTypeId],
  )
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([])
  const [picking, setPicking] = useState(false)
  // Bumped after a booking conflict, so the free times are read again.
  const [slotsVersion, setSlotsVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [booked, setBooked] = useState<PortalAppointment | null>(null)
  // One key per chosen time: a retry of the same booking is the same request (API_STANDARDS §10).
  const [key, setKey] = useState(newIdempotencyKey)
  const set = (patch: Partial<Form>) => {
    setF((x) => ({ ...x, ...patch }))
    setKey(newIdempotencyKey())
  }
  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message
  const canPickTime = Boolean(f.facilityId && f.appointmentTypeId && f.providerId && f.date && f.date >= today && f.date <= lastDay)
  const type = types.status === 'ready' ? types.data.find((t) => t.id === f.appointmentTypeId) : undefined

  function validate() {
    const found: typeof errors = []
    if (!f.facilityId) found.push({ fieldId: 'sc-facility', message: 'Select a location' })
    if (!f.appointmentTypeId) found.push({ fieldId: 'sc-type', message: 'Select an appointment type' })
    if (!f.reason) found.push({ fieldId: 'sc-reason', message: 'Select a reason for visit' })
    if (!f.providerId) found.push({ fieldId: 'sc-provider', message: 'Select a provider' })
    if (!f.date) found.push({ fieldId: 'sc-date', message: 'Enter a valid date as MM/DD/YYYY' })
    else if (f.date < today || f.date > lastDay) found.push({ fieldId: 'sc-date', message: `Choose a date from ${formatDate(today)} to ${formatDate(lastDay)}` })
    if (!f.slot) found.push({ fieldId: 'sc-time', message: 'Select a preferred time' })
    return found
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const found = validate()
    setErrors(found)
    setFailure(null)
    if (found.length || !f.slot) return
    setBusy(true)
    try {
      setBooked(
        existing
          ? await api.rescheduleAppointment(existing.id, { startAt: f.slot.startAt, ...(f.providerId !== existing.provider.id ? { providerId: f.providerId } : {}) }, key)
          : await api.bookAppointment(
              { facilityId: f.facilityId, appointmentTypeId: f.appointmentTypeId, providerId: f.providerId, startAt: f.slot.startAt, reasonForVisit: f.reason },
              key,
            ),
      )
      window.scrollTo({ top: 0 })
    } catch (error) {
      const p = toProblem(error)
      if (p.code === 'booking-conflict') {
        set({ slot: null })
        setSlotsVersion((v) => v + 1)
        setFailure('That time was just taken. Please choose another time for your appointment.')
      } else setFailure(problemCopy(p).message)
    } finally {
      setBusy(false)
    }
  }

  if (booked) {
    return (
      <div className="max-w-2xl">
        <Alert tone="success" title={`Appointment is ${existing ? 'rescheduled' : 'scheduled'} successfully on ${formatLongDay(booked.startAt, booked.timeZone)} at ${formatTime(booked.startAt, booked.timeZone)}.`}>
          {booked.provider.displayName}, {booked.telehealth ? 'video visit' : booked.facility.name}.
        </Alert>
        <Button className="mt-4" onClick={() => navigate('/appointments')}>
          OK
        </Button>
      </div>
    )
  }

  return (
    <form noValidate onSubmit={submit} className="max-w-3xl space-y-5 rounded-2xl border border-(--accent-line) bg-surface-1 p-5 shadow-card sm:p-6">
      <Alert tone="warning" title="If this is a medical emergency, hang up and call 911 or go to the nearest hospital.">
        Appointments requested here are for routine visits. To schedule a different kind of visit, please call the clinic.
      </Alert>
      <ErrorSummary errors={errors} />
      {failure ? <Alert tone="critical" title="Not scheduled">{failure}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="sc-facility" label="Select a location" required error={err('sc-facility')} {...(existing ? { hint: 'To change the location, cancel and book a new appointment' } : {})}>
          {(p) => (
            <Select {...p} disabled={Boolean(existing)} value={f.facilityId} onChange={(e) => set({ facilityId: e.target.value, appointmentTypeId: '', providerId: '', slot: null })}>
              <option value="">Select an option</option>
              {facilities.map((fa) => (
                <option key={fa.id} value={fa.id}>
                  {fa.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="sc-type" label="Select appointment type" {...(f.facilityId ? {} : { hint: 'Select a location first' })} required error={err('sc-type')}>
          {(p) => (
            <Select {...p} disabled={Boolean(existing) || !f.facilityId || types.status !== 'ready'} value={f.appointmentTypeId} onChange={(e) => set({ appointmentTypeId: e.target.value, providerId: '', slot: null })}>
              <option value="">{types.status === 'loading' && f.facilityId ? 'Loading appointment types…' : 'Select an option'}</option>
              {types.status === 'ready'
                ? types.data.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.durationMinutes} min{t.telehealth ? ', video' : ''})
                    </option>
                  ))
                : existing ? <option value={existing.appointmentType.id}>{existing.appointmentType.name}</option> : null}
            </Select>
          )}
        </Field>
        <Field id="sc-reason" label="Select reason for visit" required error={err('sc-reason')}>
          {(p) => (
            <Select {...p} disabled={Boolean(existing)} value={f.reason} onChange={(e) => set({ reason: e.target.value })}>
              <option value="">Select an option</option>
              {[...REASONS, ...(f.reason && !REASONS.includes(f.reason) ? [f.reason] : [])].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="sc-provider" label="Your providers" {...(f.appointmentTypeId ? {} : { hint: 'Select an appointment type first' })} required error={err('sc-provider')}>
          {(p) => (
            <Select {...p} disabled={!f.appointmentTypeId || providers.status !== 'ready'} value={f.providerId} onChange={(e) => set({ providerId: e.target.value, slot: null })}>
              <option value="">{providers.status === 'loading' && f.appointmentTypeId ? 'Loading providers…' : 'Select an option'}</option>
              {providers.status === 'ready'
                ? providers.data.map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.displayName}
                      {pr.specialty ? `, ${pr.specialty}` : ''}
                    </option>
                  ))
                : null}
            </Select>
          )}
        </Field>
        <Field id="sc-date" label="Appointment preferred date" hint={`MM/DD/YYYY, up to ${formatDate(lastDay)}`} required error={err('sc-date')}>
          {(p) => <DateInput {...p} value={f.date ?? ''} onValueChange={(v) => set({ date: v, slot: null })} />}
        </Field>
        <Field id="sc-time" label="Preferred time" {...(canPickTime ? {} : { hint: 'Select a location, type, provider and date first' })} required error={err('sc-time')}>
          {(p) => (
            <button
              {...p}
              // aria-required is not valid on a button; the label already says "(required)".
              aria-required={undefined}
              type="button"
              disabled={!canPickTime}
              onClick={() => setPicking(true)}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-border bg-surface-1 px-3.5 text-left text-sm text-ink hover:border-border-strong disabled:opacity-60 aria-invalid:border-critical-fg"
            >
              <Clock aria-hidden="true" size={16} className="text-ink-subtle" />
              {f.slot ? formatTime(f.slot.startAt, tz) : 'Time'}
            </button>
          )}
        </Field>
      </div>

      <p className="text-sm text-ink-muted">
        {type ? `This visit takes ${type.durationMinutes} minutes. ` : ''}Please fill in all required fields and select Schedule to request your appointment.
      </p>
      <div className="flex flex-col-reverse gap-3 border-t border-border-soft pt-5 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => navigate(existing ? `/appointments/${existing.id}` : '/appointments')}>
          Cancel
        </Button>
        <Button type="submit" size="lg" loading={busy}>
          Schedule
        </Button>
      </div>

      {picking && f.date ? (
        <SlotPicker
          date={f.date}
          facilityId={f.facilityId}
          appointmentTypeId={f.appointmentTypeId}
          providerId={f.providerId}
          version={slotsVersion}
          timeZone={tz}
          selected={f.slot}
          onPick={(s) => {
            set({ slot: s })
            setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </form>
  )
}

/** The old "Select preferred timing" overlay: Morning (AM) and Afternoon (PM) time buttons. */
function SlotPicker({
  date,
  facilityId,
  appointmentTypeId,
  providerId,
  version,
  timeZone,
  selected,
  onPick,
  onClose,
}: {
  date: string
  facilityId: string
  appointmentTypeId: string
  providerId: string
  version: number
  timeZone: string
  selected: PortalSlot | null
  onPick: (s: PortalSlot) => void
  onClose: () => void
}) {
  const api = usePortalApi()
  const slots = useResource(() => api.listSlots({ date, facilityId, appointmentTypeId, providerId }), [date, facilityId, appointmentTypeId, providerId, version])
  const heading = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: '2-digit', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`))
  return (
    <Modal open size="lg" title="Select preferred timing" onClose={onClose}>
      <p className="mb-4 font-medium text-ink">{heading}</p>
      {slots.status === 'loading' ? (
        <Spinner label="Finding open times" />
      ) : (
        <AsyncPanel resource={slots} label="open times">
          {(open) => {
            if (!open.length) return <EmptyState title="No slots available" description="Try another date." />
            const hour = (s: PortalSlot) => Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(new Date(s.startAt)))
            const groups = [
              { title: 'Morning (AM)', items: open.filter((s) => hour(s) < 12) },
              { title: 'Afternoon (PM)', items: open.filter((s) => hour(s) >= 12) },
            ]
            return (
              <div className="space-y-5">
                {groups.map((g) => (
                  <section key={g.title} aria-label={g.title}>
                    <h3 className="mb-2 text-sm font-semibold text-ink">{g.title}</h3>
                    {g.items.length ? (
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                        {g.items.map((s) => {
                          const on = selected?.startAt === s.startAt
                          return (
                            <button
                              key={s.startAt}
                              type="button"
                              aria-pressed={on}
                              onClick={() => onPick(s)}
                              className={cn('min-h-11 rounded-lg border px-2 text-sm font-semibold', on ? 'border-primary-600 bg-primary-600 text-on-primary' : 'border-border bg-surface-1 text-ink hover:border-primary-500')}
                            >
                              {formatTime(s.startAt, timeZone, { withZone: false })}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-ink-muted">No slots available.</p>
                    )}
                  </section>
                ))}
              </div>
            )
          }}
        </AsyncPanel>
      )}
    </Modal>
  )
}

import { Clock } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Alert, Button, DateInput, EmptyState, Field, formatDate, formatTime, Modal, problemCopy, Select, Spinner, todayIn } from '../../../../design-system'
import { cn } from '../../../../design-system/lib/cn'
import { usePortalApi } from '../../api/portalApi'
import type { Appointment, AppointmentCategory, Facility, ReminderPreference, Slot } from '../../api/types'
import { toProblem, useResource } from '../../api/useResource'
import { useRouter } from '../../router'
import { AsyncPanel, ErrorSummary, formatLongDay, PageHeader } from '../../ui'

/*
 * The old "Schedule an appointment" page: one form with the old fields in the old order, and a
 * "Preferred time" box that opens the morning/afternoon slot picker. Two fixes: the old "Select a
 * specialty" list was really the clinic location, and "Reminder preferences" listed appointment
 * statuses; here they are labelled and filled correctly.
 */

const REASONS = ['New Medical Problem Visit', 'Medical Problem Followup Visit', 'Annual Physical', 'Well child checkup', 'Others']
const DURATIONS = [15, 30, 45, 60] as const
const REMINDERS: Array<{ id: ReminderPreference; label: string }> = [
  { id: 'text', label: 'Text message' },
  { id: 'email', label: 'Email' },
  { id: 'phone', label: 'Phone call' },
]

interface Form {
  facilityId: string
  categoryId: string
  reason: string
  providerId: string
  date: string | null
  slot: Slot | null
  duration: '' | (typeof DURATIONS)[number]
  reminder: '' | ReminderPreference
}

export function SchedulePage({ rescheduleId }: { rescheduleId?: string }) {
  const api = usePortalApi()
  const refs = useResource(() => Promise.all([api.listFacilities(), api.listCategories(), rescheduleId ? api.getAppointment(rescheduleId) : Promise.resolve(null)]), [rescheduleId])
  return (
    <>
      <PageHeader
        title={rescheduleId ? 'Reschedule an appointment' : 'Schedule an appointment'}
        back={rescheduleId ? { to: `/appointments/${rescheduleId}`, label: 'Upcoming Visit Details' } : { to: '/appointments', label: 'My Appointments' }}
      />
      <AsyncPanel resource={refs} label="scheduling options">
        {([facilities, categories, existing]) => <ScheduleForm facilities={facilities} categories={categories} existing={existing} />}
      </AsyncPanel>
    </>
  )
}

function ScheduleForm({ facilities, categories, existing }: { facilities: Facility[]; categories: AppointmentCategory[]; existing: Appointment | null }) {
  const api = usePortalApi()
  const { navigate } = useRouter()
  const tz = facilities[0]?.timeZone ?? 'America/Chicago'
  // When the form opened; the bookable window is today plus 30 days.
  const [openedAt] = useState(() => Date.now())
  const today = todayIn(tz, new Date(openedAt))
  const lastDay = todayIn(tz, new Date(openedAt + 30 * 86_400_000))
  const existingMinutes = existing ? Math.round((Date.parse(existing.endAt) - Date.parse(existing.startAt)) / 60000) : 0
  const [f, setF] = useState<Form>({
    facilityId: existing?.facility.id ?? '',
    categoryId: existing?.category.id ?? '',
    reason: existing?.reason ?? '',
    providerId: existing?.provider.id ?? '',
    date: existing ? todayIn(tz, new Date(existing.startAt)) : '',
    slot: null,
    duration: (DURATIONS as readonly number[]).includes(existingMinutes) ? (existingMinutes as Form['duration']) : '',
    reminder: existing?.reminder ?? '',
  })
  const providers = useResource(() => (f.facilityId ? api.listProviders(f.facilityId) : Promise.resolve([])), [f.facilityId])
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([])
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [booked, setBooked] = useState<Appointment | null>(null)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))
  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message
  const canPickTime = Boolean(f.facilityId && f.providerId && f.date && f.date >= today && f.date <= lastDay)

  function validate() {
    const found: typeof errors = []
    if (!f.facilityId) found.push({ fieldId: 'sc-facility', message: 'Select a location' })
    if (!f.categoryId) found.push({ fieldId: 'sc-type', message: 'Select an appointment type' })
    if (!f.reason) found.push({ fieldId: 'sc-reason', message: 'Select a reason for visit' })
    if (!f.providerId) found.push({ fieldId: 'sc-provider', message: 'Select a provider' })
    if (!f.date) found.push({ fieldId: 'sc-date', message: 'Enter a valid date as MM/DD/YYYY' })
    else if (f.date < today || f.date > lastDay) found.push({ fieldId: 'sc-date', message: `Choose a date from ${formatDate(today)} to ${formatDate(lastDay)}` })
    if (!f.slot) found.push({ fieldId: 'sc-time', message: 'Select a preferred time' })
    if (!f.duration) found.push({ fieldId: 'sc-duration', message: 'Select a duration' })
    if (!f.reminder) found.push({ fieldId: 'sc-reminder', message: 'Select a reminder preference' })
    return found
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const found = validate()
    setErrors(found)
    setFailure(null)
    if (found.length || !f.slot || !f.duration || !f.reminder) return
    setBusy(true)
    const request = { facilityId: f.facilityId, categoryId: f.categoryId, reason: f.reason, providerId: f.providerId, startAt: f.slot.startAt, durationMinutes: f.duration, reminder: f.reminder }
    try {
      setBooked(existing ? await api.rescheduleAppointment(existing.id, request) : await api.bookAppointment(request))
      window.scrollTo({ top: 0 })
    } catch (error) {
      const p = toProblem(error)
      if (p.code === 'booking-conflict') {
        set('slot', null)
        setFailure('The time slot is not available right now. Please choose another time for your appointment.')
      } else setFailure(problemCopy(p).message)
    } finally {
      setBusy(false)
    }
  }

  if (booked) {
    return (
      <div className="max-w-2xl">
        <Alert tone="success" title={`Appointment is ${existing ? 'rescheduled' : 'scheduled'} successfully on ${formatLongDay(booked.startAt, tz)} at ${formatTime(booked.startAt, tz)}.`}>
          {booked.provider.displayName}, {booked.mode === 'video' ? 'video visit' : booked.facility.displayName}.
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
        <Field id="sc-facility" label="Select a location" required error={err('sc-facility')}>
          {(p) => (
            <Select {...p} value={f.facilityId} onChange={(e) => setF((x) => ({ ...x, facilityId: e.target.value, providerId: '', slot: null }))}>
              <option value="">Select an option</option>
              {facilities.map((fa) => (
                <option key={fa.id} value={fa.id}>
                  {fa.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="sc-type" label="Select appointment type" required error={err('sc-type')}>
          {(p) => (
            <Select {...p} value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              <option value="">Select an option</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="sc-reason" label="Select reason for visit" required error={err('sc-reason')}>
          {(p) => (
            <Select {...p} value={f.reason} onChange={(e) => set('reason', e.target.value)}>
              <option value="">Select an option</option>
              {REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="sc-provider" label="Your providers" {...(f.facilityId ? {} : { hint: 'Select a location first' })} required error={err('sc-provider')}>
          {(p) => (
            <Select {...p} disabled={!f.facilityId || providers.status !== 'ready'} value={f.providerId} onChange={(e) => setF((x) => ({ ...x, providerId: e.target.value, slot: null }))}>
              <option value="">{providers.status === 'loading' && f.facilityId ? 'Loading providers…' : 'Select an option'}</option>
              {providers.status === 'ready'
                ? providers.data.map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.displayName}
                    </option>
                  ))
                : null}
            </Select>
          )}
        </Field>
        <Field id="sc-date" label="Appointment preferred date" hint={`MM/DD/YYYY, up to ${formatDate(lastDay)}`} required error={err('sc-date')}>
          {(p) => <DateInput {...p} value={f.date ?? ''} onValueChange={(v) => setF((x) => ({ ...x, date: v, slot: null }))} />}
        </Field>
        <Field id="sc-time" label="Preferred time" {...(canPickTime ? {} : { hint: 'Select a location, provider and date first' })} required error={err('sc-time')}>
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
        <Field id="sc-duration" label="Duration (minutes)" required error={err('sc-duration')}>
          {(p) => (
            <Select {...p} value={f.duration} onChange={(e) => setF((x) => ({ ...x, duration: Number(e.target.value) as Form['duration'], slot: null }))}>
              <option value="">Minutes</option>
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="sc-reminder" label="Reminder preferences" required error={err('sc-reminder')}>
          {(p) => (
            <Select {...p} value={f.reminder} onChange={(e) => set('reminder', e.target.value as ReminderPreference)}>
              <option value="">Select an option</option>
              {REMINDERS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <p className="text-sm text-ink-muted">
        Please fill in all required fields and select Schedule to request your appointment. Video visits need a phone, tablet or computer with a camera and a good internet connection.
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
          providerId={f.providerId}
          duration={f.duration || 15}
          timeZone={tz}
          selected={f.slot}
          onPick={(s) => {
            set('slot', s)
            setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </form>
  )
}

/** The old "Select preferred timing" overlay: Morning (AM) and Afternoon (PM) time buttons. */
function SlotPicker({ date, facilityId, providerId, duration, timeZone, selected, onPick, onClose }: { date: string; facilityId: string; providerId: string; duration: number; timeZone: string; selected: Slot | null; onPick: (s: Slot) => void; onClose: () => void }) {
  const api = usePortalApi()
  const slots = useResource(() => api.findSlots({ date, facilityId, providerId, durationMinutes: duration }), [date, facilityId, providerId, duration])
  const heading = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: '2-digit', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`))
  return (
    <Modal open size="lg" title="Select preferred timing" onClose={onClose}>
      <p className="mb-4 font-medium text-ink">{heading}</p>
      {slots.status === 'loading' ? (
        <Spinner label="Finding open times" />
      ) : (
        <AsyncPanel resource={slots} label="open times">
          {(list) => {
            if (!list.length) return <EmptyState title="No slots available" description="Try another date." />
            const hour = (s: Slot) => Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(new Date(s.startAt)))
            const groups = [
              { title: 'Morning (AM)', items: list.filter((s) => hour(s) < 12) },
              { title: 'Afternoon (PM)', items: list.filter((s) => hour(s) >= 12) },
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

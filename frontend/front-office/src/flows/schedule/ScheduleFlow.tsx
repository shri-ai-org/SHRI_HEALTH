import { useState } from 'react'
import { ArrowRight, Building2, CalendarPlus, Video } from 'lucide-react'
import { FlowSheet } from '../../components/flow/FlowSheet'
import { PatientSearch } from '../../components/patient/PatientSearch'
import { DoctorSlotCard } from '../../components/clinician/DoctorSlotCard'
import { DepartmentChips } from '../../components/clinician/DepartmentChips'
import { SharedDayHeader } from '../../components/clinician/SharedDayHeader'
import { AppointmentWhen } from '../../components/appointment/AppointmentSummary'
import { Alert } from '../../components/ui/Alert'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStoreValue } from '../../hooks/useStore'
import { useNow } from '../../hooks/useNow'
import { getState } from '../../domain/store'
import {
  getAvailableSlots,
  getConsultationBillItems,
  getDepartmentSummaries,
  getDoctorSuggestions,
  getPatientById,
  getProviderById,
  getToday,
} from '../../domain/selectors'
import { bookAppointment, rebookUnpaidAppointment } from '../../domain/actions'
import { formatRupees, sumItems } from '../../utils/billing'
import { dayWithDate, relativeDayLabel } from '../../utils/dates'
import { modesFor } from '../../utils/appointment'
import { cn } from '../../utils/cn'
import { Quadrant, StepRail } from '../../components/flow/Quadrant'
import type { FlowProps } from '../registry'
import type { Patient } from '../../types/patient'
import type { ConsultMode } from '../../types/appointment'
import type { Provider } from '../../types/doctor'
import type { AppState } from '../../types/store'
import { inputClass } from '../../utils/formClasses'
import { dayStartTimestamp, formatTime } from '../../domain/time'
import { getDepartmentDateStrip, getDepartmentDayRange } from '../../domain/doctorDaySelectors'

/** A doctor and a time, chosen together. */
interface Pick {
  providerId: string
  date: string
  slot: string
}

/**
 * Schedule — booking an appointment: patient → department → Doctor
 * Availability (each of the department's doctors with their own times, in
 * one list) → book; the patient pays at the billing counter.
 * Once the patient and department are known, the soonest doctor's earliest
 * time is chosen as a smart choice, said so, and changeable with one tap.
 * Every step stays editable. (`?flow=consult`, the old Start Consultation,
 * opens it too.)
 */
export function ScheduleFlow(props: FlowProps) {
  return <AppointmentFlow {...props} />
}

/** The smart choice: the department's soonest doctor at their earliest free
 *  time — or, with `providerId`, that doctor's earliest free time. */
function soonestPick(state: AppState, department: string, now: number, providerId?: string): Pick | null {
  const doctor = getDoctorSuggestions(state, department, now).find((s) => s.bookable && (!providerId || s.provider.providerId === providerId))
  const next = doctor?.nextSlots[0]
  return doctor && next ? { providerId: doctor.provider.providerId, date: next.date, slot: next.slot } : null
}

interface Start {
  department: string | null
  providerId: string | null
  date: string | null
  slot: string | null
  mode: ConsultMode
  /** The start was a smart choice, not the opening page's. */
  smart: boolean
}

/** What the page that opened the flow already settled. A doctor page names
 *  the doctor, and a slot is kept only when the page named one and it is
 *  still free. With the patient known, whatever is still open is filled in
 *  as a smart choice. */
/** Every booking opens in General Medicine — the first stop — with its doctors' times open. */
const DEFAULT_DEPARTMENT = 'General Medicine'
function defaultDepartment(state: AppState, patientId: string): string | null {
  return patientId && state.patients.some((p) => p.patientId === patientId) ? DEFAULT_DEPARTMENT : null
}

/** The doctor a returning patient was last with — their latest visit or booking (a cancelled one aside),
 *  while that doctor still takes bookings. */
function lastVisitedDoctor(state: AppState, patientId: string): Provider | null {
  const seen = [
    ...state.visits.filter((v) => v.patientId === patientId).map((v) => ({ at: v.arrivalTime, providerId: v.providerId })),
    ...state.appointments
      .filter((a) => a.patientId === patientId && a.status !== 'Cancelled')
      .map((a) => ({ at: Math.max(a.createdAt, slotTimestampOf(a.date, a.slot)), providerId: a.providerId })),
  ].sort((x, y) => y.at - x.at)
  const doctor = seen[0] ? getProviderById(state, seen[0].providerId) : null
  return doctor && doctor.status === 'Active' ? doctor : null
}

/** A booking's time as a timestamp, to order it among visits. */
function slotTimestampOf(date: string, slot: string): number {
  const [h, m] = slot.split(':').map(Number)
  return dayStartTimestamp(date) + (h * 60 + m) * 60000
}

function startFrom(params: FlowProps['params'], now: number): Start {
  const state = getState()
  // A doctor named by the page; else, for a returning patient, the doctor they saw last.
  const doctor = params.doctor ? getProviderById(state, params.doctor) : params.uhid ? lastVisitedDoctor(state, params.uhid) : null
  const usable = doctor && doctor.status === 'Active' ? doctor : null
  const department = usable?.department ?? params.dept ?? (params.uhid ? defaultDepartment(state, params.uhid) : null)
  const named = Boolean(usable && params.date && params.slot && getAvailableSlots(state, usable.providerId, now, params.date).includes(params.slot))
  if (usable && named) {
    return { department, providerId: usable.providerId, date: params.date!, slot: params.slot!, mode: modesFor(usable)[0], smart: false }
  }
  const pick = params.uhid && department ? soonestPick(state, department, now, usable?.providerId) : null
  const chosen = pick ? getProviderById(state, pick.providerId) : usable
  return {
    department,
    providerId: pick?.providerId ?? usable?.providerId ?? null,
    date: pick?.date ?? null,
    slot: pick?.slot ?? null,
    mode: chosen ? modesFor(chosen)[0] : 'In person',
    smart: Boolean(pick),
  }
}

function AppointmentFlow({ params, onClose }: FlowProps) {
  const now = useNow(15000)
  const today = useStoreValue(getToday)

  const [patientId, setPatientId] = useState(params.uhid ?? '')
  const patient = useStoreValue(getPatientById, patientId)
  const [start] = useState(() => startFrom(params, now))
  const [department, setDepartment] = useState(start.department)
  const [providerId, setProviderId] = useState(start.providerId)
  const [date, setDate] = useState(start.date)
  const [slot, setSlot] = useState(start.slot)
  const [consultMode, setConsultMode] = useState<ConsultMode>(start.mode)
  const [reason, setReason] = useState('')
  const [showReason, setShowReason] = useState(false)
  const [changingPatient, setChangingPatient] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Opened on a time already chosen on a doctor's chart: only the patient is left to choose.
  const [patientOnly, setPatientOnly] = useState(() => Boolean(params.doctor && !params.uhid && start.providerId && start.slot && !start.smart))
  // The day every doctor's row shows — one date for the whole list.
  const [dayChoice, setDayChoice] = useState<string | null>(null)
  // The smart choice on show — cleared the moment the desk picks another.
  const [smart, setSmart] = useState<Pick | null>(() => (start.smart && start.providerId && start.date && start.slot ? { providerId: start.providerId, date: start.date, slot: start.slot } : null))
  const navigate = useNavigate()
  const location = useLocation()

  const departments = useStoreValue(getDepartmentSummaries, now)
  const provider = useStoreValue(getProviderById, providerId ?? '')
  const suggestions = useStoreValue(getDoctorSuggestions, department ?? '', now)
  const departmentDays = useStoreValue(getDepartmentDateStrip, department ?? '', now)
  const listDay = dayChoice ?? date ?? departmentDays.find((d) => d.open > 0)?.date ?? today
  const listRange = useStoreValue(getDepartmentDayRange, department ?? '', now, listDay)
  const billItems = useStoreValue(getConsultationBillItems, patientId, providerId ?? '')
  const total = sumItems(billItems)
  const modes = provider ? modesFor(provider) : (['In person'] as ConsultMode[])

  const ready = Boolean(patient && department && provider && date && slot) && billItems.length > 0

  /** Choose a doctor and a time together. `viaSmart` marks the smart choice,
   *  so its note shows; any pick by hand clears it. */
  function applyPick(pick: Pick, viaSmart: boolean) {
    setError(null)
    if (pick.providerId !== providerId) {
      const chosen = getProviderById(getState(), pick.providerId)
      setProviderId(pick.providerId)
      setConsultMode(chosen ? modesFor(chosen)[0] : 'In person')
    }
    setDate(pick.date)
    setSlot(pick.slot)
    setSmart(viaSmart ? pick : null)
  }

  /** With the patient and the department known and no time chosen yet, take
   *  the soonest doctor's earliest free time — or, when a doctor is already
   *  named (opened from their page), that doctor's. */
  function pickSoonest(dep: string, doctorId?: string) {
    const pick = soonestPick(getState(), dep, now, doctorId)
    if (pick) applyPick(pick, true)
  }

  function choosePatient(next: Patient) {
    setPatientId(next.patientId)
    setChangingPatient(false)
    // Nothing chosen yet: General Medicine, its doctors' times open.
    // Nothing chosen yet: the doctor they saw last (and that doctor's department), else General Medicine.
    if (!department) {
      const last = lastVisitedDoctor(getState(), next.patientId)
      const usual = last?.department ?? defaultDepartment(getState(), next.patientId)
      if (usual) {
        setDepartment(usual)
        pickSoonest(usual, last?.providerId)
        return
      }
    }
    // A time the desk already chose on the doctor's page is booked for this patient.
    if (providerId && date && slot && !smart) {
      bookPick(next, { providerId, date, slot })
      return
    }
    if (!department) reveal('book-department')
    else if (!slot) {
      pickSoonest(department, providerId ?? undefined)
      reveal('book-availability')
    }
  }

  /** On a stacked layout (below 1024px), bring the next step into view once a
   *  choice is made, so nobody has to hunt for it. Wide layouts show every
   *  step side by side already. */
  function reveal(id: string) {
    if (window.matchMedia('(min-width: 64rem)').matches) return
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
  }

  // A department shows its doctors; with the patient known, the soonest of
  // them is chosen at their earliest time.
  function chooseDepartment(next: string) {
    setError(null)
    if (next !== department) {
      setDayChoice(null)
      setDepartment(next)
      setProviderId(null)
      setDate(null)
      setSlot(null)
      setSmart(null)
      if (patient) pickSoonest(next)
    }
    reveal('book-availability')
  }

  // Only a time that is still free can be chosen — the cards disable the
  // rest, and this guards against a time taken since they were drawn.
  function pickTime(nextProvider: string, nextDate: string, nextSlot: string) {
    if (!getAvailableSlots(getState(), nextProvider, now, nextDate).includes(nextSlot)) {
      setError(`${formatTime(nextSlot)} has just been taken or has passed — choose another time.`)
      if (nextProvider === providerId && nextDate === date && nextSlot === slot) setSlot(null)
      return
    }
    // Tapping a free time books it for the patient straight away.
    if (patient) bookPick(patient, { providerId: nextProvider, date: nextDate, slot: nextSlot })
    else applyPick({ providerId: nextProvider, date: nextDate, slot: nextSlot }, false)
  }

  // Booking holds the time and raises the bill. The bill is printed from the
  // patient's timeline and paid at the billing counter — Care Entry takes
  // no money — and the booking is only confirmed once that payment is recorded.
  // Unpaid after five minutes, the time is released (see PaymentHoldSweeper).
  function bookPick(who: Patient, pick: Pick) {
    const doctor = getProviderById(getState(), pick.providerId)
    if (!doctor) return
    setError(null)
    try {
      const mode = pick.providerId === providerId ? consultMode : (modesFor(doctor)[0] ?? 'In person')
      const booking = { providerId: doctor.providerId, date: pick.date, slot: pick.slot, mode, reason: reason.trim() || undefined }
      // Rescheduling an unpaid booking from the timeline: the old booking and its bill are removed, not
      // cancelled, so only the new time is seen anywhere. One save — if the new time can't be booked, nothing changes.
      if (params.appointment) rebookUnpaidAppointment({ appointmentId: params.appointment, ...booking })
      else bookAppointment({ patientId: who.patientId, ...booking })
      // Booked: straight to the patient's profile, where the timeline shows the booking and prints its bill.
      const profile = `/patients/${who.uhid}`
      if (location.pathname === profile) onClose()
      else navigate(profile, { replace: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      // A slot taken a moment ago: reopen the times so another can be picked.
      if (/slot/i.test(message)) setSlot(null)
    }
  }

  // The patient is named once, on the page itself — the title says what is left to do.
  // Patient and department both chosen: they shrink to one strip, and the doctors get the screen.
  const compact = Boolean(patient && department && !changingPatient)

  // ---------------------------------------------------------------- one page
  const timeSummary =
    provider && date && slot ? `${provider.name} · ${relativeDayLabel(date, today)} ${formatTime(slot)}${consultMode === 'Teleconsult' ? ' · Teleconsult' : ''}` : undefined
  const soonestId = suggestions.find((s) => s.bookable)?.provider.providerId ?? null
  const showPatientSearch = !patient || changingPatient

  // The first thing still to do — highlighted, and named in the review bar.
  const steps = [
    { label: 'Patient', done: Boolean(patient), target: 'book-patient', next: 'choose the patient' },
    { label: 'Department', done: Boolean(department), target: 'book-department', next: 'choose a department' },
    { label: 'Doctor & time', done: Boolean(provider && date && slot), target: 'book-availability', next: 'choose a doctor and a time' },
  ]
  const currentIndex = steps.findIndex((step) => !step.done)
  const rail = steps.map((step, index) => ({ ...step, current: index === currentIndex }))

  const confirmBar = (
    <div className="flex flex-col gap-2.5">
      {error ? <Alert tone="critical" live>{error}</Alert> : null}
      <div className="grid grid-cols-1 items-center gap-3 xl:grid-cols-[minmax(0,1fr)_15rem_auto]">
        {/* Review — the booking as one sentence, or the next thing to do. */}
        <div className="min-w-0" aria-live="polite">
          {ready && patient && provider && date && slot ? (
            <p className="text-sm leading-relaxed text-ink-muted max-sm:line-clamp-2 max-sm:text-xs">
              <span className="font-semibold text-ink">{patient.name}</span> with <span className="font-semibold text-ink">{provider.name}</span>{' '}
              <span className="whitespace-nowrap">({department})</span> ·{' '}
              <span className="whitespace-nowrap font-semibold text-ink">
                {dayWithDate(date, today)}, {formatTime(slot)}
              </span>{' '}
              · {consultMode === 'Teleconsult' ? 'Teleconsult' : provider.room ?? 'In person'}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-ink-muted">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-text">
                <ArrowRight size={14} aria-hidden="true" />
              </span>
              <span>
                <span className="font-semibold text-ink">{(steps[currentIndex]?.next ?? 'confirm').replace(/^./, (c) => c.toUpperCase())}</span>
                <span className="hidden sm:inline"> — {steps.filter((step) => step.done).length} of 3 chosen</span>
              </span>
            </p>
          )}
        </div>
        {/* The optional reason — a link until it is wanted, so it never
            crowds the bar. */}
        {showReason || reason ? (
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason for the visit (optional)"
            aria-label="Reason for the visit (optional)"
            maxLength={120}
            autoFocus={showReason && !reason}
            className={inputClass}
          />
        ) : ready ? (
          <button
            type="button"
            onClick={() => setShowReason(true)}
            className="focus-ring inline-flex min-h-9 items-center gap-1 self-start justify-self-start rounded-lg px-1 text-sm font-semibold text-primary-text hover:underline xl:justify-self-end"
          >
            + Add a reason <span className="font-normal text-ink-subtle">(optional)</span>
          </button>
        ) : (
          <span className="hidden xl:block" aria-hidden="true" />
        )}
        <div className="flex items-center justify-between gap-3 xl:justify-end">
          <div className="min-w-0 flex-1 text-left xl:flex-none xl:text-right">
            <p className="hidden max-w-[16rem] truncate text-xs text-ink-muted sm:block" title={billItems.map((i) => `${i.description} ${formatRupees(i.amount)}`).join(' + ')}>
              {billItems.length ? billItems.map((i) => i.description).join(' + ') : 'Bill total'}
            </p>
            <p className="text-lg font-bold tabular-nums tracking-tight text-ink">{formatRupees(total)}</p>
          </div>
        </div>
      </div>
    </div>
  )

  // The doctor and the time were chosen on the Doctors page: just the patient, then it is booked.
  if (patientOnly && provider && date && slot && !patient) {
    return (
      <FlowSheet title="Schedule Appointment" icon={CalendarPlus} onClose={onClose} size="full">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 py-2 sm:py-6">
          <AppointmentWhen provider={provider} date={date} slot={slot} mode={consultMode} today={today} />
          <div className="flex items-center justify-between gap-3 px-1 text-sm">
            <span className="min-w-0 truncate text-ink">
              <span className="font-semibold">{provider.name}</span> · {provider.department} · {formatRupees(total)}
            </span>
            <button type="button" onClick={() => setPatientOnly(false)} className="focus-ring shrink-0 rounded text-xs font-semibold text-primary-text hover:underline">
              Change doctor or time
            </button>
          </div>
          <section aria-label="Patient" className="flex flex-col gap-2 rounded-2xl border border-border-soft bg-surface-1 p-4 shadow-card-sm">
            <h3 className="text-sm font-semibold text-ink">Patient</h3>
            <PatientSearch mode="pick" inline onPick={choosePatient} autoFocus placeholder="Search for the patient by name, mobile, UHID or ABHA" />
          </section>
          {error ? <Alert tone="critical" live>{error}</Alert> : null}
        </div>
      </FlowSheet>
    )
  }

  return (
    <FlowSheet title="Schedule Appointment" icon={CalendarPlus} onClose={onClose} size="full" footer={confirmBar}>
      {/* One left-to-right progression — who, then which doctor, then when.
          From 1024px the date & time take the right half of the screen and the
          choices that lead to it share the left half (≥1280px: patient and
          department, then the doctors, as two columns that each scroll on their
          own — the sheet itself never does). Narrower: one column, same order. */}
      <div className="flex flex-col xl:h-full">
      <StepRail steps={rail} />
      <div className="grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)] lg:grid-rows-[auto_minmax(0,1fr)] xl:min-h-0 xl:flex-1">
        {compact && patient ? (
          // One strip across the top: who, and which department — each changeable in place.
          <section
            aria-label="Patient and department"
            className="surface-raised flex flex-col gap-2.5 rounded-xl border border-border-soft bg-surface-1 px-3.5 py-2.5 sm:px-4 lg:col-span-2 lg:row-start-1 xl:flex-row xl:items-center xl:gap-4"
          >
            <div className="flex min-w-0 items-center gap-2.5 xl:shrink-0">
              <span className="text-2xs font-semibold uppercase tracking-wide text-ink-subtle">Patient</span>
              <span className="min-w-0 truncate text-sm text-ink" title={patient.name}>
                <span className="font-semibold">{patient.name}</span>
                <span className="text-ink-muted">
                  {' '}
                  · <span className="tabular-nums">{patient.uhid}</span>
                  {patient.age ? ` · ${patient.age} ${patient.sex.charAt(0)}` : ''}
                </span>
              </span>
            </div>
            <span aria-hidden="true" className="hidden h-6 w-px bg-border-soft xl:block" />
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <DepartmentChips departments={departments.map((d) => d.department)} selected={department} onChoose={chooseDepartment} />
            </div>
          </section>
        ) : (
          <>
        {/* Top-left · Patient */}
        <Quadrant id="book-patient" step={1} title="Patient" done={Boolean(patient)} current={currentIndex === 0} scrollFrom="xl" className="lg:col-span-2 lg:row-start-1">
          {showPatientSearch ? (
            <div className="flex flex-col gap-2">
              <PatientSearch mode="pick" inline onPick={choosePatient} autoFocus placeholder="Search for the patient by name, mobile, UHID or ABHA" />
              {patient ? (
                <button type="button" onClick={() => setChangingPatient(false)} className="self-start text-xs font-semibold text-primary-text hover:underline">
                  Keep {patient.name}
                </button>
              ) : null}
            </div>
          ) : patient ? (
            <div className="rounded-xl border border-primary-200 bg-primary-50 px-3.5 py-3 dark:border-primary-500/35">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 truncate text-base font-semibold text-ink" title={patient.name}>
                  {patient.name}
                </p>
              </div>
              <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-ink-subtle">UHID</dt>
                <dd className="truncate font-medium tabular-nums text-ink">{patient.uhid}</dd>
                <dt className="text-ink-subtle">Age · sex</dt>
                <dd className="truncate text-ink">{patient.age ? `${patient.age} · ${patient.sex}` : patient.sex}</dd>
                {patient.mobile ? (
                  <>
                    <dt className="text-ink-subtle">Mobile</dt>
                    <dd className="truncate tabular-nums text-ink">{patient.mobile}</dd>
                  </>
                ) : null}
              </dl>
            </div>
          ) : null}
        </Quadrant>


          </>
        )}

        {/* Right · Doctor's Availability — each doctor with their own times. */}
        <Quadrant
          id="book-availability"
          step={3}
          title="Doctor's Availability"
          done={Boolean(provider && date && slot)}
          current={currentIndex === 2}
          summary={timeSummary}
          scrollFrom="xl"
          className="lg:col-span-2 lg:row-start-2"
        >
          {!department ? null : (
            <div className="flex flex-col gap-3">
              {/* One date and one time axis for every doctor, pinned while the doctors scroll under it. */}
              {suggestions.length > 0 ? (
                <SharedDayHeader days={departmentDays} day={listDay} onDay={setDayChoice} range={listRange} today={today} now={now} />
              ) : null}
              {suggestions.length === 0 ? (
                <p className="text-sm text-ink-muted">No doctors in this department.</p>
              ) : (
                <ul className="flex flex-col gap-3" aria-label="Doctors">
                  {suggestions.map((suggestion) => {
                    const chosen = suggestion.provider.providerId === providerId && Boolean(slot)
                    return (
                      <li key={suggestion.provider.providerId}>
                        <DoctorSlotCard
                          suggestion={suggestion}
                          today={today}
                          now={now}
                          soonest={suggestion.provider.providerId === soonestId}
                          selectedDate={chosen ? date : null}
                          selectedSlot={chosen ? slot : null}
                          onPick={pickTime}
                          sharedDay={listDay}
                          sharedRange={listRange}
                          wide
                        >
                          {chosen && modes.length > 1 ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-medium text-ink-muted">How</span>
                              <div className="inline-flex flex-wrap gap-1 rounded-xl border border-border-soft bg-surface-2 p-1" role="group" aria-label="How the patient is seen">
                                {modes.map((option) => (
                                  <button
                                    key={option}
                                    type="button"
                                    aria-pressed={option === consultMode}
                                    onClick={() => setConsultMode(option)}
                                    className={cn(
                                      'focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors',
                                      option === consultMode ? 'bg-surface-1 text-ink shadow-card' : 'text-ink-muted hover:text-ink',
                                    )}
                                  >
                                    {option === 'Teleconsult' ? (
                                      <Video className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                                    ) : (
                                      <Building2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                                    )}
                                    {option}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </DoctorSlotCard>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
        </Quadrant>
      </div>
      </div>
    </FlowSheet>
  )
}

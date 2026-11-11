import { useState } from 'react'
import type { ReactNode } from 'react'
import { Building2, CalendarCheck2, CalendarClock, Video } from 'lucide-react'
import { FlowSheet } from '../../components/flow/FlowSheet'
import { AckCard } from '../../components/flow/AckCard'
import { Quadrant, SummaryItem } from '../../components/flow/Quadrant'
import { BillAtCounter } from '../../components/payment/BillAtCounter'
import { printBill } from '../../utils/printBill'
import { DoctorSlotCard } from '../../components/clinician/DoctorSlotCard'
import { DepartmentChips } from '../../components/clinician/DepartmentChips'
import { SharedDayHeader } from '../../components/clinician/SharedDayHeader'
import { getDepartmentDateStrip, getDepartmentDayRange } from '../../domain/doctorDaySelectors'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { useStoreValue } from '../../hooks/useStore'
import { useNow } from '../../hooks/useNow'
import { getState } from '../../domain/store'
import {
  consultationFeePaid,
  getAppointmentById,
  getDepartments,
  getDoctorSuggestions,
  getPatientById,
  getProviderById,
  getToday,
} from '../../domain/selectors'
import { rescheduleAppointment } from '../../domain/actions'
import { formatRupees } from '../../utils/billing'
import { dayWithDate } from '../../utils/dates'
import { appointmentStatusLabel, modesFor } from '../../utils/appointment'
import { cn } from '../../utils/cn'
import type { FlowProps } from '../registry'
import type { Appointment, BookingPlace, ConsultMode, UnavailableParty } from '../../types/appointment'
import type { Payment } from '../../types/payment'
import { inputClass } from '../../utils/formClasses'
import { formatTime } from '../../domain/time'

/** One line for a booking's place: doctor · day date · time · mode. */
function placeLine(place: BookingPlace, doctorName: string, today: string): string {
  return `${doctorName} · ${dayWithDate(place.date, today)} · ${formatTime(place.slot)}${place.mode === 'Teleconsult' ? ' · Teleconsult' : ''}`
}

/**
 * Reschedule: a confirmed booking moves to another time, doctor or
 * department. It is the Schedule Appointment page again — a strip with the
 * booking being moved and the department buttons, then every doctor's day
 * under one pinned date row and time axis — with the booking's department and
 * doctor chosen to start, and "who can't make it" added to the confirmation.
 * Moving never refunds; a patient who asks for a dearer doctor pays the
 * difference, and when the doctor is the reason the hospital absorbs it.
 */
export function RescheduleFlow({ params, onClose }: FlowProps) {
  const now = useNow(15000)
  const today = useStoreValue(getToday)
  const live = useStoreValue(getAppointmentById, params.appointment ?? '')
  // The booking as it was when the flow opened — the "Was" card stays put.
  const [was] = useState<Appointment | null>(live)
  const patient = useStoreValue(getPatientById, was?.patientId ?? '')
  const wasProvider = useStoreValue(getProviderById, was?.providerId ?? '')
  const feePaid = useStoreValue(consultationFeePaid, was?.appointmentId ?? '')

  // The booking's own department and doctor start chosen; either can be changed, as on Schedule Appointment.
  const [department, setDepartment] = useState<string>(was?.department ?? '')
  const [dayChoice, setDayChoice] = useState<string | null>(was?.date ?? null)
  const [providerId, setProviderId] = useState<string | null>(was?.providerId ?? null)
  const [date, setDate] = useState<string | null>(null)
  const [slot, setSlot] = useState<string | null>(null)
  const [mode, setMode] = useState<ConsultMode>(was?.mode ?? 'In person')
  const [by, setBy] = useState<UnavailableParty | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ appointment: Appointment; differenceBill: Payment | null } | null>(null)

  const departments = useStoreValue(getDepartments)
  const suggestions = useStoreValue(getDoctorSuggestions, department, now)
  const provider = useStoreValue(getProviderById, providerId ?? '')
  const modes = provider ? modesFor(provider) : (['In person'] as ConsultMode[])
  // One day and one time axis for every doctor in the department.
  const departmentDays = useStoreValue(getDepartmentDateStrip, department, now)
  const listDay =
    (dayChoice && departmentDays.some((d) => d.date === dayChoice) ? dayChoice : null) ?? departmentDays.find((d) => d.open > 0)?.date ?? today
  const listRange = useStoreValue(getDepartmentDayRange, department, now, listDay)

  const subtitle = patient ? `${patient.name} · ${patient.uhid}` : 'Booking'
  const sheet = (body: ReactNode, footer?: ReactNode) => (
    <FlowSheet title="Reschedule" subtitle={subtitle} icon={CalendarClock} onClose={onClose} size="full" footer={footer}>
      {body}
    </FlowSheet>
  )

  if (!was || !wasProvider) return sheet(<Alert tone="warning">That booking no longer exists.</Alert>)

  // ------------------------------------------------------------ acknowledgement
  if (done) {
    const moved = done.appointment
    const movedDoctor = getProviderById(getState(), moved.providerId)?.name ?? 'Doctor'
    return sheet(
      <div className="flex min-h-full items-center justify-center py-6">
        <div className="w-full max-w-xl rounded-2xl border border-border bg-surface-1 px-6 shadow-card">
      <AckCard
        title="Appointment Rescheduled"
        icon={CalendarCheck2}
        onDone={onClose}
        durationMs={done.differenceBill ? 9000 : undefined}
      >
        <p className="text-base font-semibold text-ink">{movedDoctor}</p>
        <p>
          {dayWithDate(moved.date, today)} · {formatTime(moved.slot)}
        </p>
        <p className="inline-flex items-center gap-1.5">
          {moved.mode === 'Teleconsult' ? <Video className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" /> : <Building2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />}
          {moved.mode === 'Teleconsult' ? 'Teleconsult' : 'In person'}
        </p>
        <p>
          {moved.appointmentId.toUpperCase()}
          {done.differenceBill ? null : ' · nothing to pay'}
        </p>
        {done.differenceBill ? <BillAtCounter paymentId={done.differenceBill.paymentId} className="mt-1 w-full" /> : null}
      </AckCard>
        </div>
      </div>,
    )
  }

  // A booking that has moved on (checked in, cancelled …) can't be moved.
  if (!live || live.status !== 'Confirmed') {
    return sheet(
      <Alert tone="warning">
        This booking is {live ? appointmentStatusLabel(live.status).toLowerCase() : 'no longer available'} — only a confirmed booking can be rescheduled.
      </Alert>,
    )
  }

  const timeDone = Boolean(provider && date && slot)

  const difference = provider ? provider.consultationFee - feePaid : 0
  const charge = difference > 0 && by === 'Patient' ? difference : 0
  const ready = timeDone && by !== null
  const nowPlace = provider && date && slot ? placeLine({ providerId: provider.providerId, date, slot, mode }, provider.name, today) : null

  // Tapping a free time on any doctor's chart chooses that doctor and time.
  function pickTime(nextProvider: string, nextDate: string, nextSlot: string) {
    setError(null)
    if (nextProvider !== providerId) {
      const chosen = getProviderById(getState(), nextProvider)
      const offered = chosen ? modesFor(chosen) : (['In person'] as ConsultMode[])
      setMode(offered.includes(was!.mode) ? was!.mode : offered[0])
    }
    setProviderId(nextProvider)
    setDate(nextDate)
    setSlot(nextSlot)
  }

  function chooseDepartment(next: string) {
    if (next === department) return
    setError(null)
    setDepartment(next)
    setDayChoice(null)
    setProviderId(null)
    setDate(null)
    setSlot(null)
  }

  function move() {
    if (!providerId || !date || !slot || !by) return
    setError(null)
    try {
      const result = rescheduleAppointment({ appointmentId: was!.appointmentId, providerId, date, slot, mode, by, note })
      // A fee difference is paid at the billing counter, not here: its bill is
      // printed for the patient to take there.
      if (result.differenceBill) printBill(result.differenceBill.paymentId)
      setDone(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      if (/slot/i.test(message)) {
        setSlot(null)
      }
    }
  }

  function moneyLine(): string {
    if (!provider) return ''
    if (difference < 0) return `${formatRupees(-difference)} less · not refunded`
    if (difference === 0) return 'Same fee · nothing to pay'
    if (by === 'Doctor') return `${formatRupees(difference)} more · absorbed by the hospital`
    if (by === 'Patient') return `${formatRupees(difference)} more · the patient pays the difference`
    return `${formatRupees(difference)} more`
  }

  const confirmBar = (
    <div className="flex flex-col gap-3">
      {error ? <Alert tone="critical">{error}</Alert> : null}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm">
        <SummaryItem label="Now" value={nowPlace} />
      </dl>
      <div className="grid grid-cols-1 items-center gap-3 xl:grid-cols-[auto_minmax(0,1fr)_auto]">
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">Who can't make the booked time?</legend>
          <span className="text-xs font-medium text-ink-muted" aria-hidden="true">
            Who can't make the booked time?
          </span>
          <div className="inline-flex flex-wrap gap-1 rounded-xl border border-border-soft bg-surface-2 p-1" role="radiogroup" aria-label="Who can't make the booked time">
            {(['Patient', 'Doctor'] as UnavailableParty[]).map((party) => (
              <button
                key={party}
                type="button"
                role="radio"
                aria-checked={by === party}
                onClick={() => setBy(party)}
                className={cn(
                  'focus-ring min-h-11 rounded-lg px-3.5 text-sm font-medium transition-colors',
                  by === party ? 'bg-surface-1 text-ink shadow-card' : 'text-ink-muted hover:text-ink',
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
          placeholder="Note (optional)"
          aria-label="Note (optional)"
          maxLength={120}
          className={inputClass}
        />
        <Button size="lg" disabled={!ready} onClick={move}>
          <CalendarCheck2 className="h-4 w-4" strokeWidth={1.75} />
          {charge > 0 ? `Reschedule & print ${formatRupees(charge)} bill` : 'Reschedule'}
        </Button>
      </div>
      {provider ? <p className={cn('text-xs', charge > 0 ? 'font-medium text-warning-fg' : 'text-ink-muted')}>{moneyLine()}</p> : null}
    </div>
  )

  return sheet(
    <div className="flex flex-col gap-3 sm:gap-4 xl:h-full">
      {/* One strip across the top: who, the booking being moved, and the department — changeable in place. */}
      <section
        aria-label="Patient and department"
        className="surface-raised flex flex-col gap-2.5 rounded-xl border border-border-soft bg-surface-1 px-3.5 py-2.5 sm:px-4 xl:flex-row xl:items-center xl:gap-4"
      >
        <div className="flex min-w-0 items-center gap-2.5 xl:shrink-0">
          <span className="text-2xs font-semibold uppercase tracking-wide text-ink-subtle">Was</span>
          <span className="min-w-0 truncate text-sm text-ink">
            <span className="font-semibold">{wasProvider.name}</span>
            <span className="text-ink-muted">
              {' '}
              · {dayWithDate(was.date, today)} · {formatTime(was.slot)} · {formatRupees(feePaid)} paid
            </span>
          </span>
        </div>
        <span aria-hidden="true" className="hidden h-6 w-px bg-border-soft xl:block" />
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <DepartmentChips departments={departments} selected={department} onChoose={chooseDepartment} />
        </div>
      </section>

      {/* Every doctor in the department with their day — the current booking marked on its doctor's chart. */}
      <Quadrant
        id="reschedule-availability"
        step={2}
        title="Doctor's Availability"
        done={timeDone}
        scrollFrom="xl"
        className="xl:min-h-0 xl:flex-1"
      >
        <div className="flex flex-col gap-3">
          {suggestions.length > 0 ? (
            <SharedDayHeader days={departmentDays} day={listDay} onDay={setDayChoice} range={listRange} today={today} now={now} />
          ) : null}
          {suggestions.length === 0 ? (
            <p className="text-sm text-ink-muted">No doctors in this department.</p>
          ) : (
            <ul className="flex flex-col gap-3" aria-label="Doctors">
              {/* The booking's own doctor first. */}
              {[...suggestions]
                .sort((a, b) => Number(b.provider.providerId === was.providerId) - Number(a.provider.providerId === was.providerId))
                .map((suggestion) => {
                const id = suggestion.provider.providerId
                const chosen = id === providerId && Boolean(slot)
                return (
                  <li key={id}>
                    <DoctorSlotCard
                      suggestion={suggestion}
                      today={today}
                      now={now}
                      soonest={false}
                      selectedDate={chosen ? date : null}
                      selectedSlot={chosen ? slot : null}
                      onPick={pickTime}
                      sharedDay={listDay}
                      sharedRange={listRange}
                      currentAppointmentId={id === was.providerId ? was.appointmentId : undefined}
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
                                aria-pressed={option === mode}
                                onClick={() => setMode(option)}
                                className={cn(
                                  'focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-colors',
                                  option === mode ? 'bg-surface-1 text-ink shadow-card' : 'text-ink-muted hover:text-ink',
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
      </Quadrant>
    </div>,
    confirmBar,
  )
}

// The only functions allowed to change operational state. Each one reads
// the CURRENT state at call time, validates against it (so a slot taken a
// moment ago is correctly rejected), computes the next state immutably,
// appends activity-log entries, and commits with a single setState() — so
// every subscribed screen updates together, never out of sync.
//
// DEV NOTE: with a real backend, each body becomes an async API call that
// throws DomainError on a 4xx and reconciles the response into state (or
// applies a server-sent event). Callers already treat these as fallible, so
// no component needs to change.
import { getState, setState } from './store'
import {
  FEE_DIFFERENCE_CODE,
  consultationFeePaid,
  findAbhaHolder,
  getAvailableSlots,
  getBillLock,
  getBillsForAppointment,
  getConsultationBillItems,
  getDoctorSchedule,
} from './selectors'
import { dayStartTimestamp, formatTime, slotToTimestamp, todayKey } from './time'
import { DomainError } from './errors'
import { MOBILE_ERROR, formatMobile, isValidMobile } from '../utils/phone'
import {
  abhaError,
  addressError,
  ageError,
  ageNeedsConfirmation,
  emailError,
  mobileError,
  nameError,
  normalizeAbha,
  normalizeName,
  sexError,
} from '../utils/validation'
import { formatRupees } from '../utils/billing'
import { formatDateKey } from '../utils/dates'
import { NO_SHOW_GRACE_MINUTES, appointmentStatusLabel, modesFor } from '../utils/appointment'
import type { AppState } from '../types/store'
import type { Patient, RegisterPatientInput, PatientDemographicsInput, Sex } from '../types/patient'
import type { Provider, RegisterDoctorInput, DoctorChanges, ProviderStatus } from '../types/doctor'
import type { Appointment, BookAppointmentInput, ConsultMode, UnavailableParty } from '../types/appointment'
import type { CheckInResult } from '../types/queue'
import type {
  AddEstimateItemInput,
  GuestPass,
  Estimate,
  IssueGuestPassInput,
  MlcRecord,
  RegisterMlcInput,
  RemoveEstimateItemInput,
  UpdateEstimateItemQuantityInput,
} from '../types/frontDesk'
import type { ActivityLogEntry } from '../types/activity'
import type {
  CancelPaymentInput,
  CollectPaymentInput,
  CreatePaymentInput,
  Payment,
  RecordFailedPaymentInput,
  RefundPaymentInput,
} from '../types/payment'

const DEPARTMENT_PREFIX: Record<string, string> = {
  Neurology: 'NEU',
  Cardiology: 'CAR',
  'General Medicine': 'MED',
  Orthopedics: 'ORT',
  Neurosurgery: 'NSG',
  'Emergency': 'EMG',
}

interface ActivityInput {
  time?: number
  text: string
  meta?: string
}

export function withActivity(current: AppState, entries: ActivityInput[]): { activityLog: ActivityLogEntry[]; activitySeq: number } {
  let seq = current.nextIds.activity
  const appended: ActivityLogEntry[] = entries.map((entry) => ({
    id: `act-${seq++}`,
    time: entry.time ?? Date.now(),
    text: entry.text,
    meta: entry.meta,
  }))
  return { activityLog: [...current.activityLog, ...appended], activitySeq: seq }
}

/** A pure state step: the next state and what the step made. An action
 *  chains the steps it needs and commits once, so a booking, its bill and
 *  its payment land together or not at all. */
interface Step<T> {
  state: AppState
  value: T
}

/** The state with these entries added to the activity log. */
function logged(state: AppState, entries: ActivityInput[]): AppState {
  const { activityLog, activitySeq } = withActivity(state, entries)
  return { ...state, activityLog, nextIds: { ...state.nextIds, activity: activitySeq } }
}

function patientName(state: AppState, patientId: string): string {
  return state.patients.find((p) => p.patientId === patientId)?.name ?? patientId
}

function providerName(state: AppState, providerId: string): string {
  return state.providers.find((p) => p.providerId === providerId)?.name ?? providerId
}

function issueTokenNumber(state: AppState, department: string): { tokenNumber: string; tokenCounters: AppState['tokenCounters'] } {
  const prefix = DEPARTMENT_PREFIX[department] ?? 'GEN'
  const count = (state.tokenCounters[prefix] ?? 0) + 1
  return {
    tokenNumber: `${prefix}-${String(count).padStart(3, '0')}`,
    tokenCounters: { ...state.tokenCounters, [prefix]: count },
  }
}

function requireToken(state: AppState, tokenId: string) {
  const token = state.queueTokens.find((t) => t.tokenId === tokenId)
  if (!token) throw new DomainError('NOT_FOUND', 'That token no longer exists.')
  return token
}

function requireAppointment(state: AppState, appointmentId: string): Appointment {
  const appointment = state.appointments.find((a) => a.appointmentId === appointmentId)
  if (!appointment) throw new DomainError('NOT_FOUND', 'That appointment no longer exists.')
  return appointment
}

function requirePayment(state: AppState, paymentId: string): Payment {
  const payment = state.payments.find((p) => p.paymentId === paymentId)
  if (!payment) throw new DomainError('NOT_FOUND', 'That payment record no longer exists.')
  return payment
}

// ---------------------------------------------------------------- patients

/** The registration rules every patient record must meet — the same checks
 *  the form shows inline (utils/validation.ts). */
function assertPatientFields(input: { name: string; age: string | number; sex: Sex | ''; mobile: string; abhaId?: string; ageConfirmed?: boolean }) {
  const problem =
    nameError(input.name) ?? ageError(input.age) ?? sexError(input.sex) ?? mobileError(input.mobile) ?? abhaError(input.abhaId)
  if (problem) throw new DomainError('VALIDATION', problem)
  if (ageNeedsConfirmation(input.age) && !input.ageConfirmed) {
    throw new DomainError('VALIDATION', `Confirm the age (${Number(input.age)}) with the patient first.`)
  }
}

/** One ABHA belongs to one patient. */
function assertAbhaFree(state: AppState, abhaId: string, exceptPatientId?: string) {
  const holder = findAbhaHolder(state, abhaId)
  if (holder && holder.patientId !== exceptPatientId) {
    throw new DomainError('DUPLICATE', `This ABHA is already linked to ${holder.name} (${holder.uhid}).`)
  }
}

/** Creates the patient record and allocates its UHID. Registering is free —
 *  no bill is raised; the only charge at the front desk is a consultation. */
export function registerPatient(input: RegisterPatientInput): Patient {
  assertPatientFields(input)
  const { name, age, sex, mobile } = input
  const abhaId = input.abhaId?.trim() ? normalizeAbha(input.abhaId) : null

  const state = getState()
  if (abhaId) assertAbhaFree(state, abhaId)
  const seq = state.nextIds.patient
  const uhid = `ISH-${String(130000 + seq).padStart(7, '0')}`
  const patient: Patient = {
    patientId: uhid,
    uhid,
    name: normalizeName(name),
    nameNative: null,
    age: Number(age),
    sex: sex as Sex,
    mobile: formatMobile(mobile),
    email: null,
    address: input.address?.trim() || null,
    abhaId,
    registrationStatus: 'Registered',
    createdAt: Date.now(),
  }

  const registered = logged(
    {
      ...state,
      patients: [...state.patients, patient],
      registrationLog: [...state.registrationLog, { patientId: uhid, registeredAt: patient.createdAt }],
      nextIds: { ...state.nextIds, patient: seq + 1 },
    },
    [{ text: 'New patient registered', meta: `${patient.name} · ${uhid}` }],
  )
  setState(registered)
  return patient
}

// ------------------------------------------------------------ appointments

/** Reserves the slot and records the booking, awaiting its payment. */
/** A patient's bookings still to happen, or under way — a completed,
 *  cancelled or missed one never stands in the way of a new booking. */
const ACTIVE_FOR_PATIENT = ['Scheduled', 'Payment Pending', 'Confirmed', 'Checked-in']

/** The patient's own booking that overlaps a new one on the same day, if any.
 *  A patient can hold any number of bookings — with the same doctor or
 *  others, on any days — just not two at the same time. */
function patientOverlap(state: AppState, patientId: string, providerId: string, date: string, slot: string): Appointment | null {
  const minutes = (doctorId: string) => getDoctorSchedule(state, doctorId, date)?.slotMinutes ?? state.providers.find((p) => p.providerId === doctorId)?.schedule.slotMinutes ?? 15
  const start = slotToTimestamp(date, slot)
  const end = start + minutes(providerId) * 60000
  return (
    state.appointments.find((a) => {
      if (a.patientId !== patientId || a.date !== date || !ACTIVE_FOR_PATIENT.includes(a.status)) return false
      const theirStart = slotToTimestamp(a.date, a.slot)
      return theirStart < end && start < theirStart + minutes(a.providerId) * 60000
    }) ?? null
  )
}

function applyBooking(
  state: AppState,
  { patientId, providerId, department, slot, date, reason, mode = 'In person' }: BookAppointmentInput,
  now: number,
): Step<Appointment> {
  const targetDate = date ?? todayKey(new Date(now))
  if (!getAvailableSlots(state, providerId, now, targetDate).includes(slot)) {
    throw new DomainError('SLOT_ALREADY_BOOKED', 'That slot was just taken or has passed. Choose another time.')
  }
  const clash = patientOverlap(state, patientId, providerId, targetDate, slot)
  if (clash) {
    throw new DomainError(
      'PATIENT_OVERLAP',
      `${patientName(state, patientId)} already has an appointment with ${providerName(state, clash.providerId)} at ${formatTime(clash.slot)} on that day — choose a time that does not overlap it.`,
    )
  }
  const appointment: Appointment = {
    appointmentId: `apt-${state.nextIds.appointment}`,
    patientId,
    providerId,
    department,
    date: targetDate,
    slot,
    // The bill is raised and paid in the same save (bookAndPayAppointment);
    // collecting it is what confirms the booking.
    status: 'Payment Pending',
    visitId: null,
    reason: reason?.trim() || null,
    mode,
    createdAt: now,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    reschedules: [],
  }
  const next = logged(
    {
      ...state,
      appointments: [...state.appointments, appointment],
      nextIds: { ...state.nextIds, appointment: state.nextIds.appointment + 1 },
    },
    [{ text: 'Appointment booked', meta: `${patientName(state, patientId)} → ${providerName(state, providerId)} at ${formatTime(slot)}` }],
  )
  return { state: next, value: appointment }
}

/** A consultation's bill — the doctor's consultation fee, the one charge
 *  of a booking — raised like every other bill. */
function applyConsultationBill(
  state: AppState,
  { patientId, providerId, appointmentId = null }: { patientId: string; providerId: string; appointmentId?: string | null },
  now: number,
): Step<Payment> {
  const items = getConsultationBillItems(state, patientId, providerId)
  if (items.length === 0) throw new DomainError('NOT_FOUND', 'That doctor no longer exists.')
  return applyNewBill(state, { patientId, items, appointmentId }, now)
}

/** Books a slot and raises its bill, saved together. Care Entry takes no
 *  money: the bill goes to the billing counter, and the booking stays
 *  "payment pending" (its slot held) until the counter records the payment,
 *  which confirms it. */
export function bookAppointment({
  patientId,
  providerId,
  date,
  slot,
  reason,
  mode,
}: {
  patientId: string
  providerId: string
  date: string
  slot: string
  reason?: string
  mode?: ConsultMode
}): { appointment: Appointment; bill: Payment } {
  const state = getState()
  const now = Date.now()
  if (!state.patients.some((p) => p.patientId === patientId)) throw new DomainError('VALIDATION', 'Select a patient first.')
  const provider = state.providers.find((p) => p.providerId === providerId)
  if (!provider || provider.status !== 'Active') throw new DomainError('VALIDATION', 'That doctor is not taking bookings.')
  if (mode && !modesFor(provider).includes(mode)) {
    throw new DomainError('VALIDATION', `${provider.name} does not offer ${mode === 'Teleconsult' ? 'teleconsults' : 'in-person visits'}.`)
  }

  const booked = applyBooking(
    state,
    { patientId, providerId, department: provider.department, slot, date, reason, mode: mode ?? modesFor(provider)[0] },
    now,
  )
  const billed = applyConsultationBill(booked.state, { patientId, providerId, appointmentId: booked.value.appointmentId }, now)
  setState(billed.state)
  return { appointment: booked.value, bill: billed.value }
}

/** An unpaid booking moved to another time: the old booking and its unpaid
 *  bill are removed altogether — not cancelled — so only the new booking is
 *  seen anywhere (profile, outpatients, the doctor's day, payments), and its
 *  time is free again. Saved in one step: if the new time can't be booked,
 *  nothing changes. A booking with anything paid moves with
 *  rescheduleAppointment instead. */
export function rebookUnpaidAppointment({
  appointmentId,
  providerId,
  date,
  slot,
  reason,
  mode,
}: {
  appointmentId: string
  providerId: string
  date: string
  slot: string
  reason?: string
  mode?: ConsultMode
}): { appointment: Appointment; bill: Payment } {
  const state = getState()
  const now = Date.now()
  const old = requireAppointment(state, appointmentId)
  const oldBills = getBillsForAppointment(state, appointmentId)
  if ((old.status !== 'Payment Pending' && old.status !== 'Scheduled') || oldBills.some((bill) => bill.paidAmount > 0)) {
    throw new DomainError('INVALID_TRANSITION', 'Only an unpaid booking can be replaced — this one is moved with Reschedule.')
  }
  const provider = state.providers.find((p) => p.providerId === providerId)
  if (!provider || provider.status !== 'Active') throw new DomainError('VALIDATION', 'That doctor is not taking bookings.')
  if (mode && !modesFor(provider).includes(mode)) {
    throw new DomainError('VALIDATION', `${provider.name} does not offer ${mode === 'Teleconsult' ? 'teleconsults' : 'in-person visits'}.`)
  }
  const gone = new Set(oldBills.map((bill) => bill.paymentId))
  const cleared: AppState = {
    ...state,
    appointments: state.appointments.filter((a) => a.appointmentId !== appointmentId),
    payments: state.payments.filter((bill) => !gone.has(bill.paymentId)),
  }
  const booked = applyBooking(
    cleared,
    { patientId: old.patientId, providerId, department: provider.department, slot, date, reason: reason ?? old.reason ?? undefined, mode: mode ?? modesFor(provider)[0] },
    now,
  )
  const billed = applyConsultationBill(booked.state, { patientId: old.patientId, providerId, appointmentId: booked.value.appointmentId }, now)
  setState(billed.state)
  return { appointment: booked.value, bill: billed.value }
}

// ------------------------------------------------- cancel, move, no-show
// The money follows who could not keep the booking: when the doctor is
// unavailable the patient is refunded in full; when the patient cancels or
// does not come, the fee is kept. A move never refunds — it collects the
// difference only when the patient chooses a dearer doctor.

const OPEN_BOOKING_STATUSES = ['Scheduled', 'Payment Pending', 'Confirmed']

/** Cancels one booking inside a chain of steps. */
function applyCancelBooking(state: AppState, appointmentId: string, by: UnavailableParty, note: string, now: number): Step<Appointment> {
  const appointment = requireAppointment(state, appointmentId)
  if (!OPEN_BOOKING_STATUSES.includes(appointment.status)) {
    throw new DomainError('INVALID_TRANSITION', `This booking is ${appointmentStatusLabel(appointment.status).toLowerCase()} — it can't be cancelled.`)
  }
  const reason = note.trim() || (by === 'Doctor' ? 'Doctor unavailable' : 'Patient cancelled')
  let next = state
  for (const bill of getBillsForAppointment(state, appointmentId)) {
    if (bill.paidAmount > 0) {
      // Doctor unavailable: everything paid for this booking goes back.
      if (by === 'Doctor') next = applyFullRefund(next, bill.paymentId, 'Doctor unavailable', now).state
    } else if (bill.status === 'Pending') {
      next = applyBillCancel(next, bill.paymentId, 'Appointment cancelled', now).state
    }
  }
  const cancelled: Appointment = { ...appointment, status: 'Cancelled', cancelledAt: now, cancelledBy: by, cancelReason: reason }
  next = logged({ ...next, appointments: next.appointments.map((a) => (a.appointmentId === appointmentId ? cancelled : a)) }, [
    {
      text: 'Appointment cancelled',
      meta: `${patientName(state, appointment.patientId)} · ${providerName(state, appointment.providerId)} · ${appointment.date} ${formatTime(appointment.slot)} · ${reason}`,
    },
  ])
  return { state: next, value: cancelled }
}

/** Cancels a booking because the patient or the doctor can't keep it. */
export function cancelAppointment({ appointmentId, by, note = '' }: { appointmentId: string; by: UnavailableParty; note?: string }): Appointment {
  const { state, value } = applyCancelBooking(getState(), appointmentId, by, note, Date.now())
  setState(state)
  return value
}

/** How long a booking holds its time while its bill is unpaid. */
export const PAYMENT_HOLD_MS = 5 * 60000

/** An unpaid booking older than the hold is released: it is cancelled, its
 *  bill withdrawn, and the time is free for anyone else. Returns what it
 *  released. The patient pays at the billing counter; a booking is only
 *  really confirmed once that payment is recorded. */
export function releaseUnpaidBookings(now: number = Date.now()): Appointment[] {
  const state = getState()
  const expired = state.appointments.filter(
    (a) =>
      (a.status === 'Payment Pending' || a.status === 'Scheduled') &&
      now - a.createdAt >= PAYMENT_HOLD_MS &&
      getBillsForAppointment(state, a.appointmentId).some((bill) => bill.balance > 0 && bill.paidAmount === 0),
  )
  if (expired.length === 0) return []
  let next = state
  const released: Appointment[] = []
  for (const appointment of expired) {
    const step = applyCancelBooking(next, appointment.appointmentId, 'Patient', 'Payment not received within 5 minutes — slot released', now)
    next = step.state
    released.push(step.value)
  }
  setState(next)
  return released
}

/** Every open booking a doctor has on one day, cancelled as doctor
 *  unavailable and refunded — clearing the day for leave, in one save. */
export function cancelDoctorDayBookings({ providerId, date, note = '' }: { providerId: string; date: string; note?: string }): {
  cancelled: number
  refunded: number
} {
  const state = getState()
  const now = Date.now()
  const open = state.appointments.filter((a) => a.providerId === providerId && a.date === date && OPEN_BOOKING_STATUSES.includes(a.status))
  if (open.length === 0) throw new DomainError('VALIDATION', 'There are no open bookings on that day.')
  let next = state
  let refunded = 0
  for (const appointment of open) {
    refunded += getBillsForAppointment(next, appointment.appointmentId).reduce((sum, bill) => sum + bill.paidAmount, 0)
    next = applyCancelBooking(next, appointment.appointmentId, 'Doctor', note || 'Doctor unavailable', now).state
  }
  setState(next)
  return { cancelled: open.length, refunded }
}

/** The patient did not come: the booking closes as a no-show and the fee
 *  is kept. Only once its time is past by the grace period. */
export function markNoShow(appointmentId: string): Appointment {
  const state = getState()
  const now = Date.now()
  const appointment = requireAppointment(state, appointmentId)
  if (appointment.status !== 'Confirmed') {
    throw new DomainError('INVALID_TRANSITION', `This booking is ${appointmentStatusLabel(appointment.status).toLowerCase()}.`)
  }
  if (now < slotToTimestamp(appointment.date, appointment.slot) + NO_SHOW_GRACE_MINUTES * 60000) {
    throw new DomainError('INVALID_TRANSITION', `A no-show can only be marked once ${NO_SHOW_GRACE_MINUTES} minutes have passed since the booked time.`)
  }
  const updated: Appointment = { ...appointment, status: 'No-show' }
  setState(
    logged({ ...state, appointments: state.appointments.map((a) => (a.appointmentId === appointmentId ? updated : a)) }, [
      { text: 'Marked as no-show', meta: `${patientName(state, appointment.patientId)} · ${providerName(state, appointment.providerId)} · ${formatTime(appointment.slot)} · fee kept` },
    ]),
  )
  return updated
}

export interface RescheduleInput {
  appointmentId: string
  providerId: string
  date: string
  slot: string
  mode: ConsultMode
  by: UnavailableParty
  note?: string
}

/** Moves a booking to another time, or another doctor in the same
 *  department. The booking keeps its id and records the move. */
export function rescheduleAppointment({ appointmentId, providerId, date, slot, mode, by, note = '' }: RescheduleInput): {
  appointment: Appointment
  differenceBill: Payment | null
} {
  const state = getState()
  const now = Date.now()
  const appointment = requireAppointment(state, appointmentId)
  if (appointment.status !== 'Confirmed') {
    throw new DomainError('INVALID_TRANSITION', `Only a confirmed booking can be moved — this one is ${appointmentStatusLabel(appointment.status).toLowerCase()}.`)
  }
  const provider = state.providers.find((p) => p.providerId === providerId)
  if (!provider || provider.status !== 'Active') throw new DomainError('VALIDATION', 'That doctor is not taking bookings.')
  if (!modesFor(provider).includes(mode)) {
    throw new DomainError('VALIDATION', `${provider.name} does not offer ${mode === 'Teleconsult' ? 'teleconsults' : 'in-person visits'}.`)
  }
  if (providerId === appointment.providerId && date === appointment.date && slot === appointment.slot) {
    throw new DomainError('VALIDATION', 'That is the time it is already booked for — choose another.')
  }
  if (!getAvailableSlots(state, providerId, now, date).includes(slot)) {
    throw new DomainError('SLOT_ALREADY_BOOKED', 'That slot was just taken or has passed. Choose another time.')
  }

  const difference = provider.consultationFee - consultationFeePaid(state, appointmentId)
  // Only a patient's own move to a dearer doctor is charged; when the
  // doctor is the reason, the hospital absorbs the difference.
  const charge = difference > 0 && by === 'Patient' ? difference : 0
  let next = state
  let differenceBill: Payment | null = null
  // The difference goes to the billing counter; the booking waits on it.
  if (charge > 0) {
    const billed = applyNewBill(
      next,
      { patientId: appointment.patientId, items: [{ code: FEE_DIFFERENCE_CODE, description: `Fee difference — ${provider.name}`, amount: charge }], appointmentId },
      now,
    )
    next = billed.state
    differenceBill = billed.value
  }

  const from = { providerId: appointment.providerId, date: appointment.date, slot: appointment.slot, mode: appointment.mode }
  const to = { providerId, date, slot, mode }
  const moved: Appointment = {
    ...appointment,
    status: differenceBill ? 'Payment Pending' : appointment.status,
    providerId,
    // A move may go to another department; the booking follows its new doctor.
    department: provider.department,
    date,
    slot,
    mode,
    reschedules: [
      ...appointment.reschedules,
      { at: now, from, to, by, note: note.trim() || null, differencePaymentId: differenceBill?.paymentId ?? null },
    ],
  }
  // The consultation line names the doctor the patient will now see; what
  // was paid for it stays as it was.
  const renamed = providerId !== appointment.providerId
  next = logged(
    {
      ...next,
      appointments: next.appointments.map((a) => (a.appointmentId === appointmentId ? moved : a)),
      payments: renamed
        ? next.payments.map((bill) =>
            bill.appointmentId === appointmentId && bill.status !== 'Cancelled'
              ? {
                  ...bill,
                  items: bill.items.map((item) => (item.code === 'CONS-FEE' ? { ...item, description: `Consultation — ${provider.name}` } : item)),
                }
              : bill,
          )
        : next.payments,
    },
    [
      {
        text: 'Appointment rescheduled',
        meta: `${patientName(state, appointment.patientId)} · ${providerName(state, from.providerId)} ${from.date} ${formatTime(from.slot)} → ${provider.name} ${date} ${formatTime(slot)} · ${by === 'Doctor' ? 'doctor unavailable' : 'patient’s request'}`,
      },
    ],
  )
  setState(next)
  return { appointment: moved, differenceBill }
}

// ------------------------------------------------------- visits and tokens

/**
 * Check-in turns a booked appointment into a live queue presence: the
 * appointment status, the Visit and the QueueToken are all written in the
 * same commit, so no screen can ever observe a checked-in appointment
 * without its visit and token.
 */
export function checkInAppointment(appointmentId: string): CheckInResult {
  const state = getState()
  const appointment = requireAppointment(state, appointmentId)
  // Only a booking paid at the billing counter (Confirmed) joins the queue.
  if (appointment.status === 'Scheduled' || appointment.status === 'Payment Pending') {
    throw new DomainError('INVALID_TRANSITION', 'Payment is pending at the billing counter — check in once it is received.')
  }
  if (appointment.status !== 'Confirmed') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `This booking is ${appointmentStatusLabel(appointment.status).toLowerCase()} — it can't be checked in.`,
    )
  }
  const today = todayKey()
  if (appointment.date !== today) {
    throw new DomainError(
      'INVALID_TRANSITION',
      appointment.date > today
        ? `This booking is for ${formatDateKey(appointment.date)} — check the patient in on that day.`
        : `This booking was for ${formatDateKey(appointment.date)} — it can't be checked in now.`,
    )
  }

  const now = Date.now()
  const visitId = `visit-${state.nextIds.visit}`
  const tokenId = `tok-${state.nextIds.token}`
  const { tokenNumber, tokenCounters } = issueTokenNumber(state, appointment.department)

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Patient added to queue', meta: `${patientName(current, appointment.patientId)} · ${providerName(current, appointment.providerId)}` },
      { text: 'Token generated', meta: `${tokenNumber} · ${patientName(current, appointment.patientId)}` },
    ])
    return {
      ...current,
      appointments: current.appointments.map((a) =>
        a.appointmentId === appointmentId ? { ...a, status: 'Checked-in' as const, visitId } : a,
      ),
      visits: [
        ...current.visits,
        {
          visitId,
          patientId: appointment.patientId,
          appointmentId,
          providerId: appointment.providerId,
          status: 'Open' as const,
          arrivalTime: now,
          checkInTime: now,
          closedAt: null,
        },
      ],
      queueTokens: [
        ...current.queueTokens,
        {
          tokenId,
          tokenNumber,
          patientId: appointment.patientId,
          visitId,
          providerId: appointment.providerId,
          status: 'Waiting' as const,
          createdAt: now,
          calledAt: null,
          startedAt: null,
          completedAt: null,
          recalled: false,
        },
      ],
      tokenCounters,
      activityLog,
      nextIds: {
        ...current.nextIds,
        visit: current.nextIds.visit + 1,
        token: current.nextIds.token + 1,
        activity: activitySeq,
      },
    }
  })

  return { visitId, tokenId, tokenNumber }
}

/** Takes back a check-in pressed by mistake: the booking is to check in
 *  again and its visit and token are withdrawn, in one save. Only while the
 *  patient is still waiting — once called, the visit has begun. The token's
 *  number is not given out again, so numbers stay unique for the day. */
export function undoCheckIn(appointmentId: string): Appointment {
  const state = getState()
  const appointment = requireAppointment(state, appointmentId)
  if (appointment.status !== 'Checked-in' || !appointment.visitId) {
    throw new DomainError('INVALID_TRANSITION', 'This booking is not checked in.')
  }
  if (appointment.date !== todayKey()) {
    throw new DomainError('INVALID_TRANSITION', 'Only today’s check-in can be taken back.')
  }
  const token = state.queueTokens.find((t) => t.visitId === appointment.visitId)
  if (token && token.status !== 'Waiting') {
    throw new DomainError('INVALID_TRANSITION', `The patient has already been ${token.status === 'Called' ? 'called' : 'seen'} — the check-in can't be undone.`)
  }
  const visitId = appointment.visitId
  const reverted: Appointment = { ...appointment, status: 'Confirmed', visitId: null }
  setState(
    logged(
      {
        ...state,
        appointments: state.appointments.map((a) => (a.appointmentId === appointmentId ? reverted : a)),
        visits: state.visits.filter((v) => v.visitId !== visitId),
        queueTokens: state.queueTokens.filter((t) => t.visitId !== visitId),
      },
      [{ text: 'Check-in undone', meta: `${patientName(state, appointment.patientId)}${token ? ` · ${token.tokenNumber} withdrawn` : ''}` }],
    ),
  )
  return reverted
}

// ------------------------------------------------------- queue progression
// NOTE ON OWNERSHIP: calling a patient in, starting and completing a
// consultation belong to the consultation room (the clinician side) in
// UI_ATLAS's permission model — M-05's "Call next" is P-04-gated, not P-03.
// They live here because the queue's state machine is part of this domain
// and the board has to reflect them; the Outpatients page shows them on
// each patient's row at that stage, beside the desk's own Check in.

export function callToken(tokenId: string): void {
  const state = getState()
  const token = requireToken(state, tokenId)
  if (token.status !== 'Waiting') {
    throw new DomainError('INVALID_TRANSITION', `Only a waiting token can be called (this one is ${token.status.toLowerCase()}).`)
  }

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Patient called', meta: `${token.tokenNumber} · ${patientName(current, token.patientId)}` },
    ])
    return {
      ...current,
      queueTokens: current.queueTokens.map((t) =>
        t.tokenId === tokenId ? { ...t, status: 'Called' as const, calledAt: Date.now(), recalled: false } : t,
      ),
      activityLog,
      nextIds: { ...current.nextIds, activity: activitySeq },
    }
  })
}

export function startConsultation(tokenId: string): void {
  const state = getState()
  const token = requireToken(state, tokenId)
  if (token.status !== 'Called') {
    throw new DomainError('INVALID_TRANSITION', `A consultation can only start from a called token (this one is ${token.status.toLowerCase()}).`)
  }

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Consultation started', meta: `${token.tokenNumber} · ${patientName(current, token.patientId)}` },
    ])
    return {
      ...current,
      queueTokens: current.queueTokens.map((t) =>
        t.tokenId === tokenId ? { ...t, status: 'In consultation' as const, startedAt: Date.now() } : t,
      ),
      activityLog,
      nextIds: { ...current.nextIds, activity: activitySeq },
    }
  })
}

/** Completing the consultation closes the whole chain: token, visit and
 *  (when there was one) the originating appointment. */
export function completeConsultation(tokenId: string): void {
  const state = getState()
  const token = requireToken(state, tokenId)
  if (token.status !== 'In consultation' && token.status !== 'Called') {
    throw new DomainError('INVALID_TRANSITION', `This token is ${token.status.toLowerCase()} — it can't be completed.`)
  }
  const visit = state.visits.find((v) => v.visitId === token.visitId) ?? null
  const now = Date.now()

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Consultation completed', meta: `${token.tokenNumber} · ${patientName(current, token.patientId)}` },
    ])
    return {
      ...current,
      queueTokens: current.queueTokens.map((t) =>
        t.tokenId === tokenId ? { ...t, status: 'Completed' as const, completedAt: now } : t,
      ),
      visits: current.visits.map((v) =>
        v.visitId === token.visitId ? { ...v, status: 'Closed' as const, closedAt: now } : v,
      ),
      appointments: current.appointments.map((a) =>
        visit?.appointmentId && a.appointmentId === visit.appointmentId ? { ...a, status: 'Completed' as const } : a,
      ),
      activityLog,
      nextIds: { ...current.nextIds, activity: activitySeq },
    }
  })
}

/** Recall a called-but-absent patient once; a second recall marks no-show
 *  and closes the visit. */
export function recallToken(tokenId: string): void {
  const state = getState()
  const token = requireToken(state, tokenId)
  if (token.status !== 'Called') {
    throw new DomainError('INVALID_TRANSITION', 'Only a called token can be recalled.')
  }
  const willMarkNoShow = token.recalled
  const now = Date.now()

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      {
        text: willMarkNoShow ? 'Patient marked as no-show' : 'Patient recalled',
        meta: `${token.tokenNumber} · ${patientName(current, token.patientId)}`,
      },
    ])
    return {
      ...current,
      queueTokens: current.queueTokens.map((t) => {
        if (t.tokenId !== tokenId) return t
        return willMarkNoShow ? { ...t, status: 'No-show' as const, completedAt: now } : { ...t, recalled: true }
      }),
      visits: willMarkNoShow
        ? current.visits.map((v) => (v.visitId === token.visitId ? { ...v, status: 'Closed' as const, closedAt: now } : v))
        : current.visits,
      appointments: willMarkNoShow
        ? current.appointments.map((a) => {
            const visit = current.visits.find((v) => v.visitId === token.visitId)
            return visit?.appointmentId && a.appointmentId === visit.appointmentId ? { ...a, status: 'No-show' as const } : a
          })
        : current.appointments,
      activityLog,
      nextIds: { ...current.nextIds, activity: activitySeq },
    }
  })
}

// ------------------------------------------------------------------ doctors
// Doctor Management creates the doctor's HOSPITAL PROFILE — identity,
// department, schedule config and account status. It deliberately contains
// no clinical capability: registering a doctor here makes them bookable and
// visible to the front desk, nothing more.

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function registerDoctor(input: RegisterDoctorInput): Provider {
  const state = getState()
  const name = input.name?.trim()
  if (!name) throw new DomainError('VALIDATION', 'Doctor name is required.')
  if (!input.department) throw new DomainError('VALIDATION', 'Department is required.')
  if (!input.specialty?.trim()) throw new DomainError('VALIDATION', 'Specialty is required.')
  if (!input.mobile?.trim()) throw new DomainError('VALIDATION', 'Mobile number is required.')
  if (!isValidMobile(input.mobile.trim())) throw new DomainError('VALIDATION', MOBILE_ERROR)
  if (!input.registrationNumber?.trim()) {
    throw new DomainError('VALIDATION', 'Medical registration number is required.')
  }
  const schedule = input.schedule ?? {}
  if (!schedule.workingDays?.length) throw new DomainError('VALIDATION', 'Select at least one working day.')
  if (!schedule.startTime || !schedule.endTime) throw new DomainError('VALIDATION', 'Working hours are required.')
  if (schedule.startTime >= schedule.endTime) {
    throw new DomainError('VALIDATION', 'Session end time must be after the start time.')
  }

  const base = slugify(name) || `doctor-${state.nextIds.provider}`
  let providerId = base
  let suffix = 2
  while (state.providers.some((p) => p.providerId === providerId)) {
    providerId = `${base}-${suffix++}`
  }

  const provider: Provider = {
    providerId,
    name,
    gender: input.gender ?? 'Other',
    dateOfBirth: input.dateOfBirth || null,
    mobile: input.mobile.trim(),
    email: input.email?.trim() || null,
    photoUrl: input.photoUrl || null,
    department: input.department,
    specialty: input.specialty.trim(),
    qualification: input.qualification?.trim() || null,
    registrationNumber: input.registrationNumber.trim(),
    experienceYears: Number(input.experienceYears) || 0,
    employeeId: input.employeeId?.trim() || `SHRI-DOC-${String(100 + state.nextIds.provider)}`,
    consultationType: input.consultationType ?? 'Outpatient',
    consultationFee: Number(input.consultationFee) || 0,
    room: input.room?.trim() || null,
    loginEmail: input.loginEmail?.trim() || input.email?.trim() || null,
    role: input.role ?? 'Consultant',
    status: input.status ?? 'Active',
    schedule: {
      workingDays: schedule.workingDays,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      slotMinutes: Number(schedule.slotMinutes) || 15,
      breaks: schedule.breaks ?? [],
    },
    createdAt: Date.now(),
  }

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Doctor registered', meta: `${provider.name} · ${provider.department}` },
    ])
    return {
      ...current,
      providers: [...current.providers, provider],
      activityLog,
      nextIds: { ...current.nextIds, provider: current.nextIds.provider + 1, activity: activitySeq },
    }
  })

  return provider
}

export function updateDoctor(providerId: string, changes: DoctorChanges): void {
  const state = getState()
  if (!state.providers.some((p) => p.providerId === providerId)) {
    throw new DomainError('NOT_FOUND', 'That doctor no longer exists.')
  }
  setState((current) => ({
    ...current,
    providers: current.providers.map((p) => (p.providerId === providerId ? { ...p, ...changes } : p)),
  }))
}

export function setDoctorStatus(providerId: string, status: ProviderStatus): void {
  const state = getState()
  const provider = state.providers.find((p) => p.providerId === providerId)
  if (!provider) throw new DomainError('NOT_FOUND', 'That doctor no longer exists.')
  if (status === 'Inactive') {
    const openCount = state.appointments.filter(
      (a) =>
        a.providerId === providerId &&
        a.date >= state.today &&
        ['Scheduled', 'Payment Pending', 'Confirmed'].includes(a.status),
    ).length
    if (openCount > 0) {
      throw new DomainError(
        'HAS_OPEN_APPOINTMENTS',
        `${provider.name} still has ${openCount} open ${openCount === 1 ? 'appointment' : 'appointments'}. ` +
          'Cancel or reassign them before deactivating.',
      )
    }
  }

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: status === 'Active' ? 'Doctor activated' : 'Doctor deactivated', meta: provider.name },
    ])
    return {
      ...current,
      providers: current.providers.map((p) => (p.providerId === providerId ? { ...p, status } : p)),
      activityLog,
      nextIds: { ...current.nextIds, activity: activitySeq },
    }
  })
}

export function addDoctorLeave(providerId: string, date: string, reason: string = 'Leave'): string {
  const state = getState()
  const provider = state.providers.find((p) => p.providerId === providerId)
  if (!provider) throw new DomainError('NOT_FOUND', 'That doctor no longer exists.')
  if (!date) throw new DomainError('VALIDATION', 'Choose a date.')
  const today = todayKey()
  if (date < today) throw new DomainError('VALIDATION', 'Leave can only be recorded for today or a later day.')
  if (state.leaves.some((l) => l.providerId === providerId && l.date === date)) {
    throw new DomainError('DUPLICATE', 'Leave is already recorded for that date.')
  }
  if (date === today && state.queueTokens.some((t) => t.providerId === providerId && ['Waiting', 'Called', 'In consultation'].includes(t.status))) {
    throw new DomainError('HAS_OPEN_APPOINTMENTS', `Patients are still waiting for ${provider.name} today — see them or send them to another doctor first.`)
  }
  const affected = state.appointments.filter(
    (a) =>
      a.providerId === providerId &&
      a.date === date &&
      ['Scheduled', 'Payment Pending', 'Confirmed', 'Checked-in'].includes(a.status),
  )
  if (affected.length > 0) {
    throw new DomainError(
      'HAS_OPEN_APPOINTMENTS',
      `${affected.length} ${affected.length === 1 ? 'appointment is' : 'appointments are'} booked on that date. Cancel or reschedule them first.`,
    )
  }

  const leaveId = `leave-${state.nextIds.leave}`
  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Doctor leave recorded', meta: `${provider.name} · ${date}` },
    ])
    return {
      ...current,
      leaves: [...current.leaves, { leaveId, providerId, date, reason }],
      activityLog,
      nextIds: { ...current.nextIds, leave: current.nextIds.leave + 1, activity: activitySeq },
    }
  })
  return leaveId
}

export function removeDoctorLeave(leaveId: string): void {
  setState((current) => ({ ...current, leaves: current.leaves.filter((l) => l.leaveId !== leaveId) }))
}

// --------------------------------------------------------- patient records

/** Counts a profile being opened — feeds the search box's "Most opened". */
export function recordPatientOpen(patientId: string): void {
  const state = getState()
  if (!state.patients.some((p) => p.patientId === patientId)) return
  setState((current) => {
    const stat = current.patientOpens[patientId]
    return {
      ...current,
      patientOpens: { ...current.patientOpens, [patientId]: { count: (stat?.count ?? 0) + 1, lastOpenedAt: Date.now() } },
    }
  })
}

export function updatePatientDemographics(patientId: string, changes: PatientDemographicsInput): void {
  const state = getState()
  const patient = state.patients.find((p) => p.patientId === patientId)
  if (!patient) throw new DomainError('NOT_FOUND', 'That patient no longer exists.')
  // Same rules as registration, for whichever fields are being changed.
  const problem =
    (changes.name !== undefined ? nameError(changes.name) : null) ??
    (changes.age !== undefined ? ageError(changes.age) : null) ??
    (changes.sex !== undefined ? sexError(changes.sex) : null) ??
    (changes.mobile !== undefined ? mobileError(changes.mobile) : null) ??
    (changes.email !== undefined ? emailError(changes.email) : null) ??
    (changes.address !== undefined ? addressError(changes.address) : null)
  if (problem) throw new DomainError('VALIDATION', problem)
  if (changes.age !== undefined && Number(changes.age) !== patient.age && ageNeedsConfirmation(changes.age) && !changes.ageConfirmed) {
    throw new DomainError('VALIDATION', `Confirm the age (${Number(changes.age)}) with the patient first.`)
  }

  const next: Partial<Patient> = {}
  if (changes.name !== undefined) next.name = normalizeName(changes.name)
  if (changes.age !== undefined) next.age = Number(changes.age)
  if (changes.sex !== undefined) next.sex = changes.sex
  if (changes.mobile !== undefined) next.mobile = formatMobile(changes.mobile)
  if (changes.email !== undefined) next.email = changes.email?.trim() || null
  if (changes.address !== undefined) next.address = changes.address?.trim() || null

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Demographics updated', meta: `${patient.name} · ${patient.uhid}` },
    ])
    return {
      ...current,
      patients: current.patients.map((p) => (p.patientId === patientId ? { ...p, ...next } : p)),
      activityLog,
      nextIds: { ...current.nextIds, activity: activitySeq },
    }
  })
}

export function linkAbha(patientId: string, abhaId: string): void {
  const state = getState()
  const patient = state.patients.find((p) => p.patientId === patientId)
  if (!patient) throw new DomainError('NOT_FOUND', 'That patient no longer exists.')
  if (!abhaId?.trim()) throw new DomainError('VALIDATION', 'Enter an ABHA number or address.')
  const problem = abhaError(abhaId)
  if (problem) throw new DomainError('VALIDATION', problem)
  const value = normalizeAbha(abhaId)
  assertAbhaFree(state, value, patientId)

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'ABHA linked', meta: `${patient.name} · ${value}` },
    ])
    return {
      ...current,
      patients: current.patients.map((p) => (p.patientId === patientId ? { ...p, abhaId: value } : p)),
      activityLog,
      nextIds: { ...current.nextIds, activity: activitySeq },
    }
  })
}

// -------------------------------------------------------- front desk services

/** Prints a pass — for a patient's visitor, a visiting doctor, or staff and
 *  service people without a hospital ID. Every pass names its holder, the
 *  ID proof seen, and who confirmed the visit; nothing is printed unchecked. */
export function issueGuestPass(input: IssueGuestPassInput): GuestPass {
  const state = getState()
  const now = Date.now()
  const holderName = input.holderName?.trim() ?? ''
  const nameProblem = nameError(holderName)
  if (nameProblem) throw new DomainError('VALIDATION', `Visitor's name: ${nameProblem}`)
  if (!isValidMobile(input.holderMobile)) throw new DomainError('VALIDATION', MOBILE_ERROR)
  if (!input.idType?.trim() || !/^[A-Za-z0-9]{4}$/.test(input.idLast4?.trim() ?? '')) {
    throw new DomainError('VALIDATION', 'Record the ID proof seen — its kind and last four characters.')
  }
  if (!input.purpose?.trim() && input.type !== 'Patient visitor') throw new DomainError('VALIDATION', 'Say why they are visiting.')
  if (!input.confirmed) throw new DomainError('VALIDATION', 'Confirm the visit before printing the pass — nobody is let in unchecked.')

  let patientId: string | null = null
  let patientName: string | null = null
  let hostName: string | null = null
  let ward: string
  let code: string
  let verifiedWith = input.verifiedWith?.trim() ?? ''
  const endOfDay = dayStartTimestamp(todayKey(new Date(now))) + 24 * 60 * 60 * 1000 - 1

  if (input.type === 'Patient visitor') {
    const patient = state.patients.find((p) => p.patientId === input.patientId)
    if (!patient) throw new DomainError('VALIDATION', 'Select the patient they are visiting.')
    const stay = state.admissions.find((a) => a.patientId === patient.patientId && a.status === 'Admitted')
    if (!stay?.wardLabel) throw new DomainError('VALIDATION', `${patient.name} is not admitted — visitor passes are for inpatients.`)
    if (state.guestPasses.some((p) => p.patientId === patient.patientId && !p.returned)) {
      throw new DomainError('PASS_LIMIT', `${patient.name} already has a visitor pass out. One visitor at a time — return that pass first.`)
    }
    if (!input.relationship?.trim()) throw new DomainError('VALIDATION', 'Choose how they are related to the patient.')
    if (!verifiedWith) throw new DomainError('VALIDATION', 'Name the patient or attendant who confirmed this visitor.')
    patientId = patient.patientId
    patientName = patient.name
    ward = stay.wardLabel
    code = ward.toUpperCase()
  } else if (input.type === 'Visiting doctor') {
    const host = state.providers.find((p) => p.providerId === input.hostProviderId)
    if (!host || host.status !== 'Active') throw new DomainError('VALIDATION', 'Choose the hospital doctor they are visiting.')
    hostName = host.name
    ward = host.department
    verifiedWith = host.name
    code = 'VDR'
  } else {
    if (!input.area?.trim()) throw new DomainError('VALIDATION', 'Choose the department or area they need.')
    if (!verifiedWith) throw new DomainError('VALIDATION', 'Name the staff member who authorised this visit.')
    hostName = verifiedWith
    ward = input.area.trim()
    code = 'STF'
  }

  const seq = state.nextIds.pass
  const pass: GuestPass = {
    passId: `GP/${code}/${String(1000 + seq).slice(1)}`,
    type: input.type,
    holderName: normalizeName(holderName),
    holderMobile: formatMobile(input.holderMobile),
    idProof: `${input.idType.trim()} ••${input.idLast4.trim().toUpperCase()}`,
    patientId,
    patientName,
    hostName,
    ward,
    relationship: input.type === 'Visiting doctor' ? 'Visiting doctor' : input.relationship.trim(),
    purpose: input.purpose?.trim() || (input.type === 'Patient visitor' ? 'Visiting the patient' : ''),
    verifiedWith,
    issuedBy: input.issuedBy,
    // A visitor's pass runs a day at a time; others end with the day.
    validUntil: input.type === 'Patient visitor' ? now + 24 * 60 * 60 * 1000 : endOfDay,
    issuedAt: now,
    returnedAt: null,
    returned: false,
  }

  setState(
    logged({ ...state, guestPasses: [...state.guestPasses, pass], nextIds: { ...state.nextIds, pass: seq + 1 } }, [
      {
        text: 'Guest pass printed',
        meta: `${pass.passId} · ${pass.holderName} · ${patientName ? `visiting ${patientName}` : `for ${hostName}`} · confirmed with ${verifiedWith}`,
      },
    ]),
  )
  return pass
}

export function returnGuestPass(passId: string): void {
  const state = getState()
  const pass = state.guestPasses.find((p) => p.passId === passId)
  if (!pass) throw new DomainError('NOT_FOUND', 'That pass no longer exists.')
  if (pass.returned) throw new DomainError('INVALID_TRANSITION', 'That pass has already been returned.')

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Guest pass returned', meta: `${passId} · ${pass.patientName}` },
    ])
    return {
      ...current,
      guestPasses: current.guestPasses.map((p) =>
        p.passId === passId ? { ...p, returned: true, returnedAt: Date.now() } : p,
      ),
      activityLog,
      nextIds: { ...current.nextIds, activity: activitySeq },
    }
  })
}

function estimateTotal(items: Estimate['items']): number {
  // Plain arithmetic over the hospital's own rate card — rates are never
  // estimated or predicted.
  return items.reduce((sum, item) => sum + item.rate * (item.quantity ?? 1), 0)
}

function activeEstimateIndex(state: AppState, patientId: string): number {
  return state.estimates.findIndex((e) => e.patientId === patientId && e.status !== 'Cancelled')
}

/** The single entry point for adding a service to a patient's estimate —
 *  finds that patient's open estimate (Draft/Saved) or starts one, then
 *  either bumps an existing line's quantity or appends a new one. An
 *  estimate can never exist without a patient: there is no anonymous/global
 *  estimate for staff to accidentally add into. */
export function addEstimateItem({ patientId, patientName, item }: AddEstimateItemInput): Estimate {
  const state = getState()
  if (!patientId) throw new DomainError('VALIDATION', 'Select a patient before adding a service.')
  const patient = state.patients.find((p) => p.patientId === patientId)
  if (!patient) throw new DomainError('NOT_FOUND', 'That patient no longer exists.')

  let saved!: Estimate
  setState((current) => {
    const index = activeEstimateIndex(current, patientId)
    let estimates: Estimate[]
    let nextIds = current.nextIds
    let logMeta: string

    if (index === -1) {
      const seq = current.nextIds.estimate
      const estimateId = `EST/${String(seq).padStart(5, '0')}`
      const items = [{ ...item, quantity: item.quantity ?? 1 }]
      saved = {
        estimateId,
        patientId,
        patientName,
        items,
        total: estimateTotal(items),
        payer: 'Self-pay',
        status: 'Draft',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      estimates = [...current.estimates, saved]
      nextIds = { ...current.nextIds, estimate: seq + 1 }
      logMeta = `${estimateId} · ${item.name} for ${patientName}`
    } else {
      const existing = current.estimates[index]
      const itemIndex = existing.items.findIndex((i) => i.code === item.code)
      const items =
        itemIndex === -1
          ? [...existing.items, { ...item, quantity: item.quantity ?? 1 }]
          : existing.items.map((i, idx) =>
              idx === itemIndex ? { ...i, quantity: (i.quantity ?? 1) + (item.quantity ?? 1) } : i,
            )
      saved = { ...existing, items, total: estimateTotal(items), updatedAt: Date.now() }
      estimates = current.estimates.map((e, idx) => (idx === index ? saved : e))
      logMeta = `${saved.estimateId} · ${item.name} for ${patientName}`
    }

    const { activityLog, activitySeq } = withActivity(current, [{ text: 'Estimate item added', meta: logMeta }])
    return { ...current, estimates, activityLog, nextIds: { ...nextIds, activity: activitySeq } }
  })

  return saved
}

export function updateEstimateItemQuantity({ estimateId, code, quantity }: UpdateEstimateItemQuantityInput): Estimate {
  const state = getState()
  const estimate = state.estimates.find((e) => e.estimateId === estimateId)
  if (!estimate) throw new DomainError('NOT_FOUND', 'That estimate no longer exists.')
  if (!Number.isFinite(quantity) || quantity < 1) {
    throw new DomainError('VALIDATION', 'Quantity must be at least 1 — remove the item instead of setting it to 0.')
  }

  let saved!: Estimate
  setState((current) => {
    const estimates = current.estimates.map((e) => {
      if (e.estimateId !== estimateId) return e
      const items = e.items.map((i) => (i.code === code ? { ...i, quantity } : i))
      saved = { ...e, items, total: estimateTotal(items), updatedAt: Date.now() }
      return saved
    })
    return { ...current, estimates }
  })

  return saved
}

export function removeEstimateItem({ estimateId, code }: RemoveEstimateItemInput): Estimate {
  const state = getState()
  const estimate = state.estimates.find((e) => e.estimateId === estimateId)
  if (!estimate) throw new DomainError('NOT_FOUND', 'That estimate no longer exists.')

  let saved!: Estimate
  setState((current) => {
    const estimates = current.estimates.map((e) => {
      if (e.estimateId !== estimateId) return e
      const items = e.items.filter((i) => i.code !== code)
      saved = { ...e, items, total: estimateTotal(items), updatedAt: Date.now() }
      return saved
    })
    return { ...current, estimates }
  })

  return saved
}

/** Marks the estimate reviewed and ready — items stay editable afterward
 *  (front-desk work is rarely a single pass), this just moves it out of
 *  Draft so it reads as a real record staff can print or bill against. */
export function saveEstimate(estimateId: string): Estimate {
  const state = getState()
  const estimate = state.estimates.find((e) => e.estimateId === estimateId)
  if (!estimate) throw new DomainError('NOT_FOUND', 'That estimate no longer exists.')
  if (estimate.status === 'Cancelled') throw new DomainError('INVALID_TRANSITION', 'This estimate was cancelled.')
  if (!estimate.items.length) throw new DomainError('VALIDATION', 'Add at least one service before saving.')

  let saved!: Estimate
  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Estimate saved', meta: `${estimateId} · ${formatRupees(estimate.total)} · ${estimate.patientName}` },
    ])
    const estimates = current.estimates.map((e) => {
      if (e.estimateId !== estimateId) return e
      saved = { ...e, status: e.status === 'Draft' ? 'Saved' : e.status, updatedAt: Date.now() }
      return saved
    })
    return { ...current, estimates, activityLog, nextIds: { ...current.nextIds, activity: activitySeq } }
  })

  return saved
}

export function registerMlc({ patientId, category, broughtBy, policeStation, incidentAt }: RegisterMlcInput): MlcRecord {
  const state = getState()
  const patient = state.patients.find((p) => p.patientId === patientId)
  if (!patient) throw new DomainError('VALIDATION', 'An MLC is always recorded against a patient — select one first.')
  if (!category) throw new DomainError('VALIDATION', 'MLC category is required.')
  if (!broughtBy?.trim()) throw new DomainError('VALIDATION', 'Record who brought the patient in.')
  if (!policeStation?.trim()) throw new DomainError('VALIDATION', 'Police station is required.')

  const seq = state.nextIds.mlc
  const mlcId = `MLC/${String(seq).padStart(4, '0')}`
  const record: MlcRecord = {
    mlcId,
    patientId,
    patientName: patient.name,
    category,
    broughtBy: broughtBy.trim(),
    policeStation: policeStation.trim(),
    incidentAt: incidentAt || null,
    registeredAt: Date.now(),
    // Acknowledgement of the police intimation is captured, never assumed.
    intimationSent: false,
    acknowledgedAt: null,
  }

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'MLC registered', meta: `${mlcId} · ${patient.name}` },
    ])
    return {
      ...current,
      mlcRecords: [...current.mlcRecords, record],
      activityLog,
      nextIds: { ...current.nextIds, mlc: seq + 1, activity: activitySeq },
    }
  })

  return record
}

export function markMlcIntimationSent(mlcId: string): void {
  const state = getState()
  const record = state.mlcRecords.find((r) => r.mlcId === mlcId)
  if (!record) throw new DomainError('NOT_FOUND', 'That MLC record no longer exists.')

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Police intimation sent', meta: `${mlcId} · ${record.policeStation}` },
    ])
    return {
      ...current,
      mlcRecords: current.mlcRecords.map((r) => (r.mlcId === mlcId ? { ...r, intimationSent: true } : r)),
      activityLog,
      nextIds: { ...current.nextIds, activity: activitySeq },
    }
  })
}

export function acknowledgeMlcIntimation(mlcId: string): void {
  const state = getState()
  const record = state.mlcRecords.find((r) => r.mlcId === mlcId)
  if (!record) throw new DomainError('NOT_FOUND', 'That MLC record no longer exists.')
  if (!record.intimationSent) throw new DomainError('INVALID_TRANSITION', 'Send the intimation memo first.')

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Police acknowledgement captured', meta: mlcId },
    ])
    return {
      ...current,
      mlcRecords: current.mlcRecords.map((r) => (r.mlcId === mlcId ? { ...r, acknowledgedAt: Date.now() } : r)),
      activityLog,
      nextIds: { ...current.nextIds, activity: activitySeq },
    }
  })
}

// --------------------------------------------------------------- payments
// A Payment is one administrative bill — never a clinical charge. It is
// raised (createPaymentBill), collected against in one or more transactions
// (collectPayment, so partial payments are a first-class case), and can end
// in one of two ways: a full or partial refund (refundPayment) once money
// has moved, or a cancellation (cancelPayment) if nothing has been
// collected yet. Nothing here is a real payment gateway — collectPayment
// only ever records the simulated RESULT of a collection, never a card
// number, CVV, bank credential or UPI PIN.

function paymentTransactionId(state: AppState): { transactionId: string; nextSeq: number } {
  const seq = state.nextIds.transaction
  return { transactionId: `TXN-${String(seq).padStart(6, '0')}`, nextSeq: seq + 1 }
}

/** Raises a bill. */
function applyNewBill(
  state: AppState,
  { patientId, items, appointmentId, estimateId, admissionId }: CreatePaymentInput,
  now: number,
): Step<Payment> {
  const patient = state.patients.find((p) => p.patientId === patientId)
  if (!patient) throw new DomainError('VALIDATION', 'Select a patient first.')
  if (!items?.length) throw new DomainError('VALIDATION', 'Add at least one charge to the bill.')

  const seq = state.nextIds.payment
  const total = items.reduce((sum, item) => sum + item.amount, 0)
  const payment: Payment = {
    paymentId: `pay-${seq}`,
    receiptNo: `RCT-${String(seq).padStart(6, '0')}`,
    patientId,
    patientName: patient.name,
    appointmentId: appointmentId ?? null,
    estimateId: estimateId ?? null,
    admissionId: admissionId ?? null,
    items,
    totalAmount: total,
    paidAmount: 0,
    balance: total,
    status: 'Pending',
    transactions: [],
    failedAttempts: [],
    refund: null,
    createdAt: now,
    updatedAt: now,
    cancelledAt: null,
    cancelReason: null,
  }
  const next = logged(
    { ...state, payments: [...state.payments, payment], nextIds: { ...state.nextIds, payment: seq + 1 } },
    [{ text: 'Payment bill created', meta: `${patient.name} · ${formatRupees(total)}` }],
  )
  return { state: next, value: payment }
}

/** Records money collected on a bill. Fully paying a booking's bill
 *  confirms that one booking. */
function applyCollection(state: AppState, { paymentId, amount, method }: CollectPaymentInput, now: number): Step<Payment> {
  const payment = requirePayment(state, paymentId)
  if (payment.status === 'Cancelled' || payment.status === 'Refunded') {
    throw new DomainError('INVALID_TRANSITION', `This bill is ${payment.status.toLowerCase()} — no payment can be collected on it.`)
  }
  if (!(amount > 0)) throw new DomainError('VALIDATION', 'Enter an amount greater than zero.')
  if (amount > payment.balance) {
    throw new DomainError('VALIDATION', `That is more than the ${formatRupees(payment.balance)} balance due.`)
  }
  // Only a stay billed to an insurer, TPA or company is settled by that payer.
  if (method === 'Insurance/TPA') {
    const admission = payment.admissionId ? state.admissions.find((a) => a.admissionId === payment.admissionId) : undefined
    if (!admission || admission.paymentType === 'Self Pay') {
      throw new DomainError('VALIDATION', 'Only an insured inpatient’s bill can be settled by the insurer.')
    }
  }

  const { transactionId, nextSeq } = paymentTransactionId(state)
  const paidAmount = payment.paidAmount + amount
  const balance = payment.totalAmount - paidAmount
  const status = balance <= 0 ? 'Paid' : 'Partially Paid'
  const updated: Payment = {
    ...payment,
    paidAmount,
    balance: Math.max(0, balance),
    status,
    transactions: [...payment.transactions, { transactionId, amount, method, collectedAt: now }],
    updatedAt: now,
  }

  // Only the booking this bill was blocking moves from "awaiting payment"
  // to Confirmed — never every booking the patient has, and never one that
  // has already moved on.
  const linkedAppointment =
    status === 'Paid' && payment.appointmentId ? state.appointments.find((a) => a.appointmentId === payment.appointmentId) : undefined
  const confirms = linkedAppointment?.status === 'Payment Pending'

  const next = logged(
    {
      ...state,
      payments: state.payments.map((p) => (p.paymentId === paymentId ? updated : p)),
      appointments: confirms
        ? state.appointments.map((a) => (a.appointmentId === payment.appointmentId ? { ...a, status: 'Confirmed' as const } : a))
        : state.appointments,
      nextIds: { ...state.nextIds, transaction: nextSeq },
    },
    [
      {
        text: status === 'Paid' ? 'Payment received at the billing counter' : 'Part payment received at the billing counter',
        meta:
          status === 'Paid'
            ? `${payment.patientName} · ${formatRupees(amount)} · ${method}`
            : `${payment.patientName} · ${formatRupees(paidAmount)} of ${formatRupees(payment.totalAmount)}`,
      },
      ...(confirms ? [{ text: 'Appointment confirmed', meta: `${payment.patientName} · payment received` }] : []),
    ],
  )
  return { state: next, value: updated }
}

/** Gives back everything collected on a bill, by the methods it came in. */
function applyFullRefund(state: AppState, paymentId: string, reason: string, now: number): Step<Payment> {
  const payment = requirePayment(state, paymentId)
  if ((payment.status !== 'Paid' && payment.status !== 'Partially Paid') || !(payment.paidAmount > 0)) {
    throw new DomainError('INVALID_TRANSITION', 'Only a bill with money collected on it can be refunded.')
  }
  if (!reason.trim()) throw new DomainError('VALIDATION', 'A refund reason is required.')
  const methods = [...new Set(payment.transactions.map((t) => t.method))]
  const updated: Payment = {
    ...payment,
    status: 'Refunded',
    refund: {
      refundId: `RFD-${payment.receiptNo.replace('RCT-', '')}`,
      amount: payment.paidAmount,
      reason: reason.trim(),
      refundedAt: now,
      methods,
    },
    updatedAt: now,
  }
  const next = logged({ ...state, payments: state.payments.map((p) => (p.paymentId === paymentId ? updated : p)) }, [
    {
      text: 'Payment refunded',
      meta: `${payment.patientName} · ${payment.receiptNo} · ${formatRupees(payment.paidAmount)} · ${methods.join(' + ')}`,
    },
  ])
  return { state: next, value: updated }
}

/** Closes a bill nothing was collected on. */
function applyBillCancel(state: AppState, paymentId: string, reason: string, now: number): Step<Payment> {
  const payment = requirePayment(state, paymentId)
  if (payment.paidAmount > 0) {
    throw new DomainError('INVALID_TRANSITION', 'Money has already been collected against this bill — refund it instead of cancelling.')
  }
  if (payment.status !== 'Pending') {
    throw new DomainError('INVALID_TRANSITION', `This bill is ${payment.status.toLowerCase()} — it can't be cancelled.`)
  }
  if (!reason.trim()) throw new DomainError('VALIDATION', 'A cancellation reason is required.')
  const updated: Payment = { ...payment, status: 'Cancelled', cancelledAt: now, cancelReason: reason.trim(), updatedAt: now }
  const next = logged({ ...state, payments: state.payments.map((p) => (p.paymentId === paymentId ? updated : p)) }, [
    { text: 'Payment bill cancelled', meta: `${payment.patientName} · ${payment.receiptNo} · ${reason.trim()}` },
  ])
  return { state: next, value: updated }
}

export function createPaymentBill(input: CreatePaymentInput): Payment {
  const { state, value } = applyNewBill(getState(), input, Date.now())
  setState(state)
  return value
}

export function collectPayment(input: CollectPaymentInput): Payment {
  const { state, value } = applyCollection(getState(), input, Date.now())
  setState(state)
  return value
}

/** Records a collection that did not go through — the UPI payment never
 *  arrived, the card was declined. No money moves; the bill reads "Failed"
 *  until the next successful collection. */
export function recordFailedPayment({ paymentId, amount, method, reason }: RecordFailedPaymentInput): Payment {
  const state = getState()
  const payment = requirePayment(state, paymentId)
  if (payment.status === 'Cancelled' || payment.status === 'Refunded') {
    throw new DomainError('INVALID_TRANSITION', `This bill is ${payment.status.toLowerCase()} — no payment can be recorded on it.`)
  }
  if (!(payment.balance > 0)) throw new DomainError('INVALID_TRANSITION', 'Nothing is due on this bill.')
  if (!(amount > 0) || amount > payment.balance) {
    throw new DomainError('VALIDATION', `Enter an amount up to the ${formatRupees(payment.balance)} due.`)
  }

  const now = Date.now()
  const seq = state.nextIds.attempt
  const updated: Payment = {
    ...payment,
    failedAttempts: [
      ...payment.failedAttempts,
      { attemptId: `ATT-${String(seq).padStart(6, '0')}`, amount, method, reason: reason.trim() || 'Payment not completed', attemptedAt: now },
    ],
    updatedAt: now,
  }

  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Payment attempt failed', meta: `${payment.patientName} · ${formatRupees(amount)} · ${method} · ${updated.failedAttempts[updated.failedAttempts.length - 1].reason}` },
    ])
    return {
      ...current,
      payments: current.payments.map((p) => (p.paymentId === paymentId ? updated : p)),
      activityLog,
      nextIds: { ...current.nextIds, attempt: seq + 1, activity: activitySeq },
    }
  })

  return updated
}

/** Cancels a bill on its own — only one nothing was collected on, and not
 *  one held by an open booking or a current stay (getBillLock). */
export function cancelPayment({ paymentId, reason }: CancelPaymentInput): void {
  const state = getState()
  const lock = getBillLock(state, requirePayment(state, paymentId))
  if (lock) throw new DomainError('INVALID_TRANSITION', lock)
  setState(applyBillCancel(state, paymentId, reason ?? '', Date.now()).state)
}

/** Refunds a bill in full, on its own — not one held by a booking or a
 *  current stay (getBillLock); a booking's fee is refunded by cancelling
 *  the booking because the doctor is unavailable. */
export function refundPayment({ paymentId, reason }: RefundPaymentInput): Payment {
  const state = getState()
  const payment = requirePayment(state, paymentId)
  const lock = getBillLock(state, payment)
  if (lock) throw new DomainError('INVALID_TRANSITION', lock)
  const { state: next, value } = applyFullRefund(state, paymentId, reason ?? '', Date.now())
  setState(next)
  return value
}

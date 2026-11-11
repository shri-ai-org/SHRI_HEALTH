// Pure, read-only derivations over store state. Nothing here mutates
// anything — every function takes `state` (and a `now` timestamp where time
// matters) and computes a fresh value. This is the ONLY place doctor
// status, slot availability, waiting time, queue position and the
// dashboard's numbers are computed. No screen hardcodes any of them.
import { slotToTimestamp, slotLabel, dayStartTimestamp, minutesBetween, todayKey } from './time'
import type { AppState } from '../types/store'
import type { Patient, PatientSearchMatch } from '../types/patient'
import type { Provider, DoctorRow, DoctorStatus } from '../types/doctor'
import type { DoctorLeave, DoctorSchedule, ScheduleBreak } from '../types/schedule'
import type { Appointment, AppointmentRow, PatientAppointmentRow, SlotBoardEntry } from '../types/appointment'
import type { QueueTokenRow, QueueView } from '../types/queue'
import type { GuestPass, Estimate, MlcRecord, Tariff } from '../types/frontDesk'
import type { Connectivity } from '../types/connectivity'
import type { Payment, PaymentItem, PaymentSummary } from '../types/payment'
import { billDisplayStatus, billNumberFor, formatRupees, isBillDue } from '../utils/billing'
import { abhaError, abhaKind, normalizeAbha } from '../utils/validation'

// Only a CANCELLED appointment releases its slot. Completed and No-show
// appointments still occupy the slot they were booked into.
const RELEASED_APPOINTMENT_STATUSES = ['Cancelled']
const LATE_THRESHOLD_MINUTES = 10
const LONG_WAIT_MINUTES = 15

/** The operational day (YYYY-MM-DD) the store is running on. */
export function getToday(state: AppState): string {
  return state.today
}

export function getProviders(state: AppState): Provider[] {
  return state.providers
}

export function getPatientById(state: AppState, patientId: string): Patient | null {
  return state.patients.find((p) => p.patientId === patientId) ?? null
}

export function getProviderById(state: AppState, providerId: string): Provider | null {
  return state.providers.find((p) => p.providerId === providerId) ?? null
}

/** Departments the desk reaches for first, in this order; the rest follow alphabetically. */
const DEPARTMENT_ORDER = ['General Medicine', 'Emergency']

/** General Medicine first, Emergency second, then the rest A–Z — for any list of departments. */
export function compareDepartments(a: string, b: string): number {
  const rank = (d: string) => (DEPARTMENT_ORDER.includes(d) ? DEPARTMENT_ORDER.indexOf(d) : DEPARTMENT_ORDER.length)
  return rank(a) - rank(b) || a.localeCompare(b)
}

export function getDepartments(state: AppState): string[] {
  return [...new Set(state.providers.map((p) => p.department))].sort(compareDepartments)
}

export function getSpecialties(state: AppState): string[] {
  return [...new Set(state.providers.map((p) => p.specialty))].sort()
}

export function getTariffs(state: AppState): Tariff[] {
  return state.tariffs
}

export function getGuestPasses(state: AppState): GuestPass[] {
  return [...state.guestPasses].sort((a, b) => b.issuedAt - a.issuedAt)
}

/** A patient's guest passes still out. */
export function getActiveGuestPasses(state: AppState, patientId: string): GuestPass[] {
  return state.guestPasses.filter((p) => p.patientId === patientId && !p.returned)
}

/** The bill an estimate became, once it was paid — an estimate is billed once. */
export function getBillForEstimate(state: AppState, estimateId: string): Payment | null {
  if (!estimateId) return null
  return state.payments.find((p) => p.estimateId === estimateId && p.status !== 'Cancelled') ?? null
}

/** The one estimate a patient is currently working on — Cancelled ones don't
 *  count, so a fresh Add after a cancellation starts a clean estimate rather
 *  than reviving the old one. */
export function getActiveEstimateForPatient(state: AppState, patientId: string): Estimate | null {
  if (!patientId) return null
  return state.estimates.find((e) => e.patientId === patientId && e.status !== 'Cancelled') ?? null
}

export function getMlcRecords(state: AppState): MlcRecord[] {
  return [...state.mlcRecords].sort((a, b) => b.registeredAt - a.registeredAt)
}

export function getDoctorLeaves(state: AppState, providerId: string): DoctorLeave[] {
  return state.leaves.filter((leave) => leave.providerId === providerId).sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * The doctor's session for a date, COMPUTED from their schedule config
 * (working days + hours + slot length) rather than stored per-day. This is
 * what lets a doctor registered a minute ago be immediately bookable, and
 * lets booking work for any date — not just today.
 */
export function getDoctorSchedule(state: AppState, providerId: string, date: string = state.today): DoctorSchedule | null {
  const provider = getProviderById(state, providerId)
  if (!provider || provider.status !== 'Active' || !provider.schedule) return null

  const config = provider.schedule
  const dayOfWeek = new Date(dayStartTimestamp(date)).getDay()
  if (!config.workingDays.includes(dayOfWeek)) return null

  const leave = state.leaves.find((item) => item.providerId === providerId && item.date === date)
  const slots: string[] = []
  const startTs = slotToTimestamp(date, config.startTime)
  const endTs = slotToTimestamp(date, config.endTime)
  for (let ts = startTs; ts <= endTs; ts += config.slotMinutes * 60000) slots.push(slotLabel(ts))

  return {
    providerId,
    date,
    slots,
    breaks: config.breaks ?? [],
    onLeave: Boolean(leave),
    leaveReason: leave?.reason ?? null,
    sessionStart: config.startTime,
    sessionEnd: config.endTime,
    slotMinutes: config.slotMinutes,
  }
}

function isWithinBreak(schedule: DoctorSchedule, date: string, timestamp: number): boolean {
  return (schedule.breaks ?? []).some((window: ScheduleBreak) => {
    const start = slotToTimestamp(date, window.start)
    const end = slotToTimestamp(date, window.end)
    return timestamp >= start && timestamp < end
  })
}

function appointmentsFor(state: AppState, providerId: string, date: string): Appointment[] {
  return state.appointments.filter(
    (a) => a.providerId === providerId && a.date === date && !RELEASED_APPOINTMENT_STATUSES.includes(a.status),
  )
}

/**
 * The whole slot grid for a date, each slot tagged with what it actually is
 * right now: booked / past / break / available. Booking shows all of them —
 * a booked slot is information, not something to hide.
 */
export function getSlotBoard(state: AppState, providerId: string, now: number = Date.now(), date: string = state.today): SlotBoardEntry[] {
  const schedule = getDoctorSchedule(state, providerId, date)
  if (!schedule || schedule.onLeave) return []

  const bySlot = new Map(appointmentsFor(state, providerId, date).map((a) => [a.slot, a]))

  return schedule.slots.map((slot) => {
    const timestamp = slotToTimestamp(date, slot)
    const appointment = bySlot.get(slot) ?? null
    let status: SlotBoardEntry['status'] = 'available'
    if (appointment) status = 'booked'
    else if (isWithinBreak(schedule, date, timestamp)) status = 'break'
    else if (timestamp < now - 60000) status = 'past'
    return { slot, timestamp, status, appointment }
  })
}

export function getAvailableSlots(state: AppState, providerId: string, now: number = Date.now(), date: string = state.today): string[] {
  return getSlotBoard(state, providerId, now, date)
    .filter((entry) => entry.status === 'available')
    .map((entry) => entry.slot)
}

/**
 * How far behind the session is running: the longest overdue wait among
 * patients checked in but not yet seen, measured against the slot they were
 * booked into. Real arithmetic on real timestamps.
 */
export function getDoctorDelayMinutes(state: AppState, providerId: string, now: number = Date.now(), date: string = state.today): number {
  const appointmentsById = new Map(state.appointments.map((a) => [a.appointmentId, a]))
  let worst = 0
  for (const token of state.queueTokens) {
    if (token.providerId !== providerId) continue
    if (token.status !== 'Waiting' && token.status !== 'Called') continue
    const visit = state.visits.find((v) => v.visitId === token.visitId)
    const appointment = visit?.appointmentId ? appointmentsById.get(visit.appointmentId) : null
    if (!appointment || appointment.date !== date) continue
    worst = Math.max(worst, minutesBetween(now, slotToTimestamp(date, appointment.slot)))
  }
  return worst
}

/**
 * Operational status — never stored on the provider. Derived, in priority
 * order, from account status > leave > break > live queue activity >
 * schedule adherence > remaining availability.
 */
export function getDoctorStatus(state: AppState, providerId: string, now: number = Date.now(), date: string = state.today): DoctorStatus {
  const provider = getProviderById(state, providerId)
  if (!provider) return 'Not scheduled'
  if (provider.status !== 'Active') return 'Inactive'

  const schedule = getDoctorSchedule(state, providerId, date)
  if (!schedule) return 'Not scheduled'
  if (schedule.onLeave) return 'On leave'
  if (schedule.slots.length === 0) return 'Not scheduled'

  // "Currently in session", "on break", "with a patient" and "running late"
  // are all live-clock signals — they only mean something when `date` is
  // the day the clock is actually in. For any other date (past or future,
  // e.g. picked from the monthly calendar), status is schedule/booking-only.
  if (date === todayKey(new Date(now))) {
    const sessionStart = slotToTimestamp(date, schedule.sessionStart)
    const sessionEnd = slotToTimestamp(date, schedule.sessionEnd)
    if (now < sessionStart || now > sessionEnd) return 'Not scheduled'

    if (isWithinBreak(schedule, date, now)) return 'On break'

    // Live activity outranks schedule drift: if the doctor is actually with a
    // patient, that's the more useful signal. Any delay is surfaced separately.
    const busy = state.queueTokens.some(
      (t) => t.providerId === providerId && (t.status === 'Called' || t.status === 'In consultation'),
    )
    if (busy) return 'In consultation'

    if (getDoctorDelayMinutes(state, providerId, now, date) >= LATE_THRESHOLD_MINUTES) return 'Running late'
  }

  if (getAvailableSlots(state, providerId, now, date).length === 0) return 'Fully booked'
  return 'Available'
}

export function getTodaysAppointmentCount(state: AppState, providerId: string, date: string = state.today): number {
  return appointmentsFor(state, providerId, date).length
}

export function getDoctorRows(state: AppState, now: number = Date.now(), date: string = state.today): DoctorRow[] {
  return state.providers.map((provider) => {
    const status = getDoctorStatus(state, provider.providerId, now, date)
    const schedule = getDoctorSchedule(state, provider.providerId, date)
    return {
      provider,
      status,
      schedule,
      nextSlot: getAvailableSlots(state, provider.providerId, now, date)[0] ?? null,
      openSlotCount: getAvailableSlots(state, provider.providerId, now, date).length,
      todaysAppointmentCount: getTodaysAppointmentCount(state, provider.providerId, date),
      // Always computed — a doctor can be In consultation *and* behind.
      delayMinutes: getDoctorDelayMinutes(state, provider.providerId, now, date),
    }
  })
}

export function getDoctorRow(state: AppState, providerId: string, now: number = Date.now(), date: string = state.today): DoctorRow | null {
  return getDoctorRows(state, now, date).find((row) => row.provider.providerId === providerId) ?? null
}

// --------------------------------------------------------------- scheduling

const SUGGESTION_HORIZON_DAYS = 14

/** The date `days` after a YYYY-MM-DD key, as a key. */
export function addDaysToKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return todayKey(new Date(year, month - 1, day + days))
}

export interface FreeSlot {
  date: string
  slot: string
}

export interface DoctorSuggestion {
  provider: Provider
  /** How the doctor stands today. */
  status: DoctorStatus
  /** The soonest free slots, across the next two weeks. */
  nextSlots: FreeSlot[]
  bookable: boolean
  /** Why the doctor can't be booked, when they can't. */
  reason: string | null
}

/** A department's doctors, the soonest bookable first — what the schedule
 *  flow suggests once a department is chosen. */
export function getDoctorSuggestions(state: AppState, department: string, now: number): DoctorSuggestion[] {
  const firstSlotAt = (s: DoctorSuggestion) =>
    s.nextSlots[0] ? slotToTimestamp(s.nextSlots[0].date, s.nextSlots[0].slot) : Number.POSITIVE_INFINITY
  return state.providers
    .filter((p) => p.department === department && p.status === 'Active')
    .map((provider) => {
      const status = getDoctorStatus(state, provider.providerId, now, state.today)
      const nextSlots: FreeSlot[] = []
      for (let i = 0; i < SUGGESTION_HORIZON_DAYS && nextSlots.length < 4; i += 1) {
        const date = addDaysToKey(state.today, i)
        for (const slot of getAvailableSlots(state, provider.providerId, now, date)) {
          nextSlots.push({ date, slot })
          if (nextSlots.length >= 4) break
        }
      }
      const bookable = nextSlots.length > 0
      return {
        provider,
        status,
        nextSlots,
        bookable,
        reason: bookable ? null : `No open slots in the coming ${SUGGESTION_HORIZON_DAYS} days`,
      }
    })
    .sort((a, b) => Number(b.bookable) - Number(a.bookable) || firstSlotAt(a) - firstSlotAt(b))
}

/** Every doctor with their availability, for the directory: each
 *  department's doctors soonest-free first (departments in name order), then
 *  doctors not taking appointments. */
export function getDirectorySuggestions(state: AppState, now: number): DoctorSuggestion[] {
  const active = getDepartments(state).flatMap((department) => getDoctorSuggestions(state, department, now))
  const inactive = state.providers
    .filter((provider) => provider.status !== 'Active')
    .map((provider) => ({
      provider,
      status: getDoctorStatus(state, provider.providerId, now, state.today),
      nextSlots: [],
      bookable: false,
      reason: 'Not taking appointments',
    }))
  return [...active, ...inactive]
}

export interface DepartmentSummary {
  department: string
  /** Active doctors in the department. */
  doctors: number
  /** Doctors with a free slot in the next two weeks. */
  bookable: number
  /** The department's soonest free slot, across all its doctors. */
  next: FreeSlot | null
}

/** Each department with its doctors and soonest free time — what the
 *  booking flow's department tiles show. */
export function getDepartmentSummaries(state: AppState, now: number): DepartmentSummary[] {
  return getDepartments(state).map((department) => {
    const suggestions = getDoctorSuggestions(state, department, now)
    return {
      department,
      doctors: suggestions.length,
      bookable: suggestions.filter((s) => s.bookable).length,
      next: suggestions.find((s) => s.bookable)?.nextSlots[0] ?? null,
    }
  })
}

export interface DateStripDay {
  date: string
  open: number
  state: 'open' | 'full' | 'leave' | 'off'
}

/** Two weeks of one doctor's days: open (with how many free slots), full,
 *  on leave, or not working. */
export function getDoctorDateStrip(state: AppState, providerId: string, now: number): DateStripDay[] {
  const days: DateStripDay[] = []
  for (let i = 0; i < SUGGESTION_HORIZON_DAYS; i += 1) {
    const date = addDaysToKey(state.today, i)
    const schedule = getDoctorSchedule(state, providerId, date)
    if (!schedule) {
      days.push({ date, open: 0, state: 'off' })
    } else if (schedule.onLeave) {
      days.push({ date, open: 0, state: 'leave' })
    } else {
      const open = getAvailableSlots(state, providerId, now, date).length
      days.push({ date, open, state: open > 0 ? 'open' : 'full' })
    }
  }
  return days
}

/** A consultation's bill lines: exactly one — the doctor's own consultation
 *  fee. Registering is free, so a booking carries no other charge (the
 *  patient stays in the signature for the bill's callers). */
export function getConsultationBillItems(state: AppState, _patientId: string, providerId: string): PaymentItem[] {
  const provider = getProviderById(state, providerId)
  if (!provider) return []
  return [{ code: 'CONS-FEE', description: `Consultation — ${provider.name}`, amount: provider.consultationFee }]
}

export function getAppointmentById(state: AppState, appointmentId: string): Appointment | null {
  return state.appointments.find((a) => a.appointmentId === appointmentId) ?? null
}

export interface DayBooking {
  appointment: Appointment
  patient: Patient | null
  /** Everything paid on the booking — what a doctor-unavailable cancel refunds. */
  paid: number
}

/** A doctor's open bookings on one day, by time — what has to be moved or
 *  cancelled before that day can be leave. */
export function getDoctorDayBookings(state: AppState, providerId: string, date: string): DayBooking[] {
  if (!providerId || !date) return []
  return state.appointments
    .filter((a) => a.providerId === providerId && a.date === date && ['Scheduled', 'Payment Pending', 'Confirmed'].includes(a.status))
    .sort((a, b) => a.slot.localeCompare(b.slot))
    .map((appointment) => ({
      appointment,
      patient: getPatientById(state, appointment.patientId),
      paid: getBillsForAppointment(state, appointment.appointmentId).reduce((sum, bill) => sum + bill.paidAmount, 0),
    }))
}

/** Patients in a doctor's queue right now. */
export function getDoctorQueueCount(state: AppState, providerId: string): number {
  return state.queueTokens.filter((t) => t.providerId === providerId && ['Waiting', 'Called', 'In consultation'].includes(t.status)).length
}

export function getAppointmentsForDate(state: AppState, date: string = state.today): AppointmentRow[] {
  return state.appointments
    .filter((a) => a.date === date)
    .map((a) => {
      const visit = a.visitId ? state.visits.find((v) => v.visitId === a.visitId) ?? null : null
      const token = visit ? state.queueTokens.find((t) => t.visitId === visit.visitId) ?? null : null
      return {
        ...a,
        patient: getPatientById(state, a.patientId),
        provider: getProviderById(state, a.providerId),
        visit,
        token,
        slotTimestamp: slotToTimestamp(a.date, a.slot),
      }
    })
    .sort((a, b) => a.slot.localeCompare(b.slot))
}

export function getAppointmentsForPatient(state: AppState, patientId: string): PatientAppointmentRow[] {
  return state.appointments
    .filter((a) => a.patientId === patientId)
    .map((a) => ({
      ...a,
      provider: getProviderById(state, a.providerId),
      slotTimestamp: slotToTimestamp(a.date, a.slot),
    }))
    .sort((a, b) => b.slotTimestamp - a.slotTimestamp)
}

export function getAppointmentsForProvider(state: AppState, providerId: string, date: string = state.today): AppointmentRow[] {
  return getAppointmentsForDate(state, date).filter((a) => a.providerId === providerId)
}

/** Observed consultation pace for a doctor — the mean of today's completed
 *  consultations, falling back to their configured slot length. Used for
 *  estimated waits, so the estimate reflects how this doctor actually runs. */
export function getAverageConsultationMinutes(state: AppState, providerId: string): number {
  const completed = state.queueTokens.filter(
    (t) => t.providerId === providerId && t.status === 'Completed' && t.startedAt && t.completedAt,
  )
  if (completed.length === 0) {
    return getProviderById(state, providerId)?.schedule?.slotMinutes ?? 15
  }
  const total = completed.reduce((sum, t) => sum + ((t.completedAt as number) - (t.startedAt as number)), 0)
  return Math.max(5, Math.round(total / completed.length / 60000))
}

export function getQueueView(state: AppState, now: number = Date.now()): QueueView {
  // A queue is one day's: yesterday's tokens are history, not a queue.
  const today = todayKey(new Date(now))
  const tokens = state.queueTokens.filter((t) => todayKey(new Date(t.createdAt)) === today)
  const waitingByProvider = new Map<string, typeof state.queueTokens>()
  for (const token of tokens) {
    if (token.status !== 'Waiting') continue
    if (!waitingByProvider.has(token.providerId)) waitingByProvider.set(token.providerId, [])
    waitingByProvider.get(token.providerId)!.push(token)
  }
  for (const list of waitingByProvider.values()) list.sort((a, b) => a.createdAt - b.createdAt)

  const rows: QueueTokenRow[] = tokens.map((token) => {
    const visit = state.visits.find((v) => v.visitId === token.visitId) ?? null
    const appointment = visit?.appointmentId
      ? state.appointments.find((a) => a.appointmentId === visit.appointmentId) ?? null
      : null

    let position: number | null = null
    let estimatedWaitMinutes: number | null = null
    if (token.status === 'Waiting') {
      const queueForDoctor = waitingByProvider.get(token.providerId) ?? []
      position = queueForDoctor.findIndex((t) => t.tokenId === token.tokenId) + 1
      const doctorBusy = tokens.some(
        (t) => t.providerId === token.providerId && (t.status === 'Called' || t.status === 'In consultation'),
      )
      const ahead = position - 1 + (doctorBusy ? 1 : 0)
      estimatedWaitMinutes = ahead * getAverageConsultationMinutes(state, token.providerId)
    }

    return {
      ...token,
      patient: getPatientById(state, token.patientId),
      provider: getProviderById(state, token.providerId),
      appointment,
      position,
      estimatedWaitMinutes,
      waitingMinutes: token.status === 'Waiting' ? minutesBetween(now, token.createdAt) : null,
      calledMinutes: token.status === 'Called' ? minutesBetween(now, token.calledAt ?? token.createdAt) : null,
      consultingMinutes:
        token.status === 'In consultation' ? minutesBetween(now, token.startedAt ?? token.createdAt) : null,
    }
  })

  return {
    all: rows,
    waiting: rows.filter((t) => t.status === 'Waiting').sort((a, b) => a.createdAt - b.createdAt),
    called: rows.filter((t) => t.status === 'Called').sort((a, b) => (a.calledAt ?? 0) - (b.calledAt ?? 0)),
    inConsultation: rows.filter((t) => t.status === 'In consultation'),
    closed: rows
      .filter((t) => t.status === 'Completed' || t.status === 'No-show')
      .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt)),
  }
}

/** Patient records that look like the same human being — matched on an
 *  identical mobile number, derived from the records themselves. */
export function getPossibleDuplicates(state: AppState): Patient[][] {
  const byMobile = new Map<string, Patient[]>()
  for (const patient of state.patients) {
    const key = patient.mobile.replace(/[^0-9]/g, '').slice(-10)
    if (!key) continue
    if (!byMobile.has(key)) byMobile.set(key, [])
    byMobile.get(key)!.push(patient)
  }
  return [...byMobile.values()].filter((group) => group.length > 1)
}

/** The patient an ABHA is already linked to, if any — one ABHA, one patient. */
export function findAbhaHolder(state: AppState, abhaId: string): Patient | null {
  if (!abhaId.trim() || abhaError(abhaId)) return null
  const wanted = normalizeAbha(abhaId)
  return state.patients.find((p) => p.abhaId && normalizeAbha(p.abhaId) === wanted) ?? null
}

export function findPossibleDuplicatesFor(
  state: AppState,
  { name = '', mobile = '', abhaId = '' }: { name?: string; mobile?: string; abhaId?: string },
): Patient[] {
  const digits = mobile.replace(/[^0-9]/g, '').slice(-10)
  const normalizedName = name.trim().toLowerCase()
  const abhaHolder = findAbhaHolder(state, abhaId)
  if (digits.length < 10 && normalizedName.length < 3 && !abhaHolder) return []

  return state.patients.filter((patient) => {
    if (patient === abhaHolder) return true
    const patientDigits = patient.mobile.replace(/[^0-9]/g, '').slice(-10)
    if (digits.length === 10 && patientDigits === digits) return true
    if (normalizedName.length >= 3) {
      if (patient.name.toLowerCase().includes(normalizedName)) return true
      if (patient.aliases?.some((alias) => alias.includes(normalizedName))) return true
    }
    return false
  })
}

/** The one thing the desk does about an item — the dashboard turns it into
 *  a single button. */
export type AttentionAction =
  | { kind: 'bill'; patientId: string; paymentId: string }
  | { kind: 'admit'; patientId: string }
  | { kind: 'return-pass'; passId: string }
  | { kind: 'open'; label: string; to: string }

export interface NeedsAttentionItem {
  id: string
  tone: 'warning' | 'neutral' | 'info' | 'critical'
  title: string
  detail: string
  action: AttentionAction | null
}

const ATTENTION_ORDER: Record<NeedsAttentionItem['tone'], number> = { critical: 0, warning: 1, info: 2, neutral: 3 }

export interface NavBadge {
  count: number
  tone: 'critical' | 'warning' | 'info'
  /** What the count is, for the tooltip and screen readers. */
  label: string
}

/** The counts beside places in the navigation — only those with something
 *  in them. Each comes from the same records as the place's own figures. */
export function getNavBadges(state: AppState, now: number = Date.now()): Record<string, NavBadge> {
  const badges: Record<string, NavBadge> = {}
  const waiting = getQueueView(state, now).waiting.length
  if (waiting) badges['/patients'] = { count: waiting, tone: 'info', label: `${waiting} waiting for consultation` }
  const billing = getBillingOverview(state)
  if (billing.dueCount) {
    badges['/billing'] = {
      count: billing.dueCount,
      tone: billing.failedCount ? 'critical' : 'warning',
      label: `${billing.dueCount} ${billing.dueCount === 1 ? 'bill' : 'bills'} due${billing.failedCount ? `, ${billing.failedCount} failed` : ''}`,
    }
  }
  const overdue = state.guestPasses.filter((pass) => !pass.returned && now > pass.validUntil).length
  if (overdue) badges['/services/guest-pass'] = { count: overdue, tone: 'critical', label: `${overdue} ${overdue === 1 ? 'pass' : 'passes'} overdue` }
  const mlc = state.mlcRecords.filter((record) => !record.acknowledgedAt).length
  if (mlc) badges['/services/mlc'] = { count: mlc, tone: 'warning', label: `${mlc} awaiting acknowledgement` }
  return badges
}

/** What the front desk should deal with now, most urgent first. */
export function getNeedsAttention(state: AppState, now: number = Date.now()): NeedsAttentionItem[] {
  const items: NeedsAttentionItem[] = []

  for (const pass of state.guestPasses) {
    if (!pass.returned && now > pass.validUntil) {
      items.push({
        id: `na-pass-${pass.passId}`,
        tone: 'critical',
        title: 'Guest pass overdue',
        detail: `${pass.passId} · ${pass.holderName} (${pass.patientName ? `visiting ${pass.patientName}` : pass.relationship}, ${pass.ward}) has not been returned.`,
        action: { kind: 'return-pass', passId: pass.passId },
      })
    }
  }

  for (const bill of state.payments) {
    if (isBillDue(bill) && billDisplayStatus(bill) === 'Failed') {
      items.push({
        id: `na-failed-${bill.paymentId}`,
        tone: 'critical',
        title: 'Payment failed',
        detail: `${bill.patientName} · ${billNumberFor(bill)} · ${formatRupees(bill.balance)} still due.`,
        action: { kind: 'bill', patientId: bill.patientId, paymentId: bill.paymentId },
      })
    }
  }

  for (const record of state.mlcRecords) {
    if (record.acknowledgedAt) continue
    items.push({
      id: `na-mlc-${record.mlcId}`,
      tone: 'warning',
      title: record.intimationSent ? 'MLC acknowledgement awaited' : 'MLC intimation not sent',
      detail: `${record.mlcId} · ${record.patientName} · ${record.policeStation}`,
      action: { kind: 'open', label: 'MLC', to: '/services/mlc' },
    })
  }

  for (const group of getPossibleDuplicates(state)) {
    items.push({
      id: `na-dup-${group[0].patientId}`,
      tone: 'warning',
      title: 'Possible duplicate patient',
      detail: `${group.map((p) => p.uhid).join(' and ')} share a mobile number (${group[0].name}).`,
      action: { kind: 'open', label: 'Review', to: '/patients?filter=duplicates' },
    })
  }

  for (const token of getQueueView(state, now).waiting) {
    if ((token.waitingMinutes ?? 0) >= LONG_WAIT_MINUTES) {
      items.push({
        id: `na-wait-${token.tokenId}`,
        tone: 'warning',
        title: 'Patient awaiting doctor',
        detail: `${token.patient?.name ?? 'A patient'} has waited ${token.waitingMinutes} minutes (${token.tokenNumber}).`,
        action: { kind: 'open', label: 'Outpatients', to: '/patients/outpatients?filter=waiting' },
      })
    }
  }

  for (const row of getDoctorRows(state, now)) {
    if (row.status === 'Running late') {
      items.push({
        id: `na-late-${row.provider.providerId}`,
        tone: 'warning',
        title: 'Doctor running late',
        detail: `${row.provider.name} is about ${row.delayMinutes} minutes behind schedule.`,
        action: { kind: 'open', label: 'Their patients', to: `/patients/outpatients?provider=${row.provider.providerId}` },
      })
    }
    if (row.status === 'On leave') {
      items.push({
        id: `na-leave-${row.provider.providerId}`,
        tone: 'neutral',
        title: 'Doctor unavailable',
        detail: `${row.provider.name} is on leave today — no bookable slots in ${row.provider.department}.`,
        action: { kind: 'open', label: 'Doctor', to: `/doctors/${row.provider.providerId}` },
      })
    }
  }

  for (const admission of state.admissions) {
    if (admission.status !== 'Pending' && admission.status !== 'Bed Reserved') continue
    items.push({
      id: `na-bed-${admission.admissionId}`,
      tone: 'info',
      title: 'Waiting for a bed',
      detail: `${admission.patientName} · ${admission.admissionNumber} · ${admission.doctorName}`,
      action: { kind: 'admit', patientId: admission.patientId },
    })
  }

  return items.sort((a, b) => ATTENTION_ORDER[a.tone] - ATTENTION_ORDER[b.tone])
}

export function getConnectivity(state: AppState): Connectivity {
  return state.connectivity
}

function digitsOf(value: string): string {
  return value.replace(/[^0-9]/g, '')
}

// ------------------------------------------------------------ patient search
// Client-side patient index search — stands in for a real patient-index API.
// Every field is scored on the same scale and the best field wins:
//   4 exact · 3 starts with · 2 every word of the query starts a word · 1 contains
// "Contains" needs two or more characters, so a single keystroke only ever
// shows names, numbers and IDs that START with it. The alias list simulates
// transliteration matching; it is not a real identity-matching implementation.

type MatchField = PatientSearchMatch['matchedOn']

function normText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.,'’_/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function textTier(value: string, query: string): number {
  if (!value || !query) return 0
  if (value === query) return 4
  if (value.startsWith(query)) return 3
  const words = value.split(' ')
  if (query.split(' ').every((part) => words.some((word) => word.startsWith(part)))) return 2
  if (query.length >= 2 && value.includes(query)) return 1
  return 0
}

/** Mobile numbers match on their last ten digits, so "+91" never matches everyone. */
function mobileTier(mobile: string, raw: string): number {
  if (!/^[+\d\s()-]+$/.test(raw)) return 0
  let digits = digitsOf(raw)
  if (raw.startsWith('+91') && digits.startsWith('91')) digits = digits.slice(2)
  if (digits.length > 10) digits = digits.slice(-10)
  if (!digits) return 0
  const number = digitsOf(mobile).slice(-10)
  if (digits === number) return 4
  if (number.startsWith(digits)) return 3
  if (digits.length >= 4 && number.endsWith(digits)) return 2
  if (digits.length >= 3 && number.includes(digits)) return 1
  return 0
}

/** A UHID matches on its number — "ISH" on its own, or "is", matches nobody. */
function uhidTier(uhid: string, raw: string): number {
  const typed = raw.toLowerCase().replace(/^ish/, '').replace(/[\s-]/g, '')
  if (!/^\d+$/.test(typed)) return 0
  const full = digitsOf(uhid)
  const typedCore = typed.replace(/^0+/, '')
  const fullCore = full.replace(/^0+/, '')
  if (!typedCore) return 0
  if (typedCore === fullCore) return 4
  if (fullCore.startsWith(typedCore) || full.startsWith(typed)) return 3
  if (typedCore.length >= 3 && fullCore.includes(typedCore)) return 1
  return 0
}

/** ABHA address ("name@abdm") on the part before "@"; ABHA number on its digits. */
function abhaTier(abha: string | null, raw: string, query: string): number {
  if (!abha) return 0
  const value = abha.toLowerCase()
  if (value.includes('@')) {
    const typed = raw.toLowerCase()
    if (value === typed) return 4
    // Typing the address itself ("lakshmanan.r@ab…") matches it as it grows.
    if (typed.includes('@')) return value.startsWith(typed) ? 3 : 0
    return textTier(normText(value.split('@')[0]), query)
  }
  if (!/^[\d\s-]+$/.test(raw)) return 0
  const digits = digitsOf(raw)
  const number = digitsOf(value)
  if (!digits) return 0
  if (digits === number) return 4
  if (number.startsWith(digits)) return 3
  if (digits.length >= 4 && number.includes(digits)) return 1
  return 0
}

/** "ABHA 91-4410-…", "ABHA ID: name@abdm", "abha no 9144…" — the typed
 *  value without its label, or null when no label was typed. */
function withoutAbhaLabel(raw: string): string | null {
  const rest = raw.replace(/^abha(\s*(id|number|no\.?|address))?\s*[:#-]?\s*/i, '')
  return rest !== raw && rest ? rest : null
}

/** Ranked patient search: best match first, then the patients the desk
 *  opens most, then the newest registrations. A patient is found by UHID,
 *  mobile, name (any script, known aliases), ABHA ID (name@abdm, or just the
 *  name part) or ABHA number (with or without dashes, or its first digits).
 *  Typing "ABHA …" searches the ABHA alone. */
export function searchPatients(state: AppState, rawQuery: string): PatientSearchMatch[] {
  const typed = rawQuery.trim()
  if (!typed) return []
  const abhaOnly = withoutAbhaLabel(typed)
  const raw = abhaOnly ?? typed
  const query = normText(raw)
  const opens = (patientId: string) => state.patientOpens[patientId]?.count ?? 0

  return state.patients
    .map((patient): PatientSearchMatch | null => {
      // Listed in tie-break order: on equal scores the earlier field is named.
      const abha: [MatchField, number] = [patient.abhaId ? abhaKind(patient.abhaId) : 'ABHA number', abhaTier(patient.abhaId, raw, query)]
      const scores: [MatchField, number][] = abhaOnly
        ? [abha]
        : [
            ['UHID', uhidTier(patient.uhid, raw)],
            ['Mobile', mobileTier(patient.mobile, raw)],
            abha,
            ['Name', textTier(normText(patient.name), query)],
            ['Name (native script)', patient.nameNative ? textTier(normText(patient.nameNative), query) : 0],
            ['Name (known alias)', Math.max(0, ...(patient.aliases ?? []).map((alias) => textTier(normText(alias), query)))],
          ]
      let best: [MatchField, number] | null = null
      for (const entry of scores) if (entry[1] > (best?.[1] ?? 0)) best = entry
      return best ? { patient, matchedOn: best[0], tier: best[1] } : null
    })
    .filter((result): result is PatientSearchMatch => result !== null)
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        opens(b.patient.patientId) - opens(a.patient.patientId) ||
        b.patient.createdAt - a.patient.createdAt ||
        a.patient.patientId.localeCompare(b.patient.patientId),
    )
}

/** A bill typed into search — "BIL-000102", "RCT-102", "bil 102". */
export function findBillByNumber(state: AppState, rawQuery: string): Payment | null {
  const match = rawQuery.trim().toLowerCase().match(/^(bil|rct)[\s-]*0*(\d+)$/)
  if (!match) return null
  const wanted = Number(match[2])
  return state.payments.find((p) => Number(digitsOf(p.receiptNo)) === wanted) ?? null
}

export interface PatientSearchSuggestions {
  recent: Patient[]
  mostOpened: Patient[]
}

/** What the search box offers before anything is typed: the newest
 *  registrations and the profiles the desk opens most (never both). */
export function getPatientSearchSuggestions(state: AppState): PatientSearchSuggestions {
  const recent = [...state.patients].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5)
  const recentIds = new Set(recent.map((p) => p.patientId))
  const mostOpened = state.patients
    .filter((p) => !recentIds.has(p.patientId) && (state.patientOpens[p.patientId]?.count ?? 0) > 0)
    .sort((a, b) => {
      const sa = state.patientOpens[a.patientId]
      const sb = state.patientOpens[b.patientId]
      return sb.count - sa.count || sb.lastOpenedAt - sa.lastOpenedAt
    })
    .slice(0, 5)
  return { recent, mostOpened }
}

export interface PatientFlags {
  /** Bed number while admitted. */
  bed: string | null
  /** Money still owed across the patient's bills. */
  due: number
  /** A collection on one of those bills failed and nothing has been paid since. */
  failed: boolean
}

/** The small status marks shown beside a patient wherever they are listed. */
export function getPatientFlags(state: AppState): Record<string, PatientFlags> {
  const flags: Record<string, PatientFlags> = {}
  const of = (patientId: string) => (flags[patientId] ??= { bed: null, due: 0, failed: false })
  for (const admission of state.admissions) {
    if (admission.status === 'Admitted') of(admission.patientId).bed = admission.bedNumber
  }
  for (const payment of state.payments) {
    if (!isBillDue(payment)) continue
    const entry = of(payment.patientId)
    entry.due += payment.balance
    if (billDisplayStatus(payment) === 'Failed') entry.failed = true
  }
  return flags
}

// -------------------------------------------------------------- payments

export function getPayments(state: AppState): Payment[] {
  return [...state.payments].sort((a, b) => b.createdAt - a.createdAt)
}

/** Every bill raised for a patient, newest first. */
export function getBillsForPatient(state: AppState, patientId: string): Payment[] {
  return state.payments.filter((p) => p.patientId === patientId).sort((a, b) => b.createdAt - a.createdAt)
}

export function getPaymentById(state: AppState, paymentId: string): Payment | null {
  return state.payments.find((p) => p.paymentId === paymentId) ?? null
}

/** A booking's live bills, oldest first: the consultation bill, then any
 *  fee-difference bill from a move to a dearer doctor. */
export function getBillsForAppointment(state: AppState, appointmentId: string): Payment[] {
  return state.payments
    .filter((p) => p.appointmentId === appointmentId && p.status !== 'Cancelled')
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** The bill line a move to a dearer doctor is charged under. */
export const FEE_DIFFERENCE_CODE = 'FEE-DIFF'

/** What has been paid towards a booking's consultation — its fee line and
 *  any fee difference collected on a move. */
export function consultationFeePaid(state: AppState, appointmentId: string): number {
  return getBillsForAppointment(state, appointmentId)
    .filter((bill) => bill.status === 'Paid' || bill.status === 'Partially Paid')
    .flatMap((bill) => bill.items)
    .filter((item) => item.code === 'CONS-FEE' || item.code === FEE_DIFFERENCE_CODE)
    .reduce((sum, item) => sum + item.amount, 0)
}

const OPEN_BOOKING = ['Scheduled', 'Payment Pending', 'Confirmed', 'Checked-in']
const OPEN_STAY = ['Pending', 'Bed Reserved', 'Admitted']

/** Why a bill can't be cancelled or refunded on its own — null when it can.
 *  A booking's bills move only with the booking: cancelling it because the
 *  doctor is unavailable refunds them, and once it has closed the fee is
 *  kept. A current inpatient's bill is settled at discharge. */
export function getBillLock(state: AppState, payment: Payment): string | null {
  if (payment.appointmentId) {
    const appointment = state.appointments.find((a) => a.appointmentId === payment.appointmentId)
    if (appointment && OPEN_BOOKING.includes(appointment.status)) {
      return 'This bill belongs to a booked appointment — cancel or reschedule the appointment instead.'
    }
    if (appointment && payment.paidAmount > 0) {
      return 'A consultation fee is refunded only when the doctor is unavailable. This appointment has closed, so its fee is kept.'
    }
  }
  if (payment.admissionId) {
    const admission = state.admissions.find((a) => a.admissionId === payment.admissionId)
    if (admission && OPEN_STAY.includes(admission.status)) {
      return 'This is a current inpatient’s bill — it is settled at discharge or closed with the admission.'
    }
  }
  return null
}

/** Everything a patient still owes money on — the front desk's worklist.
 *  Cancelled and Refunded bills carry no live balance, so they never appear
 *  here even if `balance` happens to be non-zero on the record. */
export function getPendingPayments(state: AppState): Payment[] {
  return getPayments(state).filter(isBillDue)
}

function dueFirst(bills: Payment[]): Payment[] {
  const failed = (p: Payment) => (billDisplayStatus(p) === 'Failed' ? 0 : 1)
  return [...bills].sort((a, b) => failed(a) - failed(b) || b.createdAt - a.createdAt)
}

function collectedToday(state: AppState, payment: Payment): boolean {
  return payment.transactions.some((txn) => todayKey(new Date(txn.collectedAt)) === state.today)
}

/** Today's headline figures — the same derivation feeds the Payment
 *  Dashboard and the small Front Office Home widget, so the two numbers can
 *  never drift apart. */
export function getPaymentSummary(state: AppState): PaymentSummary {
  let collectedToday = 0
  let transactionsToday = 0
  let refundsToday = 0

  for (const payment of state.payments) {
    for (const txn of payment.transactions) {
      if (todayKey(new Date(txn.collectedAt)) === state.today) {
        collectedToday += txn.amount
        transactionsToday += 1
      }
    }
    if (payment.refund && todayKey(new Date(payment.refund.refundedAt)) === state.today) {
      refundsToday += 1
    }
  }

  const pendingAmount = getPendingPayments(state).reduce((sum, p) => sum + p.balance, 0)

  return { collectedToday, pendingAmount, transactionsToday, refundsToday }
}

export type BillFilter = 'due' | 'failed' | 'collected-today' | 'all'

export interface BillingOverview {
  dueAmount: number
  dueCount: number
  failedCount: number
  collectedToday: number
  collectedTodayCount: number
  allCount: number
}

/** The Billing page's figures — one per filter, from the same bills the
 *  filtered list shows, so a number and its list can never disagree. */
export function getBillingOverview(state: AppState): BillingOverview {
  const due = getPendingPayments(state)
  return {
    dueAmount: due.reduce((sum, p) => sum + p.balance, 0),
    dueCount: due.length,
    failedCount: due.filter((p) => billDisplayStatus(p) === 'Failed').length,
    collectedToday: getPaymentSummary(state).collectedToday,
    collectedTodayCount: state.payments.filter((p) => collectedToday(state, p)).length,
    allCount: state.payments.length,
  }
}

export function getBillsByFilter(state: AppState, filter: BillFilter): Payment[] {
  switch (filter) {
    case 'due':
      return dueFirst(getPendingPayments(state))
    case 'failed':
      return getPendingPayments(state).filter((p) => billDisplayStatus(p) === 'Failed')
    case 'collected-today':
      return getPayments(state).filter((p) => collectedToday(state, p))
    default:
      return getPayments(state)
  }
}

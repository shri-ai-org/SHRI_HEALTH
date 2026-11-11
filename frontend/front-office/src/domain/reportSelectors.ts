// Reports — one activity stream derived from the records the desk already
// keeps (patients, appointments, visits, guest passes, admissions, payments).
// Nothing here is stored or invented: every event is read off a real record's
// own timestamp, so a registration, booking, check-in, pass, admission,
// discharge or payment made in the app shows up in Reports at once. When a
// backend exists, getActivityEvents is the one function to swap for its
// event feed — everything below works on ActivityEvent only.
import type { AppState } from '../types/store'
import { isBillDue } from '../utils/billing'
import { dayStartTimestamp, formatHour, slotToTimestamp, todayKey } from './time'
import { addDaysToKey as addDaysKey } from './selectors'
import type { IconTone } from '../utils/toneHex'

export type ActivityType =
  | 'PATIENT_REGISTERED'
  | 'APPOINTMENT_SCHEDULED'
  | 'PATIENT_CHECKED_IN'
  | 'GUEST_PASS_ISSUED'
  | 'PATIENT_ADMITTED'
  | 'PATIENT_DISCHARGED'
  | 'PAYMENT_COMPLETED'

export interface ActivityTypeInfo {
  type: ActivityType
  /** The activity as staff say it — the filter, breakdown and table label. */
  label: string
  /** The past-tense line in the activity table. */
  event: string
  hue: IconTone
}

export const ACTIVITY_TYPES: ActivityTypeInfo[] = [
  { type: 'PATIENT_REGISTERED', label: 'Patient Registration', event: 'Patient Registered', hue: 'teal' },
  { type: 'APPOINTMENT_SCHEDULED', label: 'Appointment Scheduled', event: 'Appointment Scheduled', hue: 'blue' },
  { type: 'PATIENT_CHECKED_IN', label: 'Patient Checked In', event: 'Patient Checked In', hue: 'orange' },
  { type: 'GUEST_PASS_ISSUED', label: 'Guest Pass Issued', event: 'Guest Pass Issued', hue: 'indigo' },
  { type: 'PATIENT_ADMITTED', label: 'Admission', event: 'Patient Admitted', hue: 'violet' },
  { type: 'PATIENT_DISCHARGED', label: 'Discharge', event: 'Patient Discharged', hue: 'pink' },
  { type: 'PAYMENT_COMPLETED', label: 'Payment Received', event: 'Payment Received', hue: 'green' },
]

export const ACTIVITY_INFO = Object.fromEntries(ACTIVITY_TYPES.map((info) => [info.type, info])) as Record<
  ActivityType,
  ActivityTypeInfo
>

export type ActivityStatus = 'Completed' | 'Cancelled'

export interface ActivityEvent {
  id: string
  timestamp: number
  activityType: ActivityType
  patientId: string | null
  patientName: string | null
  /** Who did it — the record's own staff name where it keeps one. */
  staffName: string
  status: ActivityStatus
  /** Payments only: the amount collected. */
  amount?: number
  /** A short extra line (the pass holder, the doctor, the ward). */
  detail?: string
  /** The patient's UHID, as printed on their card. */
  uhid?: string | null
  /** What the Activity Details table shows for this kind of activity — each
   *  read off the record the event came from, never typed in here. */
  doctorName?: string
  department?: string
  /** An appointment's booked slot (and a check-in's, via its appointment). */
  appointmentAt?: number
  guestName?: string
  passType?: string
  ward?: string
  bed?: string
  admissionType?: string
  dischargeType?: string
  receiptNo?: string
  /** How the money was collected: UPI, Card, Insurance/TPA. */
  paymentMethod?: string
}

/** Records that don't name the staff member who made them are shown under the
 *  desk role, until a backend records the user on every event. */
const DESK_ROLE = 'Care Entry Executive'

/** Every front-office activity, newest first. */
export function getActivityEvents(state: AppState): ActivityEvent[] {
  const patientById = new Map(state.patients.map((p) => [p.patientId, p]))
  const providerById = new Map(state.providers.map((p) => [p.providerId, p]))
  const appointmentById = new Map(state.appointments.map((a) => [a.appointmentId, a]))
  const nameOf = (patientId: string | null) => (patientId ? (patientById.get(patientId)?.name ?? null) : null)
  const uhidOf = (patientId: string | null) => (patientId ? (patientById.get(patientId)?.uhid ?? null) : null)
  const events: ActivityEvent[] = []

  for (const patient of state.patients) {
    events.push({
      id: `reg-${patient.patientId}`,
      timestamp: patient.createdAt,
      activityType: 'PATIENT_REGISTERED',
      patientId: patient.patientId,
      patientName: patient.name,
      staffName: DESK_ROLE,
      status: 'Completed',
      uhid: patient.uhid,
    })
  }

  for (const appointment of state.appointments) {
    events.push({
      id: `apt-${appointment.appointmentId}`,
      timestamp: appointment.createdAt,
      activityType: 'APPOINTMENT_SCHEDULED',
      patientId: appointment.patientId,
      patientName: nameOf(appointment.patientId),
      staffName: DESK_ROLE,
      status: appointment.cancelledAt ? 'Cancelled' : 'Completed',
      detail: providerById.get(appointment.providerId)?.name,
      uhid: uhidOf(appointment.patientId),
      doctorName: providerById.get(appointment.providerId)?.name,
      department: appointment.department,
      appointmentAt: slotToTimestamp(appointment.date, appointment.slot),
    })
  }

  for (const visit of state.visits) {
    const booked = visit.appointmentId ? appointmentById.get(visit.appointmentId) : undefined
    events.push({
      id: `chk-${visit.visitId}`,
      timestamp: visit.checkInTime,
      activityType: 'PATIENT_CHECKED_IN',
      patientId: visit.patientId,
      patientName: nameOf(visit.patientId),
      staffName: DESK_ROLE,
      status: 'Completed',
      detail: providerById.get(visit.providerId)?.name,
      uhid: uhidOf(visit.patientId),
      doctorName: providerById.get(visit.providerId)?.name,
      department: booked?.department,
      appointmentAt: booked ? slotToTimestamp(booked.date, booked.slot) : undefined,
    })
  }

  for (const pass of state.guestPasses) {
    events.push({
      id: `gp-${pass.passId}`,
      timestamp: pass.issuedAt,
      activityType: 'GUEST_PASS_ISSUED',
      patientId: pass.patientId,
      patientName: pass.patientName,
      staffName: pass.issuedBy || DESK_ROLE,
      status: 'Completed',
      detail: `${pass.holderName} · ${pass.type}`,
      uhid: uhidOf(pass.patientId),
      guestName: pass.holderName,
      passType: pass.type,
    })
  }

  for (const admission of state.admissions) {
    if (admission.admittedAt) {
      events.push({
        id: `adm-${admission.admissionId}`,
        timestamp: admission.admittedAt,
        activityType: 'PATIENT_ADMITTED',
        patientId: admission.patientId,
        patientName: admission.patientName,
        staffName: DESK_ROLE,
        status: 'Completed',
        detail: admission.wardLabel ?? undefined,
        uhid: uhidOf(admission.patientId),
        doctorName: admission.doctorName,
        department: admission.department,
        ward: admission.wardLabel ?? undefined,
        bed: admission.bedNumber ?? undefined,
        admissionType: admission.admissionType,
      })
    }
    if (admission.dischargedAt) {
      events.push({
        id: `dis-${admission.admissionId}`,
        timestamp: admission.dischargedAt,
        activityType: 'PATIENT_DISCHARGED',
        patientId: admission.patientId,
        patientName: admission.patientName,
        staffName: DESK_ROLE,
        status: 'Completed',
        detail: admission.wardLabel ?? undefined,
        uhid: uhidOf(admission.patientId),
        doctorName: admission.doctorName,
        department: admission.department,
        ward: admission.wardLabel ?? undefined,
        bed: admission.bedNumber ?? undefined,
        dischargeType: admission.dischargeType ?? undefined,
      })
    }
  }

  for (const payment of state.payments) {
    for (const txn of payment.transactions) {
      events.push({
        id: `pay-${txn.transactionId}`,
        timestamp: txn.collectedAt,
        activityType: 'PAYMENT_COMPLETED',
        patientId: payment.patientId,
        patientName: payment.patientName,
        staffName: DESK_ROLE,
        status: 'Completed',
        amount: txn.amount,
        detail: txn.method,
        uhid: uhidOf(payment.patientId),
        receiptNo: payment.receiptNo,
        paymentMethod: txn.method,
      })
    }
  }

  return events.sort((a, b) => b.timestamp - a.timestamp)
}

// ------------------------------------------------------------------ periods

export type ReportPeriod = 'today' | 'yesterday' | 'week' | 'month' | 'custom'

export const REPORT_PERIODS: { key: ReportPeriod; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'custom', label: 'Custom Range' },
]

/** Inclusive date keys (YYYY-MM-DD). */
export interface ReportRange {
  from: string
  to: string
}

/** The longest custom range the trend chart draws day by day. */
export const MAX_RANGE_DAYS = 92

/** The dates a period covers, ending on the desk's today. "This Week" is the
 *  last 7 days including today (so it always reads as a week, even on a Monday);
 *  a custom range is put in order and capped at MAX_RANGE_DAYS. */
export function rangeFor(period: ReportPeriod, today: string, custom: ReportRange): ReportRange {
  if (period === 'today') return { from: today, to: today }
  if (period === 'yesterday') {
    const day = addDaysKey(today, -1)
    return { from: day, to: day }
  }
  if (period === 'week') return { from: addDaysKey(today, -6), to: today }
  if (period === 'month') return { from: `${today.slice(0, 8)}01`, to: today }
  const [from, to] = custom.from <= custom.to ? [custom.from, custom.to] : [custom.to, custom.from]
  const capped = addDaysKey(to, -(MAX_RANGE_DAYS - 1))
  return { from: from < capped ? capped : from, to }
}

export function daysIn(range: ReportRange): number {
  return Math.round((dayStartTimestamp(range.to) - dayStartTimestamp(range.from)) / 86400000) + 1
}

export function eventsInRange(events: ActivityEvent[], range: ReportRange): ActivityEvent[] {
  const start = dayStartTimestamp(range.from)
  const end = dayStartTimestamp(addDaysKey(range.to, 1))
  return events.filter((e) => e.timestamp >= start && e.timestamp < end)
}

// ---------------------------------------------------------------- summaries

/** The overall payment position — every bill to date, as counts and money,
 *  never a patient. Pending is exactly what Payment Status lists as pending
 *  (a bill with money still owed), so the two always agree; paid + pending =
 *  total. Cancelled and refunded bills are left out. */
export interface PaymentOverview {
  totalBills: number
  billedAmount: number
  receivedAmount: number
  pendingAmount: number
  paidBills: number
  pendingBills: number
}

export function paymentOverview(state: AppState): PaymentOverview {
  const bills = state.payments.filter((bill) => bill.status !== 'Cancelled' && bill.status !== 'Refunded')
  const pending = bills.filter(isBillDue)
  return {
    totalBills: bills.length,
    billedAmount: bills.reduce((sum, bill) => sum + bill.totalAmount, 0),
    receivedAmount: bills.reduce((sum, bill) => sum + bill.paidAmount, 0),
    pendingAmount: pending.reduce((sum, bill) => sum + bill.balance, 0),
    paidBills: bills.length - pending.length,
    pendingBills: pending.length,
  }
}

export interface ActivitySummary {
  counts: Record<ActivityType, number>
  paymentsAmount: number
  total: number
}

/** Totals per activity. A cancelled booking still counts as scheduled — it
 *  was booked in the period; the table shows it as cancelled. */
export function summarize(events: ActivityEvent[]): ActivitySummary {
  const counts = Object.fromEntries(ACTIVITY_TYPES.map((info) => [info.type, 0])) as Record<ActivityType, number>
  let paymentsAmount = 0
  for (const e of events) {
    counts[e.activityType] += 1
    if (e.activityType === 'PAYMENT_COMPLETED') paymentsAmount += e.amount ?? 0
  }
  return { counts, paymentsAmount, total: events.length }
}

export interface TrendPoint {
  key: string
  label: string
  value: number
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface TrendInsight {
  /** The busiest point(s) — "07:00" and "08:00" tie in the example. */
  busiest: string[]
  busiestValue: number
  quietest: string[]
  quietestValue: number
  /** Average activities per point, one decimal. */
  average: number
  total: number
}

/** Plain facts about a trend, for the sentence under the chart. The trailing
 *  hour of today is left out of "quietest" — it is still in progress. */
export function trendInsight(points: TrendPoint[], skipLastInQuietest: boolean): TrendInsight {
  const total = points.reduce((sum, p) => sum + p.value, 0)
  const values = points.map((p) => p.value)
  const busiestValue = Math.max(0, ...values)
  const pool = skipLastInQuietest && points.length > 2 ? points.slice(0, -1) : points
  const quietestValue = pool.length ? Math.min(...pool.map((p) => p.value)) : 0
  return {
    busiest: points.filter((p) => p.value === busiestValue).map((p) => p.label),
    busiestValue,
    quietest: pool.filter((p) => p.value === quietestValue).map((p) => p.label),
    quietestValue,
    average: points.length ? Math.round((total / points.length) * 10) / 10 : 0,
    total,
  }
}

export type TrendScale = 'hour' | 'day'

/** How the trend is drawn for a period: Today and Yesterday (and a one-day
 *  custom range) hour by hour; This Week, This Month and longer ranges day by
 *  day — always, so a period never changes scale depending on the date. */
export function trendScaleFor(period: ReportPeriod, range: ReportRange): TrendScale {
  if (period === 'today' || period === 'yesterday') return 'hour'
  if (period === 'custom' && range.from === range.to) return 'hour'
  return 'day'
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Activity over the range. Hour by hour: the desk's working hours, widened to
 *  any activity outside them — and for today only up to the current hour, so
 *  hours still to come don't read as zero. Day by day: one point per date, named by weekday (Sun, Mon …) when asked, else by date (Oct 1). */
export function activityTrend<T extends { timestamp: number }>(
  events: T[],
  range: ReportRange,
  scale: TrendScale,
  now: number = Date.now(),
  weekdayLabels = false,
  weight: (event: T) => number = () => 1,
): TrendPoint[] {
  if (scale === 'hour') {
    const hours = events.map((e) => new Date(e.timestamp).getHours())
    const first = Math.min(8, ...hours)
    const isToday = range.from === todayKey(new Date(now))
    const last = isToday ? Math.max(first, new Date(now).getHours(), ...hours) : Math.max(20, ...hours)
    const points: TrendPoint[] = []
    for (let h = first; h <= last; h += 1) {
      points.push({ key: String(h), label: formatHour(h), value: events.reduce((sum, e, i) => (hours[i] === h ? sum + weight(e) : sum), 0) })
    }
    return points
  }
  const byDay = new Map<string, number>()
  for (const e of events) {
    const key = todayKey(new Date(e.timestamp))
    byDay.set(key, (byDay.get(key) ?? 0) + weight(e))
  }
  const total = daysIn(range)
  const points: TrendPoint[] = []
  for (let i = 0; i < total; i += 1) {
    const key = addDaysKey(range.from, i)
    const date = new Date(dayStartTimestamp(key))
    const label = weekdayLabels ? WEEKDAY[date.getDay()] : `${MONTH[date.getMonth()]} ${date.getDate()}`
    points.push({ key, label, value: byDay.get(key) ?? 0 })
  }
  return points
}

/** Today's count of each activity, hour by hour (from 8 AM, or the first
 *  activity, up to now) — the sparklines on the dashboard's figures. */
export function getTodayTrends(state: AppState, now: number): Record<ActivityType, number[]> {
  const today = { from: state.today, to: state.today }
  const events = eventsInRange(getActivityEvents(state), today)
  const out = {} as Record<ActivityType, number[]>
  for (const { type } of ACTIVITY_TYPES) {
    out[type] = activityTrend(
      events.filter((e) => e.activityType === type),
      today,
      'hour',
      now,
    ).map((point) => point.value)
  }
  return out
}

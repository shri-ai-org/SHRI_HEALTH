// One doctor's day as the day chart (components/dayTimeline) draws it, built
// from the same slot board every booking screen reads — so the chart, the
// day tabs and the next free time always agree.
import type { AppState } from '../types/store'
import type { SlotBoardEntry } from '../types/appointment'
import { dayModel, minus, minutesFrom } from '../components/dayTimeline/dayModel'
import type { DayActivity, DayBlock, DayInput, Span } from '../components/dayTimeline/dayModel'
import { addDaysToKey, getAvailableSlots, getDoctorDateStrip, getDoctorSchedule, getPatientById, getQueueView, getSlotBoard } from './selectors'
import type { FreeSlot } from './selectors'
import { dayStartTimestamp } from './time'

/** How far ahead "the next free time" is looked for: the day tabs' fortnight. */
const HORIZON_DAYS = 14

export interface DoctorDay {
  /** `dayModel()`'s input. */
  input: DayInput
  /** The slot board the chart is drawn from: a tap on free time books one of its slots. */
  board: SlotBoardEntry[]
  slotMinutes: number
  /** Working hours as drawn, less breaks. Empty on a day off or on leave. */
  work: Span[]
  /** The doctor's leave on the day. */
  leave: { leaveId: string; reason: string } | null
  /** Each booking bar's patient UHID, by appointment id. */
  uhids: Record<string, string>
}

/**
 * The chart's input for one doctor on one date:
 *   · work: the session, from its start to the end of its last slot, less
 *     breaks (drawn as breaks). The slot grid includes a slot that starts
 *     at the session's end time, so the session is drawn to that slot's end.
 *     A day the doctor doesn't work, or is on leave, has none;
 *   · leave: one all-day block carrying the reason;
 *   · bookings: the slot board's booked slots, one bar each, titled with the
 *     patient's name — a teleconsult in the teleconsult colour;
 *   · activities: the doctor's own day around the bookable hours (see
 *     doctorActivities) — never over a bookable slot.
 */
export function getDoctorDay(state: AppState, providerId: string, now: number, date: string): DoctorDay {
  const schedule = getDoctorSchedule(state, providerId, date)
  const board = getSlotBoard(state, providerId, now, date)
  const slotMinutes = schedule?.slotMinutes ?? 15
  const leave = schedule?.onLeave ? (state.leaves.find((l) => l.providerId === providerId && l.date === date) ?? null) : null

  let work: Span[] = []
  if (schedule && !schedule.onLeave) {
    const last = schedule.slots[schedule.slots.length - 1]
    const end = Math.max(minutesFrom(schedule.sessionEnd), last ? minutesFrom(last) + slotMinutes : 0)
    work = minus(
      [[minutesFrom(schedule.sessionStart), end]],
      schedule.breaks.map((b): Span => [minutesFrom(b.start), minutesFrom(b.end)]),
    )
  }

  const blocks: DayBlock[] = leave ? [{ id: leave.leaveId, start: 0, end: 24 * 60, reason: leave.reason, allDay: true }] : []

  const uhids: Record<string, string> = {}
  const bookings: DayActivity[] = []
  for (const entry of board) {
    if (entry.status !== 'booked' || !entry.appointment) continue
    const appointment = entry.appointment
    const patient = getPatientById(state, appointment.patientId)
    if (patient) uhids[appointment.appointmentId] = patient.uhid
    const start = minutesFrom(entry.slot)
    bookings.push({
      id: appointment.appointmentId,
      kind: appointment.mode === 'Teleconsult' ? 'tele' : 'patient',
      start,
      end: start + slotMinutes,
      title: patient?.name ?? 'Booked patient',
      detail: appointment.mode === 'Teleconsult' ? 'Teleconsult' : undefined,
    })
  }

  return {
    input: { date: new Date(dayStartTimestamp(date)), now: new Date(now), activities: doctorActivities(work, offersTeleconsult(state, providerId)), bookings, blocks, work },
    board,
    slotMinutes,
    work,
    leave: leave ? { leaveId: leave.leaveId, reason: leave.reason } : null,
    uhids,
  }
}

function offersTeleconsult(state: AppState, providerId: string): boolean {
  return state.providers.find((p) => p.providerId === providerId)?.consultationType !== 'Outpatient'
}

/**
 * The doctor's own activities on a working day, placed around the bookable
 * hours so they never cover a slot the desk can book:
 *   · a morning brief in the half hour before the session;
 *   · the ward round — before the brief when the session starts at 9 AM or
 *     later, otherwise straight after the session;
 *   · a teleconsult block after the session, for doctors who offer teleconsults;
 *   · the discharge round to close the day.
 * There is no paperwork or co-sign block. A day off or on leave has none.
 * They are drawn as icons only — no names on the chart.
 * These are the doctor's standing routine (no record behind them yet) — swap
 * this for the doctors' own calendar when that feed exists.
 */
function doctorActivities(work: Span[], tele: boolean): DayActivity[] {
  if (work.length === 0) return []
  const start = work[0][0]
  const end = work[work.length - 1][1]
  const out: DayActivity[] = []
  const add = (kind: DayActivity['kind'], from: number, minutes: number, title: string, detail?: string) => {
    if (from < 6 * 60 || from + minutes > 22 * 60) return
    out.push({ id: `${kind}-${from}`, kind, start: from, end: from + minutes, title, detail, iconOnly: true })
  }
  add('brief', start - 30, 30, 'Morning brief')
  const wardFirst = start >= 9 * 60
  if (wardFirst) add('ward', start - 90, 60, 'Ward round', 'Inpatients')
  let at = end
  if (!wardFirst) {
    add('ward', at, 60, 'Ward round', 'Inpatients')
    at += 60
  }
  if (tele) {
    add('tele', at, 45, 'Teleconsult', 'Video consultations')
    at += 45
  }
  add('discharge', at, 30, 'Discharge round', 'Discharge summaries and handover')
  return out
}

/** The doctor's next waiting patient today — first in the order the
 *  Outpatients queue calls them (getQueueView). */
export function getDoctorNextPatient(state: AppState, providerId: string, now: number): { name: string; token: string } | null {
  const next = getQueueView(state, now).waiting.find((t) => t.providerId === providerId)
  return next ? { name: next.patient?.name ?? 'Patient', token: next.tokenNumber } : null
}

/** The doctor's first free slot at or after `fromMinute` on `date`, or else
 *  on the days after it, as far as the day tabs reach. */
export function getNextFreeSlotFrom(state: AppState, providerId: string, now: number, date: string, fromMinute: number): FreeSlot | null {
  const sameDay = getAvailableSlots(state, providerId, now, date).find((slot) => minutesFrom(slot) >= fromMinute)
  if (sameDay) return { date, slot: sameDay }
  const last = addDaysToKey(state.today, HORIZON_DAYS - 1)
  for (let day = addDaysToKey(date, 1); day <= last; day = addDaysToKey(day, 1)) {
    const first = getAvailableSlots(state, providerId, now, day)[0]
    if (first) return { date: day, slot: first }
  }
  return null
}

/** The active doctors of a department. */
function departmentDoctors(state: AppState, department: string) {
  return state.providers.filter((p) => p.department === department && p.status === 'Active')
}

/** A department's days for the booking page's one date row: each day with how
 *  many slots its doctors still have free in all. */
export function getDepartmentDateStrip(state: AppState, department: string, now: number): { date: string; open: number }[] {
  const strips = departmentDoctors(state, department).map((p) => getDoctorDateStrip(state, p.providerId, now))
  if (strips.length === 0) return []
  return strips[0].map((day, i) => ({ date: day.date, open: strips.reduce((n, strip) => n + (strip[i]?.open ?? 0), 0) }))
}

/** The hours that hold every doctor's day in a department on a date — one
 *  time axis for all of them. 7 AM to 7 PM when nobody works that day. */
export function getDepartmentDayRange(state: AppState, department: string, now: number, date: string): [number, number] {
  const ranges = departmentDoctors(state, department)
    .map((p) => getDoctorDay(state, p.providerId, now, date))
    .filter((d) => d.work.length > 0)
    .map((d) => dayModel(d.input).range)
  if (ranges.length === 0) return [7 * 60, 19 * 60]
  return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))]
}

/** The date row for any set of doctors (the Doctors page shows several
 *  departments at once): each day with how many slots they have free in all. */
export function getDoctorsDateStrip(state: AppState, providerIds: string[], now: number): { date: string; open: number }[] {
  const strips = providerIds.map((id) => getDoctorDateStrip(state, id, now))
  if (strips.length === 0) return []
  return strips[0].map((day, i) => ({ date: day.date, open: strips.reduce((n, strip) => n + (strip[i]?.open ?? 0), 0) }))
}

/** The hours that hold every listed doctor's day on a date — one time axis for
 *  all of them. 7 AM to 7 PM when none of them works that day. */
export function getDoctorsDayRange(state: AppState, providerIds: string[], now: number, date: string): [number, number] {
  const ranges = providerIds
    .map((id) => getDoctorDay(state, id, now, date))
    .filter((d) => d.work.length > 0)
    .map((d) => dayModel(d.input).range)
  if (ranges.length === 0) return [7 * 60, 19 * 60]
  return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))]
}

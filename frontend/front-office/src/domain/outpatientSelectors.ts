// The Outpatients page: every booking and walk-in for today, and the
// bookings ahead, each at its stage — to check in, waiting, with the doctor,
// done. One row per booking or walk-in token; every figure is counted from
// the same lists the page shows, so a figure always equals its list.
import type { AppState } from '../types/store'
import type { Appointment, ConsultMode } from '../types/appointment'
import type { Patient } from '../types/patient'
import type { Provider } from '../types/doctor'
import type { QueueTokenRow, QueueTokenStatus } from '../types/queue'
import { getPatientById, getProviderById, getQueueView } from './selectors'
import { minutesBetween, slotLabel, slotToTimestamp, todayKey } from './time'
import { NO_SHOW_GRACE_MINUTES } from '../utils/appointment'

export type OutpatientStage = 'upcoming' | 'to-check-in' | 'waiting' | 'called' | 'in-room' | 'done'

/** The page's figures, each also a filter. */
export type OutpatientFilter = 'today' | 'check-in' | 'waiting' | 'with-doctor' | 'done' | 'upcoming'

export const OUTPATIENT_FILTERS: OutpatientFilter[] = ['today', 'check-in', 'waiting', 'with-doctor', 'done', 'upcoming']

export interface OutpatientRow {
  /** The booking's or the walk-in token's id. */
  id: string
  kind: 'booking' | 'walk-in'
  stage: OutpatientStage
  appointment: Appointment | null
  token: QueueTokenRow | null
  patient: Patient | null
  provider: Provider | null
  mode: ConsultMode
  date: string
  /** The booked slot, or a walk-in's arrival time. */
  time: string
  at: number
  /** A booking not yet checked in, past its time: how late. */
  lateMinutes: number | null
  /** Confirmed, still not here, and past the grace period. */
  canMarkNoShow: boolean
}

export interface OutpatientView {
  rows: OutpatientRow[]
  counts: Record<OutpatientFilter, number>
  /** Teleconsults in the chosen figure's list — the Teleconsult chip's count. */
  teleconsults: number
}

const LIVE_BOOKING = ['Scheduled', 'Payment Pending', 'Confirmed']

const TOKEN_STAGE: Record<QueueTokenStatus, OutpatientStage> = {
  Waiting: 'waiting',
  Called: 'called',
  'In consultation': 'in-room',
  Completed: 'done',
  'No-show': 'done',
}

function inFilter(row: OutpatientRow, filter: OutpatientFilter): boolean {
  switch (filter) {
    case 'today':
      return row.stage !== 'upcoming'
    case 'check-in':
      return row.stage === 'to-check-in'
    case 'waiting':
      return row.stage === 'waiting'
    case 'with-doctor':
      return row.stage === 'called' || row.stage === 'in-room'
    case 'done':
      return row.stage === 'done'
    case 'upcoming':
      return row.stage === 'upcoming'
  }
}

function outpatientRows(state: AppState, now: number): OutpatientRow[] {
  const today = todayKey(new Date(now))
  const tokens = getQueueView(state, now).all
  const tokenByVisit = new Map(tokens.map((t) => [t.visitId, t]))
  const rows: OutpatientRow[] = []

  for (const appointment of state.appointments) {
    if (appointment.date < today) continue
    const upcoming = appointment.date > today
    // A booking ahead that was cancelled is no longer coming.
    if (upcoming && !LIVE_BOOKING.includes(appointment.status)) continue
    const token = appointment.visitId ? (tokenByVisit.get(appointment.visitId) ?? null) : null
    const stage: OutpatientStage = upcoming
      ? 'upcoming'
      : token
        ? TOKEN_STAGE[token.status]
        : LIVE_BOOKING.includes(appointment.status)
          ? 'to-check-in'
          : 'done'
    const at = slotToTimestamp(appointment.date, appointment.slot)
    const late = stage === 'to-check-in' && now > at ? minutesBetween(now, at) : 0
    rows.push({
      id: appointment.appointmentId,
      kind: 'booking',
      stage,
      appointment,
      token,
      patient: getPatientById(state, appointment.patientId),
      provider: getProviderById(state, appointment.providerId),
      mode: appointment.mode,
      date: appointment.date,
      time: appointment.slot,
      at,
      lateMinutes: late > 0 ? late : null,
      canMarkNoShow: stage === 'to-check-in' && appointment.status === 'Confirmed' && now >= at + NO_SHOW_GRACE_MINUTES * 60000,
    })
  }

  for (const token of tokens) {
    if (token.appointment) continue
    rows.push({
      id: token.tokenId,
      kind: 'walk-in',
      stage: TOKEN_STAGE[token.status],
      appointment: null,
      token,
      patient: token.patient,
      provider: token.provider,
      mode: 'In person',
      date: today,
      time: slotLabel(token.createdAt),
      at: token.createdAt,
      lateMinutes: null,
      canMarkNoShow: false,
    })
  }

  return rows.sort((a, b) => a.at - b.at)
}

/** The rows for one figure, optionally only teleconsults and only one
 *  doctor's, with every figure's count under the same narrowing. */
export function getOutpatients(
  state: AppState,
  now: number,
  filter: OutpatientFilter,
  teleconsultOnly: boolean,
  providerId: string,
): OutpatientView {
  const scoped = outpatientRows(state, now).filter((row) => !providerId || row.provider?.providerId === providerId)
  const teleconsult = (rows: OutpatientRow[]) => rows.filter((row) => row.mode === 'Teleconsult')
  const narrowed = (rows: OutpatientRow[]) => (teleconsultOnly ? teleconsult(rows) : rows)
  const listOf = (key: OutpatientFilter) => scoped.filter((row) => inFilter(row, key))

  const counts = Object.fromEntries(OUTPATIENT_FILTERS.map((key) => [key, narrowed(listOf(key)).length])) as Record<OutpatientFilter, number>
  const chosen = listOf(filter)
  return { rows: narrowed(chosen), counts, teleconsults: teleconsult(chosen).length }
}

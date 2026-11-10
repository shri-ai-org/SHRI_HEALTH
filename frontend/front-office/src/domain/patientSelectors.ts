// What the patient profile shows — derived, read-only, from the same records
// every other screen uses. The front office has no clinical read, so the
// "risk" here is built only from facts this desk owns: where the patient is
// admitted and whether a medico-legal case is open.
import type { AppState } from '../types/store'
import type { Admission } from '../types/admission'
import type { Payment } from '../types/payment'
import type { ConsultMode, PatientAppointmentRow } from '../types/appointment'
import type { Provider } from '../types/doctor'
import type { QueueToken } from '../types/queue'
import type { Patient } from '../types/patient'
import { computeAdmissionBilling } from './admissionSelectors'
import { getAppointmentsForPatient, getBillsForAppointment, getPatientFlags, getPossibleDuplicates, getProviderById } from './selectors'
import { billDisplayStatus, isBillDue, stayDays } from '../utils/billing'
import { formatDateKey } from '../utils/dates'
import { formatTime, todayKey } from './time'

export type RiskLevel = 'High' | 'Watch' | 'Normal'

export interface PatientHeaderSummary {
  /** `label`: the badge's words — what the patient's state actually is. */
  risk: { level: RiskLevel; reason: string; label: string }
  payment: { status: 'Paid' | 'Partial' | 'Pending' | 'Failed' | 'No bills'; due: number }
  /** The current admission — admitted, or waiting for a bed. */
  admission: Admission | null
  inpatient: { ward: string; bed: string; day: number; critical: boolean } | null
}

const OPEN_ADMISSION = ['Pending', 'Bed Reserved', 'Admitted']

export function getCurrentAdmissionForPatient(state: AppState, patientId: string): Admission | null {
  return state.admissions.find((a) => a.patientId === patientId && OPEN_ADMISSION.includes(a.status)) ?? null
}

export interface PatientListRow {
  patient: Patient
  /** Bed number while admitted. */
  bed: string | null
  due: number
  failed: boolean
  /** Shares a mobile number with another record. */
  duplicate: boolean
}

/** Every registered patient, newest first, with the marks the desk acts on. */
export function getPatientRows(state: AppState): PatientListRow[] {
  const flags = getPatientFlags(state)
  const duplicates = new Set(getPossibleDuplicates(state).flat().map((p) => p.patientId))
  return [...state.patients]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((patient) => ({
      patient,
      bed: flags[patient.patientId]?.bed ?? null,
      due: flags[patient.patientId]?.due ?? 0,
      failed: flags[patient.patientId]?.failed ?? false,
      duplicate: duplicates.has(patient.patientId),
    }))
}

/** The profile header: risk dot, payment chip and inpatient tag. An
 *  inpatient's bill is read live (the stay keeps accruing), so day 3 never
 *  reads "Paid" off a day-1 bill. */
export function getPatientHeader(state: AppState, patientId: string, asOf: number): PatientHeaderSummary {
  const admission = getCurrentAdmissionForPatient(state, patientId)
  const admitted = admission?.status === 'Admitted' ? admission : null
  const critical = Boolean(admitted && (admitted.wardLabel === 'ICU' || admitted.wardLabel === 'Emergency'))
  const openMlc = state.mlcRecords.find((r) => r.patientId === patientId && r.acknowledgedAt === null) ?? null

  const reasons: string[] = []
  let level: RiskLevel = 'Normal'
  let label = 'Outpatient'
  if (admitted && critical) {
    level = 'High'
    label = admitted.wardLabel === 'ICU' ? 'In ICU' : 'In Emergency'
    reasons.push(`In ${admitted.wardLabel} · ${admitted.bedNumber}`)
  }
  if (openMlc) {
    if (level !== 'High') label = 'MLC open'
    level = 'High'
    reasons.push(`${openMlc.mlcId} open — police acknowledgement awaited`)
  }
  if (level === 'Normal' && admission) {
    level = 'Watch'
    label = admitted ? 'Inpatient' : 'Awaiting bed'
    reasons.push(admitted ? `Inpatient · ${admitted.wardLabel} · ${admitted.bedNumber}` : 'Admission waiting for a bed')
  }

  const bills = state.payments.filter((p) => p.patientId === patientId)
  const dues = bills.filter(isBillDue)
  const admissionBillId = admitted?.paymentId ?? null
  const live = admitted ? computeAdmissionBilling(state, admitted, asOf) : null
  const due =
    dues.filter((bill) => bill.paymentId !== admissionBillId).reduce((sum, bill) => sum + bill.balance, 0) + (live?.pending ?? 0)
  const anyFailed = dues.some((bill) => billDisplayStatus(bill) === 'Failed')
  const anyPaidTowardDue =
    dues.some((bill) => bill.paidAmount > 0 && bill.paymentId !== admissionBillId) || (live ? live.paid > 0 && live.pending > 0 : false)

  return {
    risk: { level, label, reason: reasons.join(' · ') || 'Outpatient — no admission or open MLC' },
    payment: {
      status: anyFailed ? 'Failed' : due > 0 ? (anyPaidTowardDue ? 'Partial' : 'Pending') : bills.length > 0 ? 'Paid' : 'No bills',
      due,
    },
    admission,
    inpatient:
      admitted && admitted.wardLabel && admitted.bedNumber
        ? { ward: admitted.wardLabel, bed: admitted.bedNumber, day: stayDays(admitted.admittedAt ?? admitted.createdAt, asOf), critical }
        : null,
  }
}

/** The doctor the patient saw (or is seeing) today — admission is usually
 *  advised from that outpatient encounter, so the admit flow starts there. */
export function getTodaysEncounterDoctor(state: AppState, patientId: string): string | null {
  const appointment = state.appointments
    .filter((a) => a.patientId === patientId && a.date === state.today && ['Confirmed', 'Checked-in', 'Completed'].includes(a.status))
    .sort((a, b) => b.slot.localeCompare(a.slot))[0]
  if (appointment) return appointment.providerId
  const walkIn = state.visits
    .filter((v) => v.patientId === patientId && !v.appointmentId && todayKey(new Date(v.arrivalTime)) === state.today)
    .sort((a, b) => b.arrivalTime - a.arrivalTime)[0]
  return walkIn?.providerId ?? null
}

// ------------------------------------------------------------------ timeline

/** What is coming up today and after: booked encounters and open walk-ins. */
export type UpcomingItem =
  | { kind: 'appointment'; id: string; at: number; appointment: PatientAppointmentRow; bill: Payment | null; token: QueueToken | null }
  | { kind: 'walk-in'; id: string; at: number; token: QueueToken; provider: Provider | null }

export type TimelineKind = 'registered' | 'encounter' | 'walk-in' | 'bill' | 'admitted' | 'discharged' | 'admission-cancelled' | 'mlc' | 'guest-pass'

export interface TimelineEvent {
  id: string
  at: number
  kind: TimelineKind
  title: string
  detail: string
  /** A status word, shown as a badge — it picks the badge's colour. */
  status?: string
  /** What the badge says, where that is plainer than the status word. */
  statusLabel?: string
  paymentId?: string
}

export interface PatientTimeline {
  upcoming: UpcomingItem[]
  history: TimelineEvent[]
}

/** How a past visit ended: Completed, Cancelled, or Incomplete — registered
 *  but never completed (a visit still waiting or in consultation is not past:
 *  it is shown under Today & upcoming with its current status). */
function visitOutcome(status: string): { status: string; statusLabel: string } {
  if (status === 'Completed') return { status: 'Completed', statusLabel: 'Completed' }
  if (status === 'Cancelled') return { status: 'Cancelled', statusLabel: 'Cancelled' }
  return { status: 'Incomplete', statusLabel: 'Incomplete' }
}

const OPEN_APPOINTMENT = ['Scheduled', 'Payment Pending', 'Confirmed', 'Checked-in']
const OPEN_TOKEN = ['Waiting', 'Called', 'In consultation']

/** One patient's front-office story: what's coming up, then everything that
 *  happened — encounters, bills, admissions, MLC, guest passes — newest first. */
export function getPatientTimeline(state: AppState, patientId: string): PatientTimeline {
  const patient = state.patients.find((p) => p.patientId === patientId)
  if (!patient) return { upcoming: [], history: [] }

  const upcoming: UpcomingItem[] = []
  const history: TimelineEvent[] = []

  for (const appointment of getAppointmentsForPatient(state, patientId)) {
    const doctor = appointment.provider?.name ?? 'Doctor'
    if (OPEN_APPOINTMENT.includes(appointment.status) && appointment.date >= state.today) {
      upcoming.push({
        kind: 'appointment',
        id: appointment.appointmentId,
        at: appointment.slotTimestamp,
        appointment,
        bill: getBillsForAppointment(state, appointment.appointmentId)[0] ?? null,
        token: appointment.visitId ? (state.queueTokens.find((t) => t.visitId === appointment.visitId) ?? null) : null,
      })
      continue
    }
    history.push({
      id: `enc-${appointment.appointmentId}`,
      at: appointment.slotTimestamp,
      kind: 'encounter',
      title: `Doctor visit · ${doctor}`,
      detail: `${appointment.department} · ${formatDateKey(appointment.date)} ${formatTime(appointment.slot)}`,
      ...visitOutcome(appointment.status),
    })
  }

  for (const visit of state.visits) {
    if (visit.patientId !== patientId || visit.appointmentId) continue
    const token = state.queueTokens.find((t) => t.visitId === visit.visitId)
    const provider = getProviderById(state, visit.providerId)
    if (token && OPEN_TOKEN.includes(token.status)) {
      upcoming.push({ kind: 'walk-in', id: visit.visitId, at: visit.arrivalTime, token, provider })
    } else {
      history.push({
        id: `walk-${visit.visitId}`,
        at: visit.arrivalTime,
        kind: 'walk-in',
        title: `Walk-in visit · ${provider?.name ?? 'Doctor'}`,
        detail: `${provider?.department ?? ''}${token ? ` · ${token.tokenNumber}` : ''}`,
        ...visitOutcome(token?.status === 'No-show' ? 'No-show' : 'Completed'),
      })
    }
  }

  // Bills are not part of the story here: the patient's Payment Status card lists them.

  for (const admission of state.admissions) {
    if (admission.patientId !== patientId) continue
    const where = [admission.wardLabel, admission.bedNumber].filter(Boolean).join(' · ') || 'Waiting for a bed'
    if (admission.admittedAt) {
      history.push({
        id: `adm-${admission.admissionId}`,
        at: admission.admittedAt,
        kind: 'admitted',
        title: `Admitted · ${where}`,
        detail: `${admission.admissionNumber} · ${admission.doctorName} · ${admission.department}`,
        status: admission.status === 'Admitted' ? 'Admitted' : undefined,
      })
    } else if (admission.status === 'Pending' || admission.status === 'Bed Reserved') {
      history.push({
        id: `adm-${admission.admissionId}`,
        at: admission.createdAt,
        kind: 'admitted',
        title: 'Admission requested',
        detail: `${admission.admissionNumber} · ${admission.doctorName} · ${admission.department}`,
        status: 'Pending',
      })
    }
    if (admission.status === 'Discharged' && admission.dischargedAt) {
      history.push({
        id: `dis-${admission.admissionId}`,
        at: admission.dischargedAt,
        kind: 'discharged',
        title: `Discharged · ${admission.dischargeType ?? 'Normal Discharge'}`,
        detail: `${admission.admissionNumber} · ${where}`,
        status: 'Discharged',
      })
    }
    if (admission.status === 'Cancelled' && admission.cancelledAt) {
      history.push({
        id: `can-${admission.admissionId}`,
        at: admission.cancelledAt,
        kind: 'admission-cancelled',
        title: 'Admission cancelled',
        detail: `${admission.admissionNumber} · ${admission.cancelReason ?? ''}`,
        status: 'Cancelled',
      })
    }
  }

  for (const record of state.mlcRecords) {
    if (record.patientId !== patientId) continue
    history.push({
      id: `mlc-${record.mlcId}`,
      at: record.registeredAt,
      kind: 'mlc',
      title: `Medico-legal case · ${record.mlcId}`,
      detail: `${record.category} · ${record.policeStation}`,
      status: record.acknowledgedAt ? 'Acknowledged' : 'Open',
    })
  }

  for (const pass of state.guestPasses) {
    if (pass.patientId !== patientId) continue
    history.push({
      id: `pass-${pass.passId}`,
      at: pass.issuedAt,
      kind: 'guest-pass',
      title: `Guest pass · ${pass.passId}`,
      detail: `${pass.ward} · ${pass.holderName} (${pass.relationship})`,
      status: pass.returned ? 'Returned' : 'Issued',
    })
  }

  history.push({ id: 'registered', at: patient.createdAt, kind: 'registered', title: 'Registered', detail: patient.uhid })

  upcoming.sort((a, b) => a.at - b.at)
  history.sort((a, b) => b.at - a.at)
  return { upcoming, history }
}

// --------------------------------------------------------------- care status

/** Where a patient is in care right now — the icons beside every name. */
export interface PatientCareStatus {
  /** In a bed; ICU and Emergency count as critical. */
  admitted: { ward: string; bed: string; critical: boolean } | null
  /** Seen as an outpatient today and not yet done: a booking still to come
   *  or an open token. `time` is the booked slot, `token` the queue number. */
  outpatient: { doctor: string; time: string | null; token: string | null; mode: ConsultMode } | null
}

/** One map for every patient with a status, so a list reads it per row
 *  without searching the records again. `today` comes from the caller's
 *  clock — `state.today` is the day the app started. */
export function getPatientCareStatus(state: AppState, today: string): Record<string, PatientCareStatus> {
  const status: Record<string, PatientCareStatus> = {}
  const of = (patientId: string) => (status[patientId] ??= { admitted: null, outpatient: null })
  const doctorName = (providerId: string) => getProviderById(state, providerId)?.name ?? 'Doctor'

  for (const admission of state.admissions) {
    if (admission.status !== 'Admitted' || !admission.wardLabel || !admission.bedNumber) continue
    of(admission.patientId).admitted = {
      ward: admission.wardLabel,
      bed: admission.bedNumber,
      critical: admission.wardLabel === 'ICU' || admission.wardLabel === 'Emergency',
    }
  }

  // An open token says the patient is here; a booking not yet checked in
  // says they are expected. A checked-in booking is read through its token.
  for (const token of state.queueTokens) {
    if (!OPEN_TOKEN.includes(token.status) || todayKey(new Date(token.createdAt)) !== today) continue
    const appointment = state.appointments.find((a) => a.visitId === token.visitId) ?? null
    of(token.patientId).outpatient = {
      doctor: doctorName(token.providerId),
      time: appointment?.slot ?? null,
      token: token.tokenNumber,
      mode: appointment?.mode ?? 'In person',
    }
  }
  for (const appointment of state.appointments) {
    if (appointment.date !== today || !['Scheduled', 'Payment Pending', 'Confirmed'].includes(appointment.status)) continue
    const entry = of(appointment.patientId)
    if (entry.outpatient && (entry.outpatient.token || (entry.outpatient.time ?? '') <= appointment.slot)) continue
    entry.outpatient = { doctor: doctorName(appointment.providerId), time: appointment.slot, token: null, mode: appointment.mode }
  }
  return status
}

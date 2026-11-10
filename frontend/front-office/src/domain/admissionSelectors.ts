import type { AppState } from '../types/store'
import { todayKey } from './time'
import { WARDS } from '../types/admission'
import type { Admission, Bed, Ward } from '../types/admission'
import type { BillDisplayStatus, Payment, PaymentItem } from '../types/payment'
import type { Patient } from '../types/patient'
import { admissionBillItems, billDisplayStatus, isBillDue, stayDays, sumItems } from '../utils/billing'

export function getBeds(state: AppState): Bed[] {
  return [...state.beds].sort((a, b) => a.roomNumber.localeCompare(b.roomNumber))
}

/** A ward's beds, in room order. */
export function getBedsForWard(state: AppState, ward: Ward): Bed[] {
  return getBeds(state).filter((b) => b.ward === ward)
}

/** The bed the admit flow suggests for a ward — the first free one. */
export function getFirstFreeBed(state: AppState, ward: Ward): Bed | null {
  return getBeds(state).find((b) => b.ward === ward && b.status === 'Available') ?? null
}

export function getAdmissions(state: AppState): Admission[] {
  return [...state.admissions].sort((a, b) => b.createdAt - a.createdAt)
}

export function getAdmissionById(state: AppState, admissionId: string): Admission | null {
  return state.admissions.find((a) => a.admissionId === admissionId) ?? null
}


// ------------------------------------------------- Inpatients

export interface WardSummary {
  ward: Ward
  /** Plain-language ward type shown beside the name. */
  type: string
  total: number
  occupied: number
  available: number
  beds: Bed[]
}

const WARD_TYPE_LABEL: Record<Ward, string> = {
  'General Ward': 'General',
  'Private Ward': 'Private',
  'Semi-Private Ward': 'Semi-Private',
  ICU: 'ICU',
  Emergency: 'Emergency',
}

/** One row per ward, counted straight from the bed records — the same beds an
 *  admission occupies — so capacity, occupied and available can never drift
 *  from the admissions themselves. */
export function getWardSummaries(state: AppState): WardSummary[] {
  return WARDS.map((ward) => {
    const beds = getBeds(state).filter((b) => b.ward === ward)
    return {
      ward,
      type: WARD_TYPE_LABEL[ward],
      total: beds.length,
      occupied: beds.filter((b) => b.status === 'Occupied').length,
      available: beds.filter((b) => b.status === 'Available').length,
      beds,
    }
  }).filter((w) => w.total > 0)
}

/** Patients who are in a bed right now. */
export function getCurrentAdmissions(state: AppState): Admission[] {
  return getAdmissions(state).filter((a) => a.status === 'Admitted')
}

/** The patients in a bed right now, newest admission first. */
export function getAdmittedPatients(state: AppState): Patient[] {
  return getCurrentAdmissions(state)
    .map((a) => state.patients.find((p) => p.patientId === a.patientId))
    .filter((p): p is Patient => Boolean(p))
}

/** Admission requests still waiting for a bed. */
export function getAwaitingBed(state: AppState): Admission[] {
  return getAdmissions(state).filter((a) => a.status === 'Pending' || a.status === 'Bed Reserved')
}

export interface InpatientRow {
  admission: Admission
  /** The stay's running bill as of the moment asked. */
  billing: AdmissionBilling
  billStatus: BillDisplayStatus
}

/** Everyone in a bed, each with the running bill of their stay so far. */
export function getInpatientRows(state: AppState, asOf: number): InpatientRow[] {
  return getCurrentAdmissions(state).map((admission) => {
    const billing = computeAdmissionBilling(state, admission, asOf)
    return { admission, billing, billStatus: liveBillStatus(state, billing) }
  })
}

export interface DischargedRow {
  admission: Admission
  bill: Payment | null
}

/** Discharged on the day `asOf` falls on, latest first, each with its final bill. */
export function getDischargedOn(state: AppState, asOf: number): DischargedRow[] {
  const day = todayKey(new Date(asOf))
  return state.admissions
    .filter((a) => a.status === 'Discharged' && a.dischargedAt !== null && todayKey(new Date(a.dischargedAt)) === day)
    .sort((a, b) => (b.dischargedAt ?? 0) - (a.dischargedAt ?? 0))
    .map((admission) => ({
      admission,
      bill: admission.paymentId ? (state.payments.find((p) => p.paymentId === admission.paymentId) ?? null) : null,
    }))
}

// --------------------------------------------------------- admission billing

export interface AdmissionBilling {
  items: PaymentItem[]
  days: number
  total: number
  paid: number
  pending: number
  paymentId: string | null
}

/** One admission's bill as of a moment: what the stay costs so far (admission
 *  charge + bed/room charge for the days stayed), what is already paid against
 *  the admission's Payment record, and what is still pending. For a discharged
 *  admission it reads the settled Payment record instead. */
export function computeAdmissionBilling(state: AppState, admission: Admission, asOf: number): AdmissionBilling {
  const payment = admission.paymentId ? state.payments.find((p) => p.paymentId === admission.paymentId) ?? null : null
  if (admission.status === 'Discharged' && payment) {
    return {
      items: payment.items,
      days: stayDays(admission.admittedAt ?? admission.createdAt, admission.dischargedAt ?? asOf),
      total: payment.totalAmount,
      paid: payment.paidAmount,
      pending: payment.balance,
      paymentId: payment.paymentId,
    }
  }
  const start = admission.admittedAt ?? admission.createdAt
  const days = stayDays(start, asOf)
  const items = admissionBillItems(admission.roomType ?? 'General', days)
  const total = sumItems(items)
  const paid = payment ? payment.paidAmount : 0
  return { items, days, total, paid, pending: Math.max(0, total - paid), paymentId: payment ? payment.paymentId : null }
}

export function getAdmissionBilling(state: AppState, admissionId: string, asOf: number): AdmissionBilling | null {
  const admission = state.admissions.find((a) => a.admissionId === admissionId)
  return admission ? computeAdmissionBilling(state, admission, asOf) : null
}

/** How the stay's bill reads once it carries the stay so far — a bill paid
 *  in full on day 1 reads Partial on day 2. */
function liveBillStatus(state: AppState, billing: AdmissionBilling): BillDisplayStatus {
  const bill = billing.paymentId ? state.payments.find((p) => p.paymentId === billing.paymentId) : undefined
  return bill ? billDisplayStatus({ ...bill, balance: billing.pending }) : 'Pending'
}

export interface DischargePreview {
  admission: Admission
  bill: Payment | null
  items: PaymentItem[]
  days: number
  total: number
  paid: number
  /** Still to collect on the stay's bill before the patient can leave. */
  balance: number
  billStatus: BillDisplayStatus
  /** The patient's other unpaid bills — shown, but they never hold up a discharge. */
  otherDues: Payment[]
  canDischarge: boolean
}

/** The final bill if the patient left at `asOf`: the stay re-priced by days,
 *  what has been paid against it and what is left. Nothing is saved — the
 *  bill itself is re-priced only when money is taken or the patient leaves. */
export function previewDischargeBill(state: AppState, admissionId: string, asOf: number): DischargePreview | null {
  const admission = state.admissions.find((a) => a.admissionId === admissionId)
  if (!admission || admission.status !== 'Admitted') return null
  const billing = computeAdmissionBilling(state, admission, asOf)
  return {
    admission,
    bill: billing.paymentId ? (state.payments.find((p) => p.paymentId === billing.paymentId) ?? null) : null,
    items: billing.items,
    days: billing.days,
    total: billing.total,
    paid: billing.paid,
    balance: billing.pending,
    billStatus: liveBillStatus(state, billing),
    otherDues: state.payments.filter(
      (p) => p.patientId === admission.patientId && p.paymentId !== billing.paymentId && isBillDue(p),
    ),
    canDischarge: billing.pending === 0,
  }
}

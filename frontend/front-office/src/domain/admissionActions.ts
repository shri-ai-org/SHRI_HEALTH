// IP Admission's own mutation path — same discipline as actions.ts,
// inventoryActions.ts and labActions.ts. Billing is NOT reimplemented here:
// createBillForAdmission calls the existing createPaymentBill and only
// stores the resulting paymentId back onto the Admission.
import { getState, setState } from './store'
import { withActivity, createPaymentBill } from './actions'
import { DomainError } from './errors'
import { MOBILE_ERROR, isValidMobile } from '../utils/phone'
import type { AppState } from '../types/store'
import { computeAdmissionBilling, previewDischargeBill } from './admissionSelectors'
import { admissionBillItems, formatRupees, sumItems } from '../utils/billing'
import { DISCHARGE_TYPES } from '../types/admission'
import type { Admission, Bed, CreateAdmissionInput, DischargeDetails } from '../types/admission'
import type { Payment, PaymentItem } from '../types/payment'
import type { GuestPass } from '../types/frontDesk'

function requireAdmission(state: AppState, admissionId: string): Admission {
  const admission = state.admissions.find((a) => a.admissionId === admissionId)
  if (!admission) throw new DomainError('NOT_FOUND', 'That admission no longer exists.')
  return admission
}

function requireBed(state: AppState, bedId: string): Bed {
  const bed = state.beds.find((b) => b.bedId === bedId)
  if (!bed) throw new DomainError('NOT_FOUND', 'That bed no longer exists.')
  return bed
}

function requireBill(state: AppState, paymentId: string): Payment {
  const bill = state.payments.find((p) => p.paymentId === paymentId)
  if (!bill) throw new DomainError('NOT_FOUND', 'That bill no longer exists.')
  return bill
}

/** The only place a bed's status changes — every admit/cancel/discharge
 *  action routes through here so a bed can never end up pointing at two
 *  admissions at once. */
function setBedStatus(current: AppState, bedId: string, status: Bed['status'], admissionId: string | null): AppState['beds'] {
  return current.beds.map((b) => (b.bedId === bedId ? { ...b, status, currentAdmissionId: admissionId } : b))
}

/**
 * Admits a patient to a bed and raises the admission's bill, as one step.
 * Care Entry takes no money: a self-pay patient pays the first day at the
 * billing counter; an insured, TPA or corporate patient is billed to the
 * payer and settled at discharge. A request already waiting for a bed is admitted rather than
 * duplicated. Everything is checked before anything is saved.
 */
export function admitPatient(input: CreateAdmissionInput): { admission: Admission; bill: Payment } {
  const state = getState()
  if (!input.patientId) throw new DomainError('VALIDATION', 'Select a patient before admitting.')
  const patient = state.patients.find((p) => p.patientId === input.patientId)
  if (!patient) throw new DomainError('NOT_FOUND', 'That patient no longer exists.')
  const already = state.admissions.find((a) => a.patientId === patient.patientId && a.status === 'Admitted')
  if (already) {
    throw new DomainError('ALREADY_ADMITTED', `${patient.name} is already admitted (${already.wardLabel} · ${already.bedNumber}).`)
  }

  const doctor = state.providers.find((p) => p.providerId === input.doctorId)
  if (!doctor || doctor.status !== 'Active') throw new DomainError('VALIDATION', 'Select an admitting doctor.')

  if (!input.reason?.trim()) throw new DomainError('VALIDATION', 'A reason for admission is required.')
  // The attendant is optional; a mobile, when given, must be a valid one.
  if (input.attendant.phone?.trim() && !isValidMobile(input.attendant.phone.trim())) throw new DomainError('VALIDATION', MOBILE_ERROR)

  const bed = requireBed(state, input.bedId)
  if (bed.status !== 'Available') {
    throw new DomainError('BED_UNAVAILABLE', `${bed.bedNumber} is no longer available — choose another bed.`)
  }

  const selfPay = input.paymentType === 'Self Pay'
  const billItems = admissionBillItems(bed.roomType, 1)

  // A request already waiting for a bed (Pending / Bed Reserved) becomes this admission.
  const waiting = state.admissions.find(
    (a) => a.patientId === patient.patientId && (a.status === 'Pending' || a.status === 'Bed Reserved'),
  )
  const seq = state.nextIds.admission
  const now = Date.now()
  const admissionId = waiting?.admissionId ?? `adm-${seq}`
  const admissionNumber = waiting?.admissionNumber ?? `ADM-${new Date().getFullYear()}-${String(seq).padStart(5, '0')}`

  const admission: Admission = {
    admissionId,
    admissionNumber,
    patientId: patient.patientId,
    patientName: patient.name,
    doctorId: doctor.providerId,
    doctorName: doctor.name,
    department: doctor.department,
    admissionType: input.admissionType,
    reason: input.reason.trim(),
    referralSource: input.referralSource,
    bedId: bed.bedId,
    wardLabel: bed.ward,
    roomNumber: bed.roomNumber,
    bedNumber: bed.bedNumber,
    roomType: bed.roomType,
    attendant: input.attendant,
    paymentType: input.paymentType,
    insuranceProvider: selfPay ? null : input.insuranceProvider?.trim() || null,
    policyNumber: selfPay ? null : input.policyNumber?.trim() || null,
    paymentId: null,
    status: 'Admitted',
    admittedAt: now,
    dischargedAt: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: waiting?.createdAt ?? now,
    updatedAt: now,
  }

  setState((current) => {
    const currentBed = current.beds.find((b) => b.bedId === input.bedId)
    if (!currentBed || currentBed.status !== 'Available') {
      throw new DomainError('BED_UNAVAILABLE', 'That bed was just taken — choose another bed.')
    }
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Patient admitted', meta: `${admissionNumber} · ${patient.name} · ${bed.bedNumber}` },
    ])
    return {
      ...current,
      admissions: waiting
        ? current.admissions.map((a) => (a.admissionId === admissionId ? admission : a))
        : [...current.admissions, admission],
      beds: setBedStatus(current, bed.bedId, 'Occupied', admission.admissionId),
      activityLog,
      nextIds: waiting ? { ...current.nextIds, activity: activitySeq } : { ...current.nextIds, admission: seq + 1, activity: activitySeq },
    }
  })

  // The admission's bill, linked both ways. A self-pay patient pays the first
  // day at the billing counter; an insured stay is settled by its payer.
  const billed = createBillForAdmission(admissionId, billItems)
  const bill = getState().payments.find((p) => p.paymentId === billed.paymentId)!

  return { admission: requireAdmission(getState(), admissionId), bill }
}

/** Raises a bill against the existing Payment/Billing system for admission
 *  charges — the SAME createPaymentBill every other module uses. */
export function createBillForAdmission(admissionId: string, items: { code: string; description: string; amount: number }[]): Admission {
  const state = getState()
  const admission = requireAdmission(state, admissionId)
  if (admission.paymentId) throw new DomainError('INVALID_TRANSITION', 'This admission already has a bill.')
  if (!items.length) throw new DomainError('VALIDATION', 'Select at least one charge.')

  const bill = createPaymentBill({ patientId: admission.patientId, items, admissionId })

  let updated!: Admission
  setState((current) => {
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Admission billed', meta: `${admission.admissionNumber} · ${bill.receiptNo}` },
    ])
    const admissions = current.admissions.map((a) => {
      if (a.admissionId !== admissionId) return a
      updated = { ...a, paymentId: bill.paymentId, updatedAt: Date.now() }
      return updated
    })
    return { ...current, admissions, activityLog, nextIds: { ...current.nextIds, activity: activitySeq } }
  })

  return updated
}

export function cancelAdmission(admissionId: string, reason: string): Admission {
  const state = getState()
  const admission = requireAdmission(state, admissionId)
  if (admission.status === 'Cancelled' || admission.status === 'Discharged') {
    throw new DomainError('INVALID_TRANSITION', `This admission is already ${admission.status.toLowerCase()}.`)
  }
  if (!reason?.trim()) throw new DomainError('VALIDATION', 'A cancellation reason is required.')

  const now = Date.now()
  let updated!: Admission
  setState((current) => {
    const passes = activePasses(current, admission.patientId)
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Admission cancelled', meta: `${admission.admissionNumber} · ${reason.trim()}` },
      ...passes.map((pass) => ({ text: 'Guest pass returned', meta: `${pass.passId} · admission cancelled` })),
    ])
    const admissions = current.admissions.map((a) => {
      if (a.admissionId !== admissionId) return a
      updated = { ...a, status: 'Cancelled', cancelledAt: now, cancelReason: reason.trim(), updatedAt: now }
      return updated
    })
    const beds = admission.bedId ? setBedStatus(current, admission.bedId, 'Available', null) : current.beds
    // Its bill goes with it while nothing has been paid; a paid deposit stays
    // on the bill for a refund.
    const payments = current.payments.map((p) =>
      p.paymentId === admission.paymentId && p.status === 'Pending' && p.paidAmount === 0
        ? { ...p, status: 'Cancelled' as const, cancelledAt: now, cancelReason: 'Admission cancelled', updatedAt: now }
        : p,
    )
    return {
      ...current,
      admissions,
      beds,
      payments,
      guestPasses: returnPasses(current, admission.patientId, now),
      activityLog,
      nextIds: { ...current.nextIds, activity: activitySeq },
    }
  })

  return updated
}

/** Discharges an admitted patient once the stay's final bill — re-priced to
 *  the day they leave — is paid: at the billing counter, or by the insurer. The
 *  patient's other bills never hold up a discharge. The bed is free the same
 *  moment. */
export function dischargeAdmission(admissionId: string, details: DischargeDetails): Admission {
  const state = getState()
  const admission = requireAdmission(state, admissionId)
  if (admission.status !== 'Admitted') {
    throw new DomainError('INVALID_TRANSITION', `This admission is ${admission.status.toLowerCase()} — it can't be discharged.`)
  }
  if (!DISCHARGE_TYPES.includes(details.dischargeType)) {
    throw new DomainError('VALIDATION', 'Choose how the patient is leaving.')
  }

  const now = Date.now()
  const preview = previewDischargeBill(state, admissionId, now)
  if (preview && preview.balance > 0) {
    throw new DomainError('BALANCE_DUE', `${formatRupees(preview.balance)} on the bill is still to be paid at the billing counter.`)
  }
  // The stored bill becomes the final bill.
  repriceAdmissionBill(admissionId, now)

  let updated!: Admission
  setState((current) => {
    const passes = activePasses(current, admission.patientId)
    const { activityLog, activitySeq } = withActivity(current, [
      { text: 'Patient discharged', meta: `${admission.admissionNumber} · ${admission.patientName} · ${admission.bedNumber ?? ''}` },
      ...passes.map((pass) => ({ text: 'Guest pass returned', meta: `${pass.passId} · at discharge` })),
    ])
    const admissions = current.admissions.map((a) => {
      if (a.admissionId !== admissionId) return a
      updated = {
        ...a,
        status: 'Discharged',
        dischargedAt: now,
        dischargeType: details.dischargeType,
        dischargeRemarks: details.remarks?.trim() || null,
        updatedAt: now,
      }
      return updated
    })
    const beds = admission.bedId ? setBedStatus(current, admission.bedId, 'Available', null) : current.beds
    return {
      ...current,
      admissions,
      beds,
      guestPasses: returnPasses(current, admission.patientId, now),
      activityLog,
      nextIds: { ...current.nextIds, activity: activitySeq },
    }
  })

  return updated
}

/** A patient's guest passes still out. */
function activePasses(current: AppState, patientId: string): GuestPass[] {
  return current.guestPasses.filter((p) => p.patientId === patientId && !p.returned)
}

/** The pass comes back when the stay ends — collected at the desk with the
 *  discharge (or the cancellation), so no one is left holding a live pass. */
function returnPasses(current: AppState, patientId: string, at: number): GuestPass[] {
  return current.guestPasses.map((p) => (p.patientId === patientId && !p.returned ? { ...p, returned: true, returnedAt: at } : p))
}

/** Brings a current stay's bill up to the stay so far — the admission charge
 *  plus the bed charge for every day started by `asOf` — and returns it. The
 *  stay keeps accruing, so this runs before money is taken on the bill and
 *  at discharge. A stay without a bill gets one. */
export function repriceAdmissionBill(admissionId: string, asOf: number): Payment {
  const state = getState()
  const admission = requireAdmission(state, admissionId)
  if (admission.status !== 'Admitted') {
    throw new DomainError('INVALID_TRANSITION', 'Only a current stay’s bill keeps accruing.')
  }
  const { items } = computeAdmissionBilling(state, admission, asOf)
  if (!admission.paymentId) {
    const billed = createBillForAdmission(admissionId, items)
    return requireBill(getState(), billed.paymentId!)
  }
  syncPaymentToBill(admission.paymentId, items)
  return requireBill(getState(), admission.paymentId)
}

/** Brings an admission's Payment record up to date with the stay's line items —
 *  the record's own items/total/balance/status, nothing else (paid amount and
 *  transactions are untouched). Charges already on the bill are never taken
 *  back, and a cancelled or refunded bill is closed and never re-opened. */
function syncPaymentToBill(paymentId: string, items: PaymentItem[]): void {
  const total = sumItems(items)
  const bill = getState().payments.find((p) => p.paymentId === paymentId)
  if (!bill || bill.status === 'Cancelled' || bill.status === 'Refunded') return
  if (total <= bill.totalAmount) return
  setState((current) => ({
    ...current,
    payments: current.payments.map((p) => {
      if (p.paymentId !== paymentId) return p
      const balance = Math.max(0, total - p.paidAmount)
      const status = balance === 0 ? 'Paid' : p.paidAmount > 0 ? 'Partially Paid' : 'Pending'
      return { ...p, items, totalAmount: total, balance, status, updatedAt: Date.now() }
    }),
  }))
}

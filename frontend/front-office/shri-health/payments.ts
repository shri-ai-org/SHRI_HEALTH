// The copay at check-out on the SHRI_HEALTH API (demo step 11, D58, D100, D104), for the check-out
// sheet's copay step (`src/components/payment/CopayAtCheckOut.tsx`). Connected:
//   suggestedCopay  ⇐ listAppointmentEligibilityChecks(appointmentId): the latest completed
//                      check's in-network office-visit copay, as a suggestion the desk can change
//   recordCopay     ⇒ recordPayment(patientId, { amount, method, appointmentId, encounterId, ... }),
//                      Idempotency-Key per attempt (reused only to retry the same request); the
//                      receipt PDF is made in the same step and transaction (D104)
//   receiptUrl      ⇐ createDownloadUrl(receiptFileId): a one-time link to the receipt (D105)
// Card payments wait for the card processor (recordPayment refuses `card` today), so the desk
// takes cash, check or other here. No billing-counter fee: the copay is the whole amount.
import { ApiError } from '../../src/api/client'
import { recordPayment } from '../../src/api/generated/endpoints/billing/billing'
import { listAppointmentEligibilityChecks } from '../../src/api/generated/endpoints/eligibility/eligibility'
import { createDownloadUrl } from '../../src/api/generated/endpoints/files/files'
import type { Payment } from '../../src/api/generated/model'
import { newIdempotencyKey, problemMessage } from './client'

export type CopayMethod = 'cash' | 'check' | 'other'
export const COPAY_METHODS: { value: CopayMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'other', label: 'Other' },
]

export interface CopayForm {
  /** Dollars and cents as typed, e.g. "25" or "25.00". */
  amount: string
  method: CopayMethod
  checkNumber: string
  note: string
}

/** A refusal the panel shows as it is: the copy for its Problem code, and the field it names. */
export class CopayRefusal extends Error {
  readonly status: number
  readonly pointer: string | null

  constructor(message: string, status: number, pointer: string | null = null) {
    super(message)
    this.status = status
    this.pointer = pointer
  }
}

function refusal(e: unknown): CopayRefusal {
  if (e instanceof ApiError) {
    const first = Array.isArray(e.problem.errors) ? e.problem.errors[0] : undefined
    return new CopayRefusal(problemMessage(e), e.status, first?.pointer ?? null)
  }
  return new CopayRefusal(e instanceof Error ? e.message : String(e), 0)
}

/** "25", "25.5", "25.50" → "25.50"; anything else (or zero, or more than $10,000) → null. */
export function normalizeAmount(typed: string): string | null {
  const m = /^\s*\$?\s*(\d{1,5})(?:\.(\d{1,2}))?\s*$/.exec(typed)
  if (!m) return null
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  if (cents <= 0 || cents > 1_000_000) return null
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/** The latest completed eligibility check's copay for this appointment, if any ("25.00"). */
export async function suggestedCopay(appointmentId: string): Promise<string | null> {
  try {
    const res = await listAppointmentEligibilityChecks(appointmentId)
    if (res.status !== 200) return null
    const withCopay = res.data.items.filter((c) => c.copay)
    return withCopay.length ? (withCopay[0].copay?.value ?? null) : null
  } catch {
    return null   // a suggestion only: the desk types the amount when there is none
  }
}

export async function recordCopay(
  patientId: string, appointmentId: string, encounterId: string | undefined, form: CopayForm,
  key: string = newIdempotencyKey(),
): Promise<Payment> {
  const amount = normalizeAmount(form.amount)
  if (!amount) throw new CopayRefusal('Enter the amount in dollars, for example 25.00.', 0, '/amount')
  if (form.method === 'check' && !form.checkNumber.trim()) {
    throw new CopayRefusal('Enter the check number.', 0, '/checkNumber')
  }
  try {
    const res = await recordPayment(patientId, {
      amount: { value: amount, currency: 'USD' },
      method: form.method,
      appointmentId,
      ...(encounterId ? { encounterId } : {}),
      ...(form.method === 'check' ? { checkNumber: form.checkNumber.trim() } : {}),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    }, { 'Idempotency-Key': key })
    if (res.status !== 201) throw new Error('The payment was not recorded')
    return res.data
  } catch (e) {
    throw refusal(e)
  }
}

/** A one-time link to the receipt PDF (D105); null when the file service has none to give. */
export async function receiptUrl(receiptFileId: string): Promise<string | null> {
  try {
    const res = await createDownloadUrl(receiptFileId)
    return res.status === 200 ? res.data.url : null
  } catch (e) {
    throw refusal(e)
  }
}

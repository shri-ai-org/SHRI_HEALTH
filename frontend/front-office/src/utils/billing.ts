import type { BillDisplayStatus, Payment, PaymentItem } from '../types/payment'
import type { Tone } from './tone'

/** A bill with money still owed on it. */
export function isBillDue(payment: Payment): boolean {
  return payment.balance > 0 && payment.status !== 'Cancelled' && payment.status !== 'Refunded'
}

// Billing & Accounts reuses the Payment record as the "Bill" — a Payment
// already carries everything a front-desk bill needs (items, total, paid,
// balance, a Draft→Paid lifecycle). Rather than a second, parallel Bill
// entity that could drift out of sync with the same charge, a Bill Number
// is a display-only reformatting of the Payment's own receipt number, so
// there is exactly one record and one source of truth per charge.
export function billNumberFor(payment: Payment): string {
  return `BIL-${payment.receiptNo.replace('RCT-', '')}`
}

export function billServicesSummary(payment: Payment): string {
  return payment.items.map((item) => item.description).join(' + ')
}

/** What a bill reads as everywhere it is shown. A stored Cancelled/Refunded
 *  wins; otherwise the money decides: nothing due → Paid, the latest attempt
 *  failed after the last collection → Failed, some collected → Partial,
 *  nothing collected → Pending. */
export function billDisplayStatus(payment: Payment): BillDisplayStatus {
  if (payment.status === 'Cancelled' || payment.status === 'Refunded') return payment.status
  if (payment.balance <= 0) return 'Paid'
  const lastFailure = payment.failedAttempts[payment.failedAttempts.length - 1]?.attemptedAt ?? 0
  const lastCollection = payment.transactions[payment.transactions.length - 1]?.collectedAt ?? 0
  if (lastFailure > lastCollection) return 'Failed'
  return payment.paidAmount > 0 ? 'Partial' : 'Pending'
}

/** What each bill status reads as. Care Entry never takes money, so a bill
 *  only ever reads as where the billing counter has it. */
export const BILL_STATUS_LABEL: Record<BillDisplayStatus, string> = {
  Paid: 'Payment received',
  Partial: 'Payment pending',
  Pending: 'Payment pending',
  Failed: 'Payment failed',
  Cancelled: 'Cancelled',
  Refunded: 'Refunded',
}

/** Green paid, yellow pending/partial, red failed; closed bills are quiet. */
export const BILL_STATUS_TONE: Record<BillDisplayStatus, Tone> = {
  Paid: 'stable',
  Partial: 'warning',
  Pending: 'warning',
  Failed: 'critical',
  Cancelled: 'neutral',
  Refunded: 'info',
}

// ------------------------------------------------------------- IP admission
// Admission charges. The admission's Payment record (the same Payment/Bill every
// module uses) holds these as ordinary line items, so there is no second billing
// system: initial payment at admission and the pending balance at discharge are
// both just collections against that one record.
import type { RoomType } from '../types/admission'

export const ADMISSION_CHARGE = 500

/** Daily bed/room charge by room type (mock rate card, ₹ per day). */
export const DAILY_BED_CHARGE: Record<RoomType, number> = {
  General: 2000,
  'Semi-Private': 3500,
  Private: 5000,
  ICU: 8000,
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Days billed for a stay — every started 24 hours counts, minimum one. */
export function stayDays(admittedAt: number, asOf: number): number {
  return Math.max(1, Math.ceil((asOf - admittedAt) / DAY_MS))
}

/** Line items for an admission: the admission charge plus the bed/room charge for N days. */
export function admissionBillItems(roomType: RoomType, days: number): PaymentItem[] {
  return [
    { code: 'ADM-FEE', description: 'Admission charge', amount: ADMISSION_CHARGE },
    {
      code: `BED-${roomType.toUpperCase().replace(/[^A-Z]/g, '')}`,
      description: `${roomType} bed/room charge × ${days} ${days === 1 ? 'day' : 'days'}`,
      amount: DAILY_BED_CHARGE[roomType] * days,
    },
  ]
}

export function sumItems(items: PaymentItem[]): number {
  return items.reduce((total, item) => total + item.amount, 0)
}

/** ₹ with Indian digit grouping, e.g. ₹18,500. */
export function formatRupees(value: number): string {
  return `₹${value.toLocaleString('en-IN')}`
}

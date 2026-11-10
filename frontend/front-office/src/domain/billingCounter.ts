// Billing is its own department. Care Entry never takes money: it raises a
// bill and sends the patient to the billing counter, and the counter's
// record of the payment comes back here as the bill's status — received,
// pending or failed.
//
// DEMO STAND-IN: there is no billing system behind this front end, so the
// counter's update is simulated — a bill sent to the counter is marked paid
// a short while later, the way the real feed would update it. Swap
// `sendToBillingCounter` for the billing system's API when it exists.
import { getState } from './store'
import { collectPayment } from './actions'
import { isBillDue, billNumberFor } from '../utils/billing'
import type { Payment, PaymentMethod } from '../types/payment'

/** How long the simulated counter takes to record a payment. */
export const COUNTER_DELAY_MS = 20000

const waiting = new Map<string, number>()
const listeners = new Set<(bill: Payment) => void>()

function methodFor(bill: Payment): PaymentMethod {
  const admission = bill.admissionId ? getState().admissions.find((a) => a.admissionId === bill.admissionId) : undefined
  // An insured stay is settled by its insurer or TPA; everyone else pays by UPI.
  return admission && admission.paymentType !== 'Self Pay' ? 'Insurance/TPA' : 'UPI'
}

/** Sends a bill to the billing counter for the patient to pay there. */
export function sendToBillingCounter(paymentId: string): void {
  if (waiting.has(paymentId)) return
  const timer = window.setTimeout(() => {
    waiting.delete(paymentId)
    const bill = getState().payments.find((p) => p.paymentId === paymentId)
    if (!bill || !isBillDue(bill)) return
    try {
      const paid = collectPayment({ paymentId, amount: bill.balance, method: methodFor(bill) })
      for (const listener of listeners) listener(paid)
    } catch {
      // The bill changed meanwhile (cancelled, refunded) — nothing to record.
    }
  }, COUNTER_DELAY_MS)
  waiting.set(paymentId, timer)
}

/** Hears each payment the counter records — for the desk's notice. */
export function onCounterPayment(listener: (bill: Payment) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function counterNotice(bill: Payment): { title: string; detail: string } {
  return { title: 'Payment received at the billing counter', detail: `${bill.patientName} · ${billNumberFor(bill)}` }
}

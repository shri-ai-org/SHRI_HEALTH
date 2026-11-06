import { sendToBillingCounter } from '../domain/billingCounter'

// "Print bill": the desk prints the bill and hands it to the patient, who
// pays it at the billing counter. Care Entry takes no money — printing is
// also when the counter starts waiting for this bill's payment.
//
// The printed page itself is <BillPrintHost />, mounted once in App: it
// renders the bill for the print dialog only, so printing works from any
// page or flow without leaving it.

export interface BillPrintJob {
  paymentId: string
  /** A new job each time, so printing the same bill again prints again. */
  seq: number
  /** When it was printed — shown on the paper. */
  printedAt: number
}

let job: BillPrintJob | null = null
let seq = 0
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** Prints this bill for the patient to take to the billing counter. */
export function printBill(paymentId: string): void {
  sendToBillingCounter(paymentId)
  seq += 1
  job = { paymentId, seq, printedAt: Date.now() }
  emit()
}

export function subscribeBillPrint(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getBillPrintJob(): BillPrintJob | null {
  return job
}

/** The print dialog closed: the bill leaves the page again. */
export function finishBillPrint(done: BillPrintJob): void {
  if (job !== done) return
  job = null
  emit()
}

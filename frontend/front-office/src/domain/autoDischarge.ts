// Discharge finishes by itself. Once the final bill is printed, the stay is
// "waiting to discharge": the moment the billing counter records the payment
// (nothing left due on the stay), the patient is discharged with the type and
// remarks the desk chose — no second click, and even if the Discharge screen
// has been closed meanwhile. <AutoDischargeWatcher /> runs this for the app.
import { getState } from './store'
import { previewDischargeBill } from './admissionSelectors'
import { dischargeAdmission } from './admissionActions'
import type { Admission, DischargeDetails } from '../types/admission'

const waiting = new Map<string, DischargeDetails>()

/** The final bill is printed: discharge this stay as soon as it is paid. A
 *  later call (another type or remarks) replaces the details. */
export function armAutoDischarge(admissionId: string, details: DischargeDetails): void {
  waiting.set(admissionId, details)
}

export function isAutoDischargeArmed(admissionId: string): boolean {
  return waiting.has(admissionId)
}

/** Discharges every waiting stay whose bill is now paid; returns them. */
export function settleAutoDischarges(now: number = Date.now()): Admission[] {
  const done: Admission[] = []
  for (const [admissionId, details] of [...waiting]) {
    const state = getState()
    const admission = state.admissions.find((a) => a.admissionId === admissionId)
    // Discharged or cancelled some other way: nothing left to wait for.
    if (!admission || admission.status !== 'Admitted') {
      waiting.delete(admissionId)
      continue
    }
    if (!previewDischargeBill(state, admissionId, now)?.canDischarge) continue
    waiting.delete(admissionId)
    try {
      done.push(dischargeAdmission(admissionId, details))
    } catch {
      // Something changed meanwhile (a new charge) — the desk discharges it by hand.
    }
  }
  return done
}

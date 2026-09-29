// ported from src/screens/m18/S1817.tsx:59-83 and :211-212 — the thrombolysis
// eligibility gate, stated once so the screen cannot drift from it.
//
// The rules, unchanged: the BP item unblocks ONLY when a reading below 185/110
// is DOCUMENTED (documenting a reading above it is not reaching the target);
// the DOAC item is contraindicated unless the last dose is confirmed more than
// 48 hours ago; the drug is given only when nothing blocks AND the independent
// second dose check is recorded AND consent is taken — with the AI on or off.
//
// Two defects fixed, in the direction of safety: answering "unknown" on the
// old screen turned a BLOCKING or CONTRAINDICATED item into a mere unknown, so
// "Answer unknown" on the BP or the DOAC item lifted the block — an unknown
// here is recorded as the answer, and a blocking item stays blocking until the
// step that unblocks it is taken; and the "second qualified person" could be
// anyone on the staff list, the billing and TPA desks included — here it is a
// doctor or a nurse.

import { STAFF, type Staff } from '@/data/kit'
import type { Criterion, CriterionState } from '@/data/stroke'

/** The nursing personas: the ward staff nurse and the stroke coordinator. */
const NURSES = new Set(['P-07', 'P-37'])

/** Who may do the independent second dose check: a qualified clinician other than the prescriber. */
export function secondCheckers(prescriber: Staff): Staff[] {
  return STAFF.filter((s) => s.id !== prescriber.id && (s.identifierKind === 'HPR' || NURSES.has(s.persona)))
}

export type GateState = CriterionState | 'resolved'

export interface BpReading {
  systolic: number
  diastolic: number
}

/** The documented reading is below 185/110 — the only thing that unblocks the BP item. */
export const bpBelowThreshold = (bp: BpReading | null) => bp !== null && bp.systolic < 185 && bp.diastolic < 110

export const isBlocking = (s: GateState) => s === 'blocks' || s === 'contraindicated'

/**
 * A criterion's state and answer now. `resolution` is the step that unblocked
 * it (a BP documented below threshold, a DOAC timing confirmed or overridden
 * with a reason), `answered` what the clinician recorded against it.
 */
export function criterionNow(crit: Criterion, answered: string | undefined, resolution: string | undefined): { state: GateState; answer: string } {
  if (resolution !== undefined) return { state: 'resolved', answer: resolution }
  if (answered === undefined) return { state: crit.state, answer: crit.answer }
  if (answered === 'Unknown') return { state: isBlocking(crit.state) ? crit.state : 'unknown', answer: answered }
  return { state: crit.state, answer: answered }
}

/** Whether the drug may be given: nothing blocks, the second check is recorded, consent is taken. */
export const mayGive = (blocking: number, secondCheckBy: string | null, consent: boolean) => blocking === 0 && secondCheckBy !== null && consent

/** What is still outstanding, in the order the gate checks it. */
export function outstanding(blocking: number, secondCheckBy: string | null, consent: boolean): 'blocking' | 'second check' | 'consent' | null {
  if (blocking > 0) return 'blocking'
  if (!secondCheckBy) return 'second check'
  if (!consent) return 'consent'
  return null
}

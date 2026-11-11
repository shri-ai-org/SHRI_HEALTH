// ported from src/screens/m13/S1303.tsx:33-103 — the reconciliation rows, the
// four decisions, and the rule that makes the screen honest: every admission
// medicine must be accounted for, and "not carried forward" needs a reason.
//
// The rows are R. Lakshmanan's — his AKI, his penicillin allergy, his
// step-down from piperacillin-tazobactam. The old screen showed them on every
// encounter's reconciliation; here they are his, and anyone else's
// reconciliation says there is no medicine list to reconcile.

import type { ConfidenceBand } from '@/atlas/confidence'
import type { MedRecDecision, MedRecRecord } from '@/store/clinical'

export interface MedLine {
  drug: string
  dose: string
  frequency: string
}

export interface MedRow {
  id: string
  /** What the patient was on before or during admission. */
  admission: MedLine | null
  /** What AI-306 proposes for discharge. */
  proposed: MedLine | null
  matchConfidence?: number
  matchBand?: ConfidenceBand
  rationale?: string
  /** Interaction or contraindication on the proposed line (AI-205). */
  caution?: string
}

const SD_P_03: MedRow[] = [
  {
    id: 'M-1',
    admission: { drug: 'Metformin 500mg', dose: '500 mg', frequency: 'twice daily' },
    proposed: { drug: 'Metformin 500mg', dose: '500 mg', frequency: 'twice daily' },
    matchConfidence: 0.96,
    matchBand: 'HIGH',
    rationale: 'Held during the acute kidney injury and restarted on 23-Sep once creatinine recovered. Unchanged.',
  },
  {
    id: 'M-2',
    admission: { drug: 'Atorvastatin 40mg', dose: '40 mg', frequency: 'at night' },
    proposed: { drug: 'Atorvastatin 40mg', dose: '40 mg', frequency: 'at night' },
    matchConfidence: 0.94,
    matchBand: 'HIGH',
    rationale: 'Continued. No change.',
    caution: 'Interacts with clarithromycin. If a macrolide is added, hold the statin for the course.',
  },
  {
    id: 'M-3',
    admission: { drug: 'Piperacillin-tazobactam 4.5g IV', dose: '4.5 g', frequency: '8-hourly' },
    proposed: { drug: 'Levofloxacin 750mg', dose: '750 mg', frequency: 'once daily, 3 days' },
    matchConfidence: 0.72,
    matchBand: 'MED',
    rationale:
      'Intravenous cover switched to an oral step-down. Not a like-for-like substitution — the class changed because of the documented penicillin allergy.',
  },
  {
    id: 'M-4',
    admission: { drug: 'Enoxaparin 40mg SC', dose: '20 mg', frequency: 'once daily (renally adjusted)' },
    proposed: null,
    matchConfidence: 0.88,
    matchBand: 'HIGH',
    rationale: 'Thromboprophylaxis for the inpatient stay only. Stopped on discharge as mobility is restored.',
  },
  {
    id: 'M-5',
    admission: null,
    proposed: { drug: 'Paracetamol 1g IV', dose: '1 g oral', frequency: '6-hourly as required, max 4 g in 24 hours' },
    matchConfidence: 0.9,
    matchBand: 'HIGH',
    rationale: 'New on discharge for residual pleuritic pain. A 24-hour ceiling is stated, per the completeness rule.',
  },
]

/** The medicine lines to reconcile for a patient — only where the record has them. */
export function medRowsFor(patientId: string): MedRow[] {
  return patientId === 'SD-P-03' ? SD_P_03 : []
}

export const DECISIONS: readonly MedRecDecision[] = ['continue', 'changed', 'stopped', 'new']

export const DECISION_LABEL: Record<MedRecDecision, string> = {
  continue: 'Continued',
  changed: 'Changed',
  stopped: 'Stopped',
  new: 'New',
}

/** AI-306's proposed decision for a row. */
export function suggestedDecision(r: MedRow): MedRecDecision {
  return r.proposed === null ? 'stopped' : r.admission === null ? 'new' : r.matchBand === 'HIGH' ? 'continue' : 'changed'
}

/** "Continued. No change." says nothing the row does not — it is not shown. */
export const isTrivial = (t: string) => /^continued\.?\s*no change\.?$/i.test(t.trim())

/** The two ways a list is not yet confirmable: a line undecided, or a stopped line with no reason. */
export function medRecGaps(rows: MedRow[], rec: MedRecRecord | undefined) {
  const decisions = rec?.decisions ?? {}
  const reasons = rec?.reasons ?? {}
  const undecided = rows.filter((r) => !decisions[r.id])
  const missingReason = rows.filter((r) => decisions[r.id] === 'stopped' && !(reasons[r.id] ?? '').trim())
  return { undecided, missingReason }
}

/** Whether a patient's reconciliation is still open — rows to reconcile, and the list not yet confirmed. */
export function medRecOpen(patientId: string, rec: MedRecRecord | undefined): boolean {
  return medRowsFor(patientId).length > 0 && !rec?.confirmedAt
}

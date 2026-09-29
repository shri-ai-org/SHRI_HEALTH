/**
 * The inpatients under this doctor, live — one list in one order for every
 * card that shows them: My Day's Patients Today → Inpatients, its ICU and
 * admissions counts, and My patients → Inpatients (S-08-03). Ported from
 * `src/data/myday.ts` (`inpatientList`) and the order S-08-03 draws
 * (`src/screens/m08/S0803.tsx`): anyone needing attention pinned first, then
 * AI-613's order while the AI is on and chosen, otherwise time order. A
 * discharged patient has left every list at once.
 */

import { useMemo } from 'react'

import { inpatientRows, isAdmittedHere, type Admissions } from '@/data/admissions'
import { DISCHARGE_BOARD, NEEDS_ATTENTION, type WorklistRow } from '@/data/clinical'
import type { PatientListRow } from '@/data/myday'
import { useAdmissions } from '@/store/admissions'
import { useClinical } from '@/store/clinical'

import { useAiActive } from '../state/ai'

export interface InpatientRow extends PatientListRow {
  row: WorklistRow
  /** Pinned in the "Needs attention" group. */
  pinned: boolean
}

function placeOf(bed: string | null): PatientListRow['place'] {
  if (bed?.startsWith('ICU')) return { icon: 'HeartPulse', label: 'ICU' }
  if (bed?.startsWith('ED')) return { icon: 'Ambulance', label: 'ED' }
  return { icon: 'BedDouble', label: 'Ward' }
}

export function inpatientsLive(admissions: Admissions, discharged: (patientId: string) => boolean, byAi: boolean): InpatientRow[] {
  const goingHome = new Set(DISCHARGE_BOARD.filter((d) => d.likelihood === 'Today').map((d) => d.patientId))
  const all = inpatientRows(admissions).filter((r) => !discharged(r.patientId))
  const pinnedIds = new Set(NEEDS_ATTENTION.filter((n) => !discharged(n.patientId)).map((n) => n.patientId))
  const pinned = NEEDS_ATTENTION.filter((n) => pinnedIds.has(n.patientId) && all.some((r) => r.patientId === n.patientId))
  const others = all.filter((r) => !pinnedIds.has(r.patientId))
  const ordered = [...pinned, ...(byAi ? others : [...others].sort((a, b) => a.chronologicalAt.getTime() - b.chronologicalAt.getTime()))]
  return ordered.map((r) => ({
    patientId: r.patientId,
    place: placeOf(r.bed),
    detail: r.bed ?? undefined,
    status:
      r.risk === 'HIGH'
        ? { label: 'High risk', icon: 'TriangleAlert', tone: 'critical' }
        : isAdmittedHere(r.patientId, admissions)
          ? { label: 'Admitted today', icon: 'LogIn', tone: 'neutral' }
          : goingHome.has(r.patientId)
            ? { label: 'Discharge today', icon: 'LogOut', tone: 'neutral' }
            : undefined,
    row: r,
    pinned: pinnedIds.has(r.patientId),
  }))
}

/** The live inpatient list; `aiSort` is the reader's own choice of order (S-08-03's sort control), AI-613's by default. */
export function useInpatientsLive(aiSort = true): InpatientRow[] {
  const admissions = useAdmissions((s) => s.admissions)
  const discharges = useClinical((s) => s.discharges)
  const aiActive = useAiActive()
  return useMemo(() => inpatientsLive(admissions, (id) => discharges[id] !== undefined, aiActive && aiSort), [admissions, discharges, aiActive, aiSort])
}

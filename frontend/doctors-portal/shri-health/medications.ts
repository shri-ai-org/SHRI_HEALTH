// SHRI_HEALTH data layer: the patient's medication list (GET /patients/{id}/medications, US Core
// MedicationRequest with intent and reported, D28), read once through Suspense, for the record's
// summary card and its Prescriptions page. Current entries are "Taking now"; completed and stopped
// ones are the history. Entries marked entered in error are left out.
import type { PrescriptionRecord, RxItem } from '@/data/record'

import { listMedications } from '../../src/api/generated/endpoints/medications/medications'
import type { Medication } from '../../src/api/generated/model'

import { clinicDate } from './format'
import { read } from './resource'

export type CurrentMedicine = RxItem & { since: Date; by: string }

export interface MedicationList {
  current: CurrentMedicine[]
  history: PrescriptionRecord[]
}

const STATUS: Record<string, RxItem['status'] | undefined> = { active: 'Active', completed: 'Completed', stopped: 'Stopped' }

/** Who put it on the list: our prescription, or what the patient reported. The recorder's name isn't in the API yet (#93). */
const byOf = (m: Medication) => (m.source === 'prescription' ? 'Prescribed here' : 'Reported')

function itemOf(m: Medication): RxItem {
  return {
    drug: m.medication.text ?? m.medication.codings?.[0]?.display ?? 'Unnamed medication',
    // The API keeps the directions as one text (dosageText); dose, route and duration aren't separate.
    dose: '',
    route: '',
    frequency: m.dosageText ?? '',
    duration: '',
    status: STATUS[m.status] ?? 'Active',
    note: m.note,
  }
}

async function load(patientId: string): Promise<MedicationList> {
  const all: Medication[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10; page += 1) {
    const res = await listMedications(patientId, { limit: 100, ...(cursor ? { cursor } : {}) })
    const data = res.data as { items: Medication[]; nextCursor?: string | null }
    all.push(...data.items)
    cursor = data.nextCursor ?? undefined
    if (!cursor) break
  }
  const kept = all.filter((m) => m.status !== 'entered-in-error').sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
  return {
    current: kept.filter((m) => m.status === 'active').map((m) => ({ ...itemOf(m), since: clinicDate(m.recordedAt), by: byOf(m) })),
    history: kept
      .filter((m) => m.status !== 'active')
      .map((m) => ({ id: m.id, patientId, at: clinicDate(m.recordedAt), by: byOf(m), context: 'Medication list', items: [itemOf(m)] })),
  }
}

/** The patient's medication list. */
export function medicationsFor(patientId: string): MedicationList {
  return read(`medications:${patientId}`, () => load(patientId))
}

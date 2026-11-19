// SHRI_HEALTH data layer: the patient's medication list (GET /patients/{id}/medications, US Core
// MedicationRequest with intent and reported, D28), read once through Suspense, for the record's
// summary card and its Prescriptions page. Current entries are "Taking now"; completed and stopped
// ones are the history. Entries marked entered in error are left out.
import type { PrescriptionRecord, RxItem } from '@/data/record'

import { listMedications } from '../../src/api/generated/endpoints/medications/medications'
import type { Medication } from '../../src/api/generated/model'

import { clinicDate } from './format'
import { read } from './resource'
import { useEffect, useState } from 'react'

/** `prescriptionId`: our prescription, whose pharmacy the page reads (getPrescription). */
export type CurrentMedicine = RxItem & { id: string; since: Date; by: string; prescriptionId?: string }

export interface MedicationList {
  current: CurrentMedicine[]
  history: (PrescriptionRecord & { prescriptionId?: string })[]
}

const STATUS: Record<string, RxItem['status'] | undefined> = { active: 'Active', completed: 'Completed', stopped: 'Stopped' }

/**
 * Who it is by: the prescriber the list names for a signed prescription (prescriberDisplayName, #438),
 * "Prescriber unavailable" when it names none, and "Reported" for what the patient reported.
 * recordedBy is never shown as a prescriber: for a reported medicine it is whoever entered it.
 */
const byOf = (m: Medication) =>
  m.source === 'prescription' ? (m.prescriberDisplayName ?? 'Prescriber unavailable') : 'Reported'

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

export async function loadMedications(patientId: string): Promise<MedicationList> {
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
    current: kept
      .filter((m) => m.status === 'active')
      .map((m) => ({ ...itemOf(m), id: m.id, since: clinicDate(m.recordedAt), by: byOf(m), prescriptionId: m.prescriptionId })),
    history: kept
      .filter((m) => m.status !== 'active')
      .map((m) => ({ id: m.id, patientId, at: clinicDate(m.recordedAt), by: byOf(m), context: 'Medication list', items: [itemOf(m)], prescriptionId: m.prescriptionId })),
  }
}

/**
 * How many medications the patient takes now, for the record's Prescriptions tab: read once in the
 * background (it never holds up the page); undefined until read, and when the read is refused or
 * fails, so the tab shows no count rather than a wrong one.
 */
export function useActiveMedicationCount(patientId: string): number | undefined {
  const [count, setCount] = useState<{ patientId: string; n: number } | null>(null)
  useEffect(() => {
    if (!patientId) return
    let live = true
    loadMedications(patientId).then(
      (list) => live && setCount({ patientId, n: list.current.length }),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [patientId])
  return count && count.patientId === patientId ? count.n : undefined
}

/** The patient's medication list. */
export function medicationsFor(patientId: string): MedicationList {
  return read(`medications:${patientId}`, () => loadMedications(patientId))
}

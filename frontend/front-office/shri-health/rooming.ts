// Rooming at the desk on the SHRI_HEALTH API (demo step 6), for the rooming sheet
// (`src/flows/rooming/RoomingFlow.tsx`; Minalini's exception of 2026-11-10: a care-entry sheet opened
// from the Outpatients row, no page of its own). The medical assistant (MA, or RN) rooms a
// checked-in patient: the room, the vitals, the allergy review and the medication review, then
// the visit becomes "roomed" (recordVisitStatus). The front desk can't read the encounter (403).
//   the visit       ⇐ getAppointment (its encounter) → getEncounter (its patient and facility)
//   rooms           ⇐ listBookableLocations (exam rooms, else every location)
//   allergies       ⇐ listAllergies;  ⇒ addAllergy (Idempotency-Key), "No known allergies" as SNOMED 716186003
//   medications     ⇐ listMedications; ⇒ recordMedication (Idempotency-Key), the patient's own list
//   vitals          ⇒ recordVitals (Idempotency-Key), built by src/features/clinical/vitals.ts (U.S. units)
//   roomed          ⇒ recordVisitStatus { status: 'roomed', roomLocationId } (Idempotency-Key)
// Each write keeps its key while it is retried, so the server does it once.
import { getEncounter, recordVitals } from '../../src/api/generated/endpoints/encounters/encounters'
import { addAllergy, listAllergies } from '../../src/api/generated/endpoints/history/history'
import { listMedications, recordMedication } from '../../src/api/generated/endpoints/medications/medications'
import { getAppointment, listBookableLocations, recordVisitStatus } from '../../src/api/generated/endpoints/scheduling/scheduling'
import type { Allergy, BookableLocation, Medication, VitalEntry } from '../../src/api/generated/model'
import { useSession } from '../../src/api/session'
import { newIdempotencyKey } from './client'

/** SNOMED CT "No known allergy" (716186003), the statement the contract names for it. */
const NO_KNOWN_ALLERGY = { codings: [{ system: 'http://snomed.info/sct', code: '716186003', display: 'No known allergy' }], text: 'No known allergies' }

export interface RoomingVisit {
  appointmentId: string
  encounterId: string
  patientId: string
  rooms: BookableLocation[]
  allergies: Allergy[]
  medications: Medication[]
}

/** Who may room a patient: the server's visit-status rule (MA and RN). */
export function useMayRoom(): boolean {
  const { state } = useSession()
  return state.status === 'signed-in' && state.session.user.roles.some((r) => r === 'MA' || r === 'RN')
}

export async function loadRooming(appointmentId: string): Promise<RoomingVisit> {
  const appt = await getAppointment(appointmentId)
  if (appt.status !== 200) throw new Error('The visit could not be read')
  const encounterId = appt.data.encounterId
  if (!encounterId) throw new Error('This visit is not checked in yet')
  const enc = await getEncounter(encounterId)
  if (enc.status !== 200) throw new Error('The visit could not be read')
  const { patientId, facilityId } = enc.data
  const [locations, allergies, medications] = await Promise.all([
    listBookableLocations({ facilityId, limit: 100 }),
    listAllergies(patientId, { limit: 100 }),
    listMedications(patientId, { limit: 100 }),
  ])
  const all = locations.status === 200 ? locations.data.items : []
  const exam = all.filter((l) => l.physicalType === 'ro')
  return {
    appointmentId,
    encounterId,
    patientId,
    rooms: exam.length > 0 ? exam : all,
    allergies: allergies.status === 200 ? allergies.data.items : [],
    medications: medications.status === 200 ? medications.data.items : [],
  }
}

export async function saveVitals(encounterId: string, entries: VitalEntry[], key: string = newIdempotencyKey()): Promise<void> {
  const res = await recordVitals(encounterId, { entries }, { 'Idempotency-Key': key })
  if (res.status >= 300) throw new Error('The vitals were not saved')
}

/** An allergy as the patient states it (free text), or "No known allergies". */
export async function addAllergyEntry(visit: RoomingVisit, text: string | null, key: string = newIdempotencyKey()): Promise<Allergy> {
  const code = text === null ? NO_KNOWN_ALLERGY : { text: text.trim() }
  const res = await addAllergy(visit.patientId, { code, encounterId: visit.encounterId }, { 'Idempotency-Key': key })
  if (res.status >= 300) throw new Error('The allergy was not saved')
  return res.data as Allergy
}

/** A medicine the patient takes, as they state it, on their own list. */
export async function addMedicationEntry(visit: RoomingVisit, text: string, dosageText: string, key: string = newIdempotencyKey()): Promise<Medication> {
  const res = await recordMedication(visit.patientId, { medication: { text: text.trim() }, status: 'active', ...(dosageText.trim() ? { dosageText: dosageText.trim() } : {}) }, { 'Idempotency-Key': key })
  if (res.status >= 300) throw new Error('The medication was not saved')
  return res.data as Medication
}

export async function markRoomed(appointmentId: string, roomLocationId: string | undefined, key: string = newIdempotencyKey()): Promise<void> {
  const res = await recordVisitStatus(appointmentId, { status: 'roomed', ...(roomLocationId ? { roomLocationId } : {}) }, { 'Idempotency-Key': key })
  if (res.status >= 300) throw new Error('The patient was not marked roomed')
}

export function allergyLabel(a: Allergy): string {
  return a.code.text ?? a.code.codings?.[0]?.display ?? 'Allergy'
}

export function medicationLabel(m: Medication): string {
  const name = m.medication.text ?? m.medication.codings?.[0]?.display ?? 'Medication'
  return m.dosageText ? `${name} · ${m.dosageText}` : name
}

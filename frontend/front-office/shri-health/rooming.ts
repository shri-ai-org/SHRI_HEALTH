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
//   reason          ⇒ updateEncounter { reasons: [{ text }] } (If-Match from getEncounter; MA and RN may
//                      change reasons only, Q21/T52); a 412 reads the visit again
//   roomed          ⇒ recordVisitStatus { status: 'roomed', roomLocationId } (Idempotency-Key)
// Each write keeps its key while it is retried, so the server does it once.
import { ApiError, etagOf } from '../../src/api/client'
import { getEncounter, recordVitals, searchCodes, updateEncounter } from '../../src/api/generated/endpoints/encounters/encounters'
import { addAllergy, listAllergies } from '../../src/api/generated/endpoints/history/history'
import { listMedications, recordMedication } from '../../src/api/generated/endpoints/medications/medications'
import { getAppointment, listBookableLocations, recordVisitStatus } from '../../src/api/generated/endpoints/scheduling/scheduling'
import type { Allergy, BookableLocation, Encounter, Medication, VitalEntry } from '../../src/api/generated/model'
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
  /** The visit's version, sent as If-Match with the reason for visit. */
  encounterEtag: string
  /** The reason for visit as the server holds it ('' for none). */
  reason: string
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
  const etag = etagOf(enc)
  if (!etag) throw new Error('The visit has no version to change it against')
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
    encounterEtag: etag,
    reason: reasonOf(enc.data),
  }
}

function reasonOf(e: Encounter): string {
  const first = e.reasons?.[0]
  return first?.text ?? first?.codings?.[0]?.display ?? ''
}

/** The visit changed since the sheet read it (412): the latest version, to show before trying again. */
export class ReasonChanged extends Error {
  readonly latest: { encounterEtag: string; reason: string }
  constructor(latest: { encounterEtag: string; reason: string }) {
    super('The visit changed while you were rooming. The latest reason for visit is shown; check it and try again.')
    this.latest = latest
  }
}

/** Saves the reason for visit (or clears it) when it differs from the server's; returns the new version. */
export async function saveReason(visit: RoomingVisit, text: string): Promise<RoomingVisit> {
  const reason = text.trim()
  if (reason === visit.reason) return visit
  try {
    const res = await updateEncounter(visit.encounterId, { reasons: reason ? [{ text: reason }] : null }, { 'If-Match': visit.encounterEtag })
    return { ...visit, encounterEtag: etagOf(res) ?? visit.encounterEtag, reason }
  } catch (e) {
    if (e instanceof ApiError && e.status === 412) {
      const enc = await getEncounter(visit.encounterId)
      if (enc.status !== 200) throw e
      throw new ReasonChanged({ encounterEtag: etagOf(enc) ?? visit.encounterEtag, reason: reasonOf(enc.data) })
    }
    throw e
  }
}

export async function saveVitals(encounterId: string, entries: VitalEntry[], key: string = newIdempotencyKey()): Promise<void> {
  const res = await recordVitals(encounterId, { entries }, { 'Idempotency-Key': key })
  if (res.status >= 300) throw new Error('The vitals were not saved')
}

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'

/** An RxNorm concept offered at rooming: an ingredient for an allergy, a drug for a medication. */
export interface CodedChoice {
  code: string
  display: string
}

/**
 * The RxNorm ingredients that match what was typed (M3): the drug search (`GET /codes?system=rxnorm`,
 * drug names only in the query, D13) answers products, each with its ingredients; an allergy is
 * recorded against the ingredient, which is what the prescription safety check matches (D97, D99).
 */
export async function findAllergens(query: string): Promise<CodedChoice[]> {
  const res = await searchCodes({ system: 'rxnorm', q: query.trim(), limit: 25 })
  if (res.status !== 200) throw new Error('The drug list could not be searched')
  const seen = new Map<string, CodedChoice>()
  for (const m of res.data.items) for (const i of m.drug?.ingredients ?? []) if (!seen.has(i.rxcui)) seen.set(i.rxcui, { code: i.rxcui, display: i.name })
  const q = query.trim().toLowerCase()
  // The ingredients named like the query first ("amox" → Amoxicillin before Clavulanate).
  return [...seen.values()].sort((a, b) => Number(!a.display.toLowerCase().startsWith(q)) - Number(!b.display.toLowerCase().startsWith(q))).slice(0, 10)
}

/** The RxNorm drugs that match what was typed, for the patient's medication list (the duplicate check). */
export async function findDrugs(query: string): Promise<CodedChoice[]> {
  const res = await searchCodes({ system: 'rxnorm', q: query.trim(), limit: 10 })
  if (res.status !== 200) throw new Error('The drug list could not be searched')
  return res.data.items.map((m) => ({ code: m.code, display: m.display }))
}

const coded = (c: CodedChoice) => ({ codings: [{ system: RXNORM, code: c.code, display: c.display }], text: c.display })

/**
 * An allergy: coded in RxNorm when a match was picked (the prescribing alerts use it), else as the
 * patient states it (free text, kept but never matched), or "No known allergies" (`null`).
 */
export async function addAllergyEntry(visit: RoomingVisit, entry: string | CodedChoice | null, key: string = newIdempotencyKey()): Promise<Allergy> {
  const code = entry === null ? NO_KNOWN_ALLERGY : typeof entry === 'string' ? { text: entry.trim() } : coded(entry)
  const res = await addAllergy(visit.patientId, { code, encounterId: visit.encounterId }, { 'Idempotency-Key': key })
  if (res.status >= 300) throw new Error('The allergy was not saved')
  return res.data as Allergy
}

/** A medicine the patient takes, on their own list: coded in RxNorm when a match was picked, else as stated. */
export async function addMedicationEntry(visit: RoomingVisit, entry: string | CodedChoice, dosageText: string, key: string = newIdempotencyKey()): Promise<Medication> {
  const medication = typeof entry === 'string' ? { text: entry.trim() } : coded(entry)
  const res = await recordMedication(visit.patientId, { medication, status: 'active', ...(dosageText.trim() ? { dosageText: dosageText.trim() } : {}) }, { 'Idempotency-Key': key })
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

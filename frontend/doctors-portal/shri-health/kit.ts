// SHRI_HEALTH data layer: `patient` (src/data/kit.ts) over GET /patients/{id}, its coverages and
// its allergies.
import { patient as mockPatient, patientByAnyId as mockPatientByAnyId, type Patient, type Payer } from '@/data/kit'

import { getPatient, getPatientSummaries, listCoverages } from '../../src/api/generated/endpoints/patients/patients'
import { listAllergies } from '../../src/api/generated/endpoints/history/history'
import type { Allergy, Coverage, Patient as ApiPatient, PatientSummary, PatientSummaryList } from '../../src/api/generated/model'

import { read } from './resource'

// TODO: the screen's own diagnosis shortlist (India); the picker no longer searches it (icd10.ts).
export { DIAGNOSES, STAFF } from '@/data/kit'

const SNOMED = 'http://snomed.info/sct'
/** SNOMED CT 716186003: the contract's explicit "no known allergies" statement (AllergyCreate.code). */
const NO_KNOWN_ALLERGY = '716186003'

/** Patients from the API with an active "no known allergies" statement; the rest have none recorded. */
const assertedNone = new Map<string, boolean>()

/**
 * The banner's words when the patient has no allergy: "No known allergy" only when it is recorded
 * as such, otherwise "Allergies not recorded". A patient still on mock data keeps the mock's words.
 */
export function allergyLabel(p: Pick<Patient, 'id'>): string {
  return allergiesNotRecorded(p) ? 'Allergies not recorded' : 'No known allergy'
}

/** True for a patient from the API with no allergy records and no "no known allergies" statement. */
export function allergiesNotRecorded(p: Pick<Patient, 'id'>): boolean {
  return assertedNone.get(p.id) === false
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** ABHA is India's health ID (D26): the banner shows it only for a patient still on mock data. */
export function hasAbha(p: Pick<Patient, 'id'>): boolean {
  return !UUID.test(p.id)
}

/** The patient-language choices for printed and portal instructions (US wording change; the register screen's list). */
export const PATIENT_LANGUAGES = [
  { code: 'EN', label: 'English' },
  { code: 'ES', label: 'Spanish' },
  { code: 'ZH', label: 'Chinese' },
  { code: 'VI', label: 'Vietnamese' },
  { code: 'TL', label: 'Tagalog' },
  { code: 'AR', label: 'Arabic' },
] as const

/** Each API patient's preferred language from registration (BCP 47, e.g. `es`), as the list's code. */
const preferred = new Map<string, string>()

/** The patient's preferred language when it is one of the list's, otherwise English. */
export function defaultLanguageFor(patientId: string): string {
  const code = preferred.get(patientId)
  return PATIENT_LANGUAGES.some((l) => l.code === code) ? code! : 'EN'
}

/** The record's patient by its address: an API patient by its opaque ID (D13), else the mock's lookup. */
export function patientByAnyId(key: string | undefined): Patient | undefined {
  if (key && UUID.test(key)) return patient(key)
  return mockPatientByAnyId(key)
}

export function patient(id: string): Patient {
  // A screen that mixes real rows with sections still on mock data (My Day's inpatients and
  // results) passes mock IDs too: those stay with the mock.
  if (!UUID.test(id)) return mockPatient(id)
  return read(`patient:${id}`, async () => {
    const [p, coverages, allergies] = await Promise.all([getPatient(id), listCoverages(id), listAllergies(id)])
    return toPatient(p.data as ApiPatient, (coverages.data as { items: Coverage[] }).items, (allergies.data as { items: Allergy[] }).items)
  })
}

/** The home screen's patients from one batched summary read, by ID (M6). */
const summaries = new Map<string, Patient>()

/**
 * Reads the summaries of a list's patients in one call (at most 50 IDs per call), instead of a
 * patient, coverage and allergy read per row (M6). The home screen shows only name, age, sex and
 * MRN, so allergies and payer are not read for it. Suspends until the call answers.
 */
export function primeSummaries(ids: string[]): void {
  const want = [...new Set(ids.filter((id) => UUID.test(id)))].sort()
  if (want.length === 0) return
  read(`summaries:${want.join(',')}`, async () => {
    for (let i = 0; i < want.length; i += 50) {
      const res = await getPatientSummaries({ patientIds: want.slice(i, i + 50) })
      for (const s of (res.data as PatientSummaryList).items) summaries.set(s.id, fromSummary(s))
    }
  })
}

/** A home-screen patient: from the batched summary, else the full read (never sample data for an API patient). */
export function summaryPatient(id: string): Patient {
  if (!UUID.test(id)) return mockPatient(id)
  return summaries.get(id) ?? patient(id)
}

function fromSummary(s: PatientSummary): Patient {
  return {
    id: s.id,
    name: [...(s.name.given ?? []), s.name.family].join(' '),
    age: s.birthDate ? ageOn(s.birthDate, new Date()) : 0,
    sex: s.gender === 'male' ? 'M' : s.gender === 'female' ? 'F' : 'O',
    uhid: s.mrn,
    scenario: '',
    // Not read for the home screen (M6): the chart's own read has the payer and allergies.
    payer: '' as Payer,
    abha: null,
    abhaStatus: 'Not linked',
    allergies: [],
    bed: null,
    facilityCode: '',
  }
}

function toPatient(p: ApiPatient, coverages: Coverage[], allergies: Allergy[]): Patient {
  const live = allergies.filter((a) => a.clinicalStatus !== 'inactive' && a.clinicalStatus !== 'resolved' && a.verificationStatus !== 'refuted' && a.verificationStatus !== 'entered-in-error')
  const isNone = (a: Allergy) => a.code.codings?.some((c) => c.system === SNOMED && c.code === NO_KNOWN_ALLERGY) ?? false
  assertedNone.set(p.id, live.some(isNone))
  if (p.preferredLanguage) preferred.set(p.id, p.preferredLanguage.split('-')[0].toUpperCase())
  const primary = coverages.filter((c) => c.status === 'active').sort((a, b) => a.order - b.order)[0]
  return {
    id: p.id,
    name: [...(p.name.given ?? []), p.name.family].join(' '),
    age: p.birthDate ? ageOn(p.birthDate, new Date()) : 0,
    sex: p.gender === 'male' ? 'M' : p.gender === 'female' ? 'F' : 'O',
    // The banner's record number: the practice's MRN (D41).
    uhid: p.mrn,
    scenario: '',
    // TODO(gap): the screen's payer list is India's; the US payer's name is shown as it is.
    payer: (primary?.payerName ?? 'None yet') as Payer,
    // TODO(gap): no ABHA in the US; the banner shows "Not linked".
    abha: null,
    abhaStatus: 'Not linked',
    // A "no known allergies" statement is not an allergy: the banner says it through allergyLabel().
    allergies: live.filter((a) => !isNone(a)).map((a) => a.code.text ?? a.code.codings?.[0]?.display ?? a.code.codings?.[0]?.code ?? ''),
    bed: null,
    facilityCode: '',
  }
}

function ageOn(birthDate: string, on: Date): number {
  const [y, m, d] = birthDate.split('-').map(Number)
  const age = on.getFullYear() - y
  return on.getMonth() + 1 < m || (on.getMonth() + 1 === m && on.getDate() < d) ? age - 1 : age
}

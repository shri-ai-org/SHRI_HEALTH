// Patients on the SHRI_HEALTH API: search, registration and the patient's record (#78).
//
// The screens keep reading the store through selectors (domain/store.ts's DEV NOTE): every patient
// the API returns is reconciled into `state.patients` under its API id, and the screens show it
// like any other. Only what the API returns is held, so there is no browsable list of every
// patient (SHRI_HEALTH D65): a patient appears once searched, registered or opened.
//
// Field mapping, Care Entry ⇄ contract:
//   patientId      ⇄ id (opaque UUID; the only patient key that goes in a URL, D13)
//   uhid           ⇐ mrn (issued by the server, never typed: D41)
//   name           ⇐ name.given + name.family;  first and last name ⇒ name.given[0], name.family
//   age            ⇐ birthDate (computed);       date of birth ⇒ birthDate (required, D44)
//   sex            ⇄ gender (Male/Female/Other ⇄ male/female/other; unknown shows as Other)
//   mobile         ⇄ phones[0] (10-digit US number ⇄ E.164 +1…, shown as (617) 555-0188; a search result has only phoneLast4)
//   email          ⇐ emails[0].address
//   address        ⇐ address (lines, city, state, postal code); free text is not sent (the contract's
//                    address is structured: lines, city, two-letter state, ZIP)
//   abhaId         ⇐ never (the contract has no ABHA; India market codes are SHRI_HEALTH D26)
import {
  getPatient as apiGetPatient,
  getPatientSummaries as apiGetPatientSummaries,
  registerPatient as apiRegisterPatient,
  searchPatients as apiSearchPatients,
} from '../../src/api/generated/endpoints/patients/patients'
import type { Patient as ApiPatient, PatientCreate, PatientSearchRequestCriteria, PatientSummary } from '../../src/api/generated/model'
import { newIdempotencyKey } from './client'
import { setState } from '../src/domain/store'
import { formatMobile } from '../src/utils/phone'
import type { Patient, Sex } from '../src/types/patient'

const SEX_FROM_GENDER: Record<string, Sex> = { male: 'Male', female: 'Female', other: 'Other', unknown: 'Other' }
const GENDER_FROM_SEX: Record<Sex, 'male' | 'female' | 'other'> = { Male: 'male', Female: 'female', Other: 'other' }

function displayName(name: { family: string; given?: string[] }): string {
  return [...(name.given ?? []), name.family].filter(Boolean).join(' ')
}

/** Whole years on `today` (local date), or null without a birth date. */
export function ageOn(birthDate: string | null | undefined, today: Date = new Date()): number | null {
  if (!birthDate) return null
  const [y, m, d] = birthDate.split('-').map(Number)
  if (!y || !m || !d) return null
  let age = today.getFullYear() - y
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age -= 1
  return age
}

/** A 10-digit US number as the contract stores phones (E.164, +1…; Minalini, 2026-11-04). */
export function toE164(mobile: string): string {
  const digits = mobile.replace(/\D/g, '')
  return `+1${digits.slice(-10)}`
}

function fromE164(number: string | undefined): string {
  if (!number) return ''
  // A US number reads as (617) 555-0188 (display only; the contract keeps E.164).
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number)
  if (us) return `(${us[1]}) ${us[2]}-${us[3]}`
  return number.startsWith('+91') ? formatMobile(number) : number
}

function base(id: string, mrn: string, name: { family: string; given?: string[] }, birthDate: string | null | undefined, gender: string | null | undefined): Patient {
  return {
    patientId: id,
    uhid: mrn,
    name: displayName(name),
    nameNative: null,
    age: ageOn(birthDate),
    sex: SEX_FROM_GENDER[gender ?? ''] ?? 'Other',
    mobile: '',
    email: null,
    address: null,
    abhaId: null,
    registrationStatus: 'Registered',
    createdAt: Date.now(),
  }
}

/** A search result: the minimum-necessary summary, so the mobile is its last four digits only. It has
 *  no registration time, so it is never shown as registered today. */
export function fromSummary(s: PatientSummary): Patient {
  return { ...base(s.id, s.mrn, s.name, s.birthDate, s.gender), mobile: s.phoneLast4 ? `•••• ${s.phoneLast4}` : '', createdAt: 0 }
}

/** The full record (`GET /patients/{id}`, `POST /patients`). */
export function fromPatient(p: ApiPatient): Patient {
  const address = p.address ? [...p.address.lines, p.address.city, `${p.address.state} ${p.address.postalCode}`].filter(Boolean).join(', ') : null
  return {
    ...base(p.id, p.mrn, p.name, p.birthDate, p.gender),
    mobile: fromE164(p.phones?.[0]?.number),
    email: p.emails?.[0]?.address ?? null,
    address,
    createdAt: p.createdAt ? Date.parse(p.createdAt) : Date.now(),
  }
}

/** Puts API patients into the store, replacing older copies with the same id. A full record is never
 *  overwritten by a summary (which has only the last four digits of the mobile). */
function reconcile(incoming: Patient[], full: boolean): void {
  if (incoming.length === 0) return
  setState((state) => {
    const byId = new Map(state.patients.map((p) => [p.patientId, p]))
    for (const patient of incoming) {
      const existing = byId.get(patient.patientId)
      if (existing && !full) byId.set(patient.patientId, { ...patient, mobile: existing.mobile || patient.mobile, email: existing.email, address: existing.address, createdAt: existing.createdAt })
      else byId.set(patient.patientId, patient)
    }
    return { ...state, patients: [...byId.values()] }
  })
}

// ---- Search ----------------------------------------------------------------------------------

export type SearchPlan = { criteria: PatientSearchRequestCriteria } | { needMore: string }

/**
 * What the app bar's one search box can ask the API (SHRI_HEALTH API_STANDARDS §14.3: an exact
 * identifier, or at least two of last name, first name and date of birth). A 10-digit mobile or
 * an MRN is exact; a name needs both first and last names.
 */
export function planSearch(query: string): SearchPlan {
  const q = query.trim()
  const digits = q.replace(/\D/g, '')
  if (digits.length >= 10 && /^[+\d\s()-]+$/.test(q)) return { criteria: { phone: toE164(digits) } }
  if (/\d/.test(q) && /^[A-Za-z0-9-]+$/.test(q)) return { criteria: { mrn: q.toUpperCase() } }
  const words = q.split(/\s+/).filter((w) => w.length > 0)
  if (words.length >= 2 && words[words.length - 1]!.length >= 2) {
    return { criteria: { given: words[0]!, family: words[words.length - 1]! } }
  }
  return { needMore: 'Type the first and last name, a 10-digit mobile, or the MRN.' }
}

/** Searches the API and puts the matches in the store. Returns them, best first as the API orders them. */
export async function searchPatientsOnServer(criteria: PatientSearchRequestCriteria, signal?: AbortSignal): Promise<Patient[]> {
  const res = await apiSearchPatients({ criteria, limit: 8 }, signal ? { signal } : undefined)
  const found = res.status === 200 ? res.data.items.map(fromSummary) : []
  reconcile(found, false)
  return found
}

// ---- Registration ----------------------------------------------------------------------------

export interface RegisterOnServerInput {
  firstName: string
  lastName: string
  birthDate: string
  sex: Sex
  mobile: string
  /** Register although the server found a possible duplicate (`409 possible-duplicate`), with the reason. */
  overrideReason?: string
}

export function toPatientCreate(input: RegisterOnServerInput): PatientCreate {
  const body: PatientCreate = {
    name: { family: input.lastName.trim(), given: [input.firstName.trim()] },
    birthDate: input.birthDate,
    gender: GENDER_FROM_SEX[input.sex],
    phones: [{ number: toE164(input.mobile), use: 'mobile' }],
  }
  if (input.overrideReason) {
    body.duplicateCheck = 'override'
    body.duplicateOverrideReason = input.overrideReason
  }
  return body
}

/**
 * Registers the patient on the server; the server issues the MRN (shown as the UHID). `key` is the
 * Idempotency-Key for this one attempt: reuse it only to retry the very same request.
 */
export async function registerPatientOnServer(input: RegisterOnServerInput, key: string = newIdempotencyKey()): Promise<Patient> {
  const res = await apiRegisterPatient(toPatientCreate(input), { 'Idempotency-Key': key })
  if (res.status !== 201) throw new Error('Registration did not complete')
  const patient = fromPatient(res.data)
  reconcile([patient], true)
  return patient
}

/** The patients a `409 possible-duplicate` names (`candidateIds`), as summaries (D54), in the store too. */
export async function loadCandidates(ids: string[]): Promise<Patient[]> {
  if (ids.length === 0) return []
  const res = await apiGetPatientSummaries({ patientIds: ids.slice(0, 50) })
  const found = res.status === 200 ? res.data.items.map(fromSummary) : []
  reconcile(found, false)
  return found
}

// ---- The patient's record --------------------------------------------------------------------

/** Reads the patient by API id and puts the full record in the store. */
export async function loadPatient(patientId: string): Promise<Patient> {
  const res = await apiGetPatient(patientId)
  if (res.status !== 200) throw new Error('The patient could not be read')
  const patient = fromPatient(res.data)
  reconcile([patient], true)
  return patient
}

/** API patient ids are UUIDs; Care Entry's seed patients use their UHID. */
export function isApiPatientId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

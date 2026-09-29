/**
 * Admission — the doctor decides, the system does the rest.
 *
 * The doctor's part is one button, one small modal and one confirmation. What
 * follows — the front desk's queue, bed allocation, the move into the
 * inpatient list — is the hospital's work, and none of it is asked of the
 * doctor or drawn on their screens. They see one thing: where the admission
 * has got to.
 *
 * Three states and no more:
 *   not admitted          → no chip; the Admit button is the signal
 *   admission in progress → waiting for a bed, then a bed allocated
 *   admitted              → an inpatient, in the Inpatients list
 *
 * One record per patient, keyed by patient id, so a patient cannot be admitted
 * twice and the same patient continues from OPD into Inpatients — the record
 * is not copied, only its place changes.
 *
 * Everything here is pure. The records live in `store/admissions.ts`; the
 * boundary the screens call is `api/admissions.ts`.
 */

import { CLINIC_LIST, INPATIENTS } from './clinical'
import type { ClinicRow, WorklistRow } from './clinical'
import { NOW } from './format'
import { PATIENTS } from './kit'
import type { Patient } from './kit'

/** VOCABULARY.md — Ward and ICU are the two parts of Inpatients a doctor admits to. */
export type AdmissionType = 'ward' | 'icu'
export type AdmissionPriority = 'critical' | 'urgent' | 'routine'
export type AdmissionState = 'not-admitted' | 'in-progress' | 'admitted'

export interface Admission {
  id: string
  patientId: string
  /** The encounter the admission was ordered from, where there is one. */
  encounterId?: string
  type: AdmissionType
  priority: AdmissionPriority
  note?: string
  requestedBy: string
  requestedById: string
  /** Real epoch ms. The front office works on the wall clock, not the demo's frozen moment. */
  requestedAt: number
  /** Set by bed allocation. */
  bed?: string
  bedAt?: number
  /** Set when the front office completes the admission. */
  admittedAt?: number
}

// ─────────────────────────────────────────────── POST /admissions/create

/** The request body of `POST /admissions/create`. */
export interface CreateAdmissionRequest {
  patientId: string
  encounterId?: string
  type: AdmissionType
  priority: AdmissionPriority
  note?: string
  requestedBy: { id: string; name: string }
}

/**
 * The response. `created` is false where the patient already had an
 * admission — the call is idempotent per patient, so a double press never
 * makes a second one.
 */
export interface CreateAdmissionResponse {
  admission: Admission
  created: boolean
}

export const ADMISSIONS_ENDPOINT = 'POST /admissions/create'

// ───────────────────────────────────────────────────────────── Labels

export const TYPE_LABEL: Record<AdmissionType, string> = { ward: 'Ward', icu: 'ICU' }

export const PRIORITY_LABEL: Record<AdmissionPriority, string> = {
  critical: 'Critical',
  urgent: 'Urgent',
  routine: 'Routine',
}

/** Chip tones — a critical admission is red, like every other critical thing on the screen. */
export const PRIORITY_TONE: Record<AdmissionPriority, 'critical' | 'caution' | 'neutral'> = {
  critical: 'critical',
  urgent: 'caution',
  routine: 'neutral',
}

const PRIORITY_ORDER: Record<AdmissionPriority, number> = { critical: 0, urgent: 1, routine: 2 }

/** Where an admission has got to, in the words on its chip. */
export function stageLabel(a: Admission): string {
  if (a.admittedAt !== undefined) return a.bed ? `Admitted · ${a.bed}` : 'Admitted'
  return a.bed ? `Bed ${a.bed} allocated` : 'Waiting for bed'
}

// ───────────────────────────────────────────────────────────── State

export type Admissions = Record<string, Admission>

/** Only an admission ordered here has a state to show; the seeded inpatients' beds already say where they are. */
export function admissionState(patientId: string, admissions: Admissions): AdmissionState {
  const a = admissions[patientId]
  if (!a) return 'not-admitted'
  return a.admittedAt !== undefined ? 'admitted' : 'in-progress'
}

/** Admit is offered to a patient who is not already in, or on the way into, a bed. */
export function canAdmit(p: Patient, admissions: Admissions): boolean {
  return !admissions[p.id] && p.bed === null && !INPATIENTS.some((r) => r.patientId === p.id)
}

// ───────────────────────────────────────────────────────────── Lists

/**
 * The Inpatients list: the seeded inpatients, plus everyone admitted here.
 * My Day's Inpatients count and the Inpatients screen both read this, so they
 * cannot disagree.
 */
export function inpatientRows(admissions: Admissions): WorklistRow[] {
  const added = Object.values(admissions)
    .filter((a) => a.admittedAt !== undefined && !INPATIENTS.some((r) => r.patientId === a.patientId))
    .sort((a, b) => (b.admittedAt ?? 0) - (a.admittedAt ?? 0))
    .map<WorklistRow>((a) => ({
      patientId: a.patientId,
      bed: a.bed ?? null,
      reason: `Admitted today · ${TYPE_LABEL[a.type]}`,
      pending: ['Admission assessment'],
      chronologicalAt: NOW,
    }))
  return [...INPATIENTS, ...added]
}

/** Whether an Inpatients row came from an admission ordered here. */
export function isAdmittedHere(patientId: string, admissions: Admissions): boolean {
  return admissions[patientId]?.admittedAt !== undefined && !INPATIENTS.some((r) => r.patientId === patientId)
}

/**
 * Today's OPD: the clinic list, less anyone in a bed — a seeded inpatient or
 * someone admitted here. OPD and Inpatients are a partition (VOCABULARY.md),
 * so a patient is on one list, never both. A patient whose admission is still
 * in progress is still in OPD — they move when they have a bed.
 */
export function opdRows(admissions: Admissions): ClinicRow[] {
  return CLINIC_LIST.filter(
    (r) => admissions[r.patientId]?.admittedAt === undefined && !INPATIENTS.some((i) => i.patientId === r.patientId),
  )
}

/** The front desk's queue: in progress, most urgent first, then oldest first. */
export function pendingAdmissions(admissions: Admissions): Admission[] {
  return Object.values(admissions)
    .filter((a) => a.admittedAt === undefined)
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.requestedAt - b.requestedAt)
}

// ───────────────────────────────────────────────────── Bed allocation

const BED_POOLS: Record<AdmissionType, string[]> = {
  icu: Array.from({ length: 6 }, (_, i) => `ICU-${i + 1}`),
  ward: Array.from({ length: 24 }, (_, i) => `4B-${String(i + 1).padStart(2, '0')}`),
}

/** Every bed already taken: the seeded inpatients, the patient kit and the admissions made here. */
export function occupiedBeds(admissions: Admissions): Set<string> {
  const taken = new Set<string>()
  for (const r of INPATIENTS) if (r.bed) taken.add(r.bed)
  for (const p of PATIENTS) if (p.bed) taken.add(p.bed)
  for (const a of Object.values(admissions)) if (a.bed) taken.add(a.bed)
  return taken
}

/** The first free bed of the kind asked for. `undefined` means none is free, and the admission waits. */
export function allocateBed(type: AdmissionType, occupied: Set<string>): string | undefined {
  return BED_POOLS[type].find((b) => !occupied.has(b))
}

// SHRI_HEALTH data layer for the patient record: past consultation notes and the patient's
// appointments, read once through Suspense; and `useProblemsFor`, the encounter's diagnoses
// (GET /encounters/{id}), read once through Suspense, then from the store.
import type { Patient } from '@/data/kit'
import { pastNotesFor as mockPastNotesFor, type PastNote } from '@/data/record'
import type { AddedProblem } from '@/store/clinical'

import { type RecordSection } from '../src/shri/logic/record'
import { appointmentsOf as mockAppointmentsOf, isActive, nextOf as mockNextOf, type ShriAppointment, type ShriStatus } from '../src/shri/logic/schedule'

import { useClinical } from './clinical'
import { encounterOfToday } from './opd'
import { clinicDate, clinicNow } from './format'
import { read } from './resource'
import { getNote, listEncounterNotes, listPatientEncounters } from '../../src/api/generated/endpoints/encounters/encounters'
import { listAppointments } from '../../src/api/generated/endpoints/scheduling/scheduling'
import type { AppointmentSummary } from '../../src/api/generated/model'

const NONE: AddedProblem[] = []

/** The encounter's diagnoses (the screen passed the patient; diagnoses belong to the visit). */
export function useProblemsFor(encounterId: string): AddedProblem[] {
  read(`diagnoses:${encounterId}`, () => useClinical.getState().loadDiagnoses(encounterId))
  return useClinical((s) => s.diagnoses[encounterId]) ?? NONE
}

/**
 * The record's address with the patient's opaque ID. The mock's recordPath put the UHID in the
 * URL; with real data that is the MRN, which D13 keeps out of every URL.
 * TODO: the record screens are not connected yet, so these open their "not found" state.
 */
export function recordPath(p: Pick<Patient, 'id'>, section: RecordSection): string {
  return section === 'record' ? `/patient/${p.id}` : `/patient/${p.id}/${section}`
}

/** "Start consultation": the note of the patient's visit today, from the status board. */
export function consultPath(p: Pick<Patient, 'id'>): string | undefined {
  const encounterId = encounterOfToday(p.id)
  return encounterId ? `/encounter/${encounterId}/note` : undefined
}

// ---- Past consultation notes -----------------------------------------------------------------
// `pastNotesFor` (src/data/record.ts) over the patient's encounters (GET /patients/{id}/encounters),
// each one's notes (GET /encounters/{id}/notes) and every signed one in full (GET /notes/{id}).
// Field mapping, PastNote ⇐ Note: at ⇐ signedAt; by ⇐ signedBy (or author); kind ⇐ Consultation;
// setting ⇐ the encounter's type; subjective, objective, assessment, plan ⇐ the sections whose
// LOINC codes are 61150-9, 61149-1, 51848-0 and 18776-5. Drafts and entered-in-error notes are left out.

const SOAP: Record<string, 'subjective' | 'objective' | 'assessment' | 'plan'> = {
  '61150-9': 'subjective',
  '61149-1': 'objective',
  '51848-0': 'assessment',
  '18776-5': 'plan',
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function loadPastNotes(patientId: string): Promise<PastNote[]> {
  const encounters = await listPatientEncounters(patientId, { limit: 50 })
  const items = encounters.status === 200 ? encounters.data.items : []
  const notes: PastNote[] = []
  for (const enc of items) {
    const list = await listEncounterNotes(enc.id, { limit: 50 })
    const signed = list.status === 200 ? list.data.items.filter((n) => n.status === 'final' || n.status === 'amended') : []
    for (const summary of signed) {
      const full = await getNote(summary.id)
      if (full.status !== 200) continue
      const n = full.data
      const text = { subjective: '', objective: '', assessment: '', plan: '' }
      for (const s of n.sections) if (SOAP[s.code]) text[SOAP[s.code]] = s.text
      notes.push({
        id: n.id,
        patientId,
        at: clinicDate(n.signedAt ?? n.updatedAt),
        by: (n.signedBy ?? n.author).displayName,
        kind: 'Consultation',
        setting: enc.types?.[0]?.text ?? enc.types?.[0]?.codings?.[0]?.display ?? n.title,
        ...text,
      })
    }
  }
  return notes.sort((a, b) => b.at.getTime() - a.at.getTime())
}

/** A patient's signed notes, newest first: the API's for an API patient, the mock's otherwise. */
export function pastNotesFor(patientId: string): PastNote[] {
  if (!UUID_RE.test(patientId)) return mockPastNotesFor(patientId)
  return read(`pastnotes:${patientId}`, () => loadPastNotes(patientId))
}

// ---- A patient's appointments ----------------------------------------------------------------
// `appointmentsOf` and `nextOf` (src/shri/logic/schedule.ts) for an API patient: their bookings about
// three months back and three ahead (GET /appointments?patientId=…, 31-day windows, D62). Field mapping, ShriAppointment
// ⇐ AppointmentSummary: at ⇐ startAt; kind ⇐ Teleconsult for a telehealth type, Follow-up for a
// follow-up type, else Review; status ⇐ booked or arrived → Booked (Today on today's date),
// checked-in → Today, fulfilled → Completed, noshow → Missed, cancelled → Cancelled; clinic ⇐ the
// appointment type's name; with ⇐ the provider; purpose ⇐ the reason for the visit, else the type.
// "What to bring" (prepare) and the room have no place in the summary.

/** A Date's own calendar day (a clinic-time Date gives the clinic's day). */
const ISO_DAY = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function statusOf(a: AppointmentSummary): ShriStatus {
  const today = ISO_DAY(clinicNow()) === ISO_DAY(clinicDate(a.startAt))
  if (a.status === 'fulfilled') return 'Completed'
  if (a.status === 'noshow') return 'Missed'
  if (a.status === 'cancelled') return 'Cancelled'
  if (a.status === 'checked-in') return 'Today'
  return today ? 'Today' : 'Booked'
}

function fromAppointment(a: AppointmentSummary): ShriAppointment {
  const type = a.appointmentType.name
  return {
    id: a.id,
    patientId: a.patient.id,
    at: clinicDate(a.startAt),
    kind: /tele/i.test(type) ? 'Teleconsult' : /follow/i.test(type) ? 'Follow-up' : 'Review',
    status: statusOf(a),
    clinic: type,
    with: a.provider.displayName,
    purpose: a.reasonForVisit ?? type,
  }
}

async function loadAppointmentsOf(patientId: string): Promise<ShriAppointment[]> {
  // A range is at most 31 days (D62): six windows, about three months back and three ahead.
  const start = clinicNow()
  start.setDate(start.getDate() - 93)
  const windows = Array.from({ length: 6 }, (_, i) => {
    const from = new Date(start)
    from.setDate(from.getDate() + i * 31)
    const to = new Date(from)
    to.setDate(to.getDate() + 30)
    return { from: ISO_DAY(from), to: ISO_DAY(to) }
  })
  const pages = await Promise.all(
    windows.map(async ({ from, to }) => {
      const items: AppointmentSummary[] = []
      let cursor: string | undefined
      do {
        const res = await listAppointments({ patientId, dateFrom: from, dateTo: to, limit: 100, ...(cursor ? { cursor } : {}) })
        if (res.status !== 200) break
        items.push(...res.data.items)
        cursor = res.data.nextCursor
      } while (cursor && items.length < 300)
      return items
    }),
  )
  return pages.flat().map(fromAppointment).sort((x, y) => x.at.getTime() - y.at.getTime())
}

/** Oldest first: the API's bookings for an API patient, the book's otherwise. */
export function appointmentsOf(book: ShriAppointment[], patientId: string): ShriAppointment[] {
  if (!UUID_RE.test(patientId)) return mockAppointmentsOf(book, patientId)
  return read(`appointments:${patientId}`, () => loadAppointmentsOf(patientId))
}

/** The next thing the patient is booked for: today's first, then the future. */
export function nextOf(book: ShriAppointment[], patientId: string): ShriAppointment | undefined {
  if (!UUID_RE.test(patientId)) return mockNextOf(book, patientId)
  const start = clinicNow()
  start.setHours(0, 0, 0, 0)
  return appointmentsOf(book, patientId).find((a) => isActive(a) && a.at.getTime() >= start.getTime())
}

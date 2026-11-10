// ported from src/screens/m06/record/shared.tsx:31-102 and 158-170 (the parts,
// their counts, the default sub-line) and S0611.tsx:33-43 (where the note
// action goes, and what it is called): what the seven patient-record screens
// (S-06-11 … S-06-17) share. Every part is one tap from every other, and
// Overview is always the way back to the one-page record — here at
// `/patient/:id`, the others at the old build's `/patient/:id/<part>`.

import { RESULT_TRENDS, encounterForPatient, problemsFor, resultsFor, type Problem, type ResultRow } from '@/data/clinical'
import { formatDate, formatTime } from '@/data/format'
import type { Patient } from '@/data/kit'
import { activeMedicines, conditionFor, pastNotesFor, reportsFor, type ConditionStatus } from '@/data/record'
import { useClinical, type AddedProblem, type VoiceNote } from '@/store/clinical'

import type { Tone } from '../mocks/types'

import { appointmentsOf, nextOf, useAppointments } from './schedule'

export type RecordSection = 'record' | 'condition' | 'results' | 'reports' | 'notes' | 'prescriptions' | 'appointments'

/** `label` titles a tile; `short` names the tab. Seven tabs; the row scrolls sideways where they do not fit. */
export const SECTION_META: Record<RecordSection, { label: string; short: string; path: string; screenId: string }> = {
  record: { label: 'Overview', short: 'Overview', path: 'record', screenId: 'S-06-11' },
  condition: { label: 'Current condition', short: 'Condition', path: 'condition', screenId: 'S-06-15' },
  results: { label: 'Test results', short: 'Test results', path: 'results', screenId: 'S-06-13' },
  reports: { label: 'Imaging reports', short: 'Imaging reports', path: 'reports', screenId: 'S-06-12' },
  notes: { label: 'Consultation notes', short: 'Consultation notes', path: 'notes', screenId: 'S-06-14' },
  prescriptions: { label: 'Prescriptions', short: 'Prescriptions', path: 'prescriptions', screenId: 'S-06-16' },
  appointments: { label: 'Appointments', short: 'Appointments', path: 'appointments', screenId: 'S-06-17' },
}

export const SECTION_ORDER: RecordSection[] = ['record', 'condition', 'results', 'reports', 'notes', 'prescriptions', 'appointments']

/** A condition's status in this build's tones — stable is the quiet one, the clinical hues for the rest (`STATUS_TONE`). */
export const STATUS_TONE: Record<ConditionStatus, Tone> = {
  Critical: 'crit',
  Deteriorating: 'warn',
  Stable: 'neu',
  Improving: 'norm',
  Recovered: 'norm',
}

/** The Overview is `/patient/:id`; every other part keeps the old address. */
export function recordPath(p: Patient, section: RecordSection): string {
  return section === 'record' ? `/patient/${p.uhid}` : `/patient/${p.uhid}/${SECTION_META[section].path}`
}

/** The patient's dictated notes, newest first. */
export function useVoiceNotesFor(patientId: string): VoiceNote[] {
  const voiceNotes = useClinical((s) => s.voiceNotes)
  return (voiceNotes[patientId] ?? []).slice().sort((a, b) => b.at.localeCompare(a.at))
}

/** Notes written on this patient's encounters in this session, signed or draft. */
export function useSessionNotesFor(patientId: string) {
  const notes = useClinical((s) => s.notes)
  const enc = encounterForPatient(patientId)
  const record = enc ? notes[enc.id] : undefined
  const hasText = record && Object.values(record.text).some((t) => t.trim() !== '')
  return enc && record && hasText ? [{ encounter: enc, record }] : []
}

/** The patient's problem list: the seeded one, then anything added this session. */
export function useProblemsFor(patientId: string): (Problem | AddedProblem)[] {
  const added = useClinical((s) => s.addedProblems[patientId])
  return [...problemsFor(patientId), ...(added ?? [])]
}

/** One count per part, for the tabs. */
export function useSectionCounts(p: Patient): Record<Exclude<RecordSection, 'record'>, number> {
  const book = useAppointments()
  const voice = useVoiceNotesFor(p.id)
  const session = useSessionNotesFor(p.id)
  const problems = useProblemsFor(p.id)
  return {
    condition: problems.length,
    results: resultsFor(p.id).length,
    reports: reportsFor(p.id).length,
    notes: pastNotesFor(p.id).length + voice.length + session.length,
    prescriptions: activeMedicines(p.id).length,
    appointments: appointmentsOf(book, p.id).length,
  }
}

/** The quiet line under the heading: age/sex, the condition in a line, and the next appointment — from the live book, so a move shows here too. */
export function useDefaultSubheading(p: Patient): string {
  const next = nextOf(useAppointments(), p.id)
  const condition = conditionFor(p.id)
  const bits = [`${p.age}/${p.sex}`, condition?.headline ?? p.scenario]
  if (next) bits.push(`next: ${next.purpose.toLowerCase()} ${formatDate(next.at)} ${formatTime(next.at)}`)
  return bits.join(' · ')
}

/** Where "start the consultation" goes, by the kind of encounter the patient has. */
export function consultPath(p: Patient): string | undefined {
  const enc = encounterForPatient(p.id)
  if (!enc) return undefined
  return enc.type === 'IP' ? `/ip/encounter/${enc.id}/note` : `/encounter/${enc.id}/note`
}

/** The one label for starting the note, wherever it is offered. */
export function noteActionLabel(p: Patient): string {
  return encounterForPatient(p.id)?.type === 'IP' ? 'Write progress note' : 'Start consultation'
}

/**
 * The results the Overview's trend offers, most pressing first: one waiting for
 * review, then one out of range, then the newest (`resultsFor` is newest first
 * and the sort is stable) — up to three (`src/screens/m06/record/TrendCard.tsx:24-31`).
 */
export function useTrendSeries(p: Patient): ResultRow[] {
  const acknowledgements = useClinical((s) => s.acknowledgements)
  const toReview = (r: ResultRow) => !r.acknowledged && acknowledgements[r.id] === undefined
  return resultsFor(p.id)
    .filter((r) => (RESULT_TRENDS[r.id]?.length ?? 0) > 1)
    .sort((a, b) => Number(toReview(b)) - Number(toReview(a)) || Number(b.flag !== 'Normal') - Number(a.flag !== 'Normal'))
    .slice(0, 3)
}

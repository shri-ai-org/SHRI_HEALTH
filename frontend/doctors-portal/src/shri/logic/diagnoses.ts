/**
 * Every coded diagnosis a patient has, from wherever it was coded, as one
 * list: the problem list (seeded and added), a signed note's code, the
 * admission's provisional diagnosis, the discharge's final diagnosis and the
 * death certificate's causes. The cohort filters read this, so a patient coded
 * I63 anywhere in the record is found under I63 — and each code says where it
 * came from.
 */

import { useMemo } from 'react'

import type { Admissions } from '@/data/admissions'
import { problemsFor } from '@/data/clinical'
import { icdLabel, normaliseIcd } from '@/data/icd10'
import { PATIENTS } from '@/data/kit'
import { useAdmissions } from '@/store/admissions'
import { useClinical, type AddedProblem, type DeathRecord, type DischargeRecord, type NoteRecord } from '@/store/clinical'

import { maybeEncounter } from './encounter'

export type DiagnosisSource = 'problem' | 'note' | 'admission' | 'discharge' | 'death'

export const SOURCE_LABEL: Record<DiagnosisSource, string> = {
  problem: 'Problem list',
  note: 'Signed note',
  admission: 'Admission',
  discharge: 'Discharge',
  death: 'Death certificate',
}

export interface CodedDiagnosis {
  code: string
  label: string
  source: DiagnosisSource
  /** Problems only: still open, or resolved. Every other source counts as open. */
  open: boolean
}

interface Sources {
  addedProblems: Record<string, AddedProblem[]>
  notes: Record<string, NoteRecord>
  admissions: Admissions
  discharges: Record<string, DischargeRecord>
  deaths: Record<string, DeathRecord>
}

/** Each patient's coded diagnoses; a code from several sources appears once per source. */
export function diagnosesByPatient(s: Sources): Record<string, CodedDiagnosis[]> {
  const out: Record<string, CodedDiagnosis[]> = Object.fromEntries(PATIENTS.map((p) => [p.id, []]))
  const add = (patientId: string, d: CodedDiagnosis) => {
    const list = (out[patientId] ??= [])
    const code = normaliseIcd(d.code)
    if (!list.some((x) => x.code === code && x.source === d.source)) list.push({ ...d, code })
  }
  for (const p of PATIENTS) {
    for (const pr of [...problemsFor(p.id), ...(s.addedProblems[p.id] ?? [])]) add(p.id, { code: pr.icd10, label: pr.label, source: 'problem', open: pr.status === 'Open' })
  }
  for (const note of Object.values(s.notes)) {
    if (!note.code || note.status !== 'signed') continue
    const enc = maybeEncounter(note.encounterId)
    if (enc) add(enc.patientId, { code: note.code, label: icdLabel(note.code), source: 'note', open: true })
  }
  for (const a of Object.values(s.admissions)) if (a.diagnosis) add(a.patientId, { ...a.diagnosis, source: 'admission', open: true })
  for (const d of Object.values(s.discharges)) for (const c of d.diagnoses ?? []) add(d.patientId, { ...c, source: 'discharge', open: true })
  for (const d of Object.values(s.deaths)) {
    const codes = d.codes
    for (const c of [codes?.a, codes?.b, codes?.c, ...(codes?.contributing ?? [])]) if (c) add(d.patientId, { ...c, source: 'death', open: true })
  }
  return out
}

/** The live index — it follows every store a diagnosis is coded in. */
export function useDiagnosesByPatient(): Record<string, CodedDiagnosis[]> {
  const addedProblems = useClinical((s) => s.addedProblems)
  const notes = useClinical((s) => s.notes)
  const discharges = useClinical((s) => s.discharges)
  const deaths = useClinical((s) => s.deaths)
  const admissions = useAdmissions((s) => s.admissions)
  return useMemo(() => diagnosesByPatient({ addedProblems, notes, admissions, discharges, deaths }), [addedProblems, notes, admissions, discharges, deaths])
}

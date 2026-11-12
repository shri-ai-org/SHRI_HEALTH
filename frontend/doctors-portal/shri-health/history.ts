// SHRI_HEALTH data layer: the patient's problem list (#280, Vimal's note on #85), for the record's
// "Current condition" page (S-06-15, src/shri/record/ConditionPage.tsx) and its tab count.
//   problems   ⇐ listProblems(patientId, { limit, cursor }): newest first; entered-in-error left out
//                (no includeEnteredInError). A restricted chart answers 403 break-glass-required,
//                which goes to the route's sealed card (RouteBoundary); a role without the read
//                (the front desk) answers 403 permission-denied, which the page says in words.
// The History tab (below) reads the past problems and the surgical, family and social history.
// TODO(gap): getProblem (one problem with its ETag) has no detail screen. Writes come after the demo.
import { ApiError } from '../../src/api/client'
import { listFamilyHistory, listProblems, listSocialHistory, listSurgicalHistory } from '../../src/api/generated/endpoints/history/history'
import type { CodeableConcept, FamilyHistory, Problem2, SocialHistory, SurgicalHistory } from '../../src/api/generated/model'
import type { Problem } from '@/data/clinical'
import { read } from './resource'

const ICD10 = 'http://hl7.org/fhir/sid/icd-10-cm'
const SNOMED = 'http://snomed.info/sct'
const PAGE = 100
/** Pages read at most (500 problems): a list longer than that is not one a screen can show. */
const MAX_PAGES = 5
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface PatientProblems {
  problems: Problem[]
  /** The role may not read the problem list (403 permission-denied). */
  denied: boolean
}

/** A partial date as it was recorded, in U.S. style: "2019", "Mar 2019" or "Mar 4, 2019". */
function partialDate(d?: string): string {
  if (!d) return 'unknown'
  const [y, m, day] = d.split('-')
  if (!m) return y
  const month = MONTHS[Number(m) - 1] ?? m
  return day ? `${month} ${Number(day)}, ${y}` : `${month} ${y}`
}

function toProblem(p: Problem2): Problem {
  const codings = p.code.codings ?? []
  const status = p.clinicalStatus ?? 'active'
  return {
    id: p.id,
    patientId: p.patientId,
    label: p.code.text ?? codings[0]?.display ?? 'Problem',
    icd10: codings.find((c) => c.system === ICD10)?.code ?? '',
    snomed: codings.find((c) => c.system === SNOMED)?.code ?? '',
    onset: partialDate(p.onsetDate),
    status: status === 'active' || status === 'recurrence' || status === 'relapse' ? 'Open' : 'Resolved',
    leaf: true,
  }
}

async function load(patientId: string): Promise<PatientProblems> {
  const problems: Problem[] = []
  let cursor: string | undefined
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await listProblems(patientId, { limit: PAGE, ...(cursor ? { cursor } : {}) })
      if (res.status !== 200) throw new Error('The problem list could not be read')
      problems.push(...res.data.items.map(toProblem))
      cursor = res.data.nextCursor
      if (!cursor) break
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 403 && e.code === 'permission-denied') return { problems: [], denied: true }
    throw e
  }
  return { problems, denied: false }
}

/** The patient's problem list from the API (suspends until it is read). */
export function usePatientProblems(patientId: string): PatientProblems {
  return read(`problems:${patientId}`, () => load(patientId))
}

// ---- The record's History tab (S-06-20, gap 86, Vimal on #85; Minalini's D115 exception) ----
//   past problems    ⇐ listProblems: only the resolved, inactive and in-remission ones (the active
//                      list is the Current condition page's)
//   surgical history ⇐ listSurgicalHistory
//   family history   ⇐ listFamilyHistory
//   social history   ⇐ listSocialHistory
// Each list: limit and cursor, newest first, entered-in-error left out (no includeEnteredInError).
// A role without the read gets its own "can't read" line per list; break-glass-required goes to the
// route's sealed "Restricted chart" card. Read only: editing comes after the demo.

export interface HistoryRow {
  id: string
  title: string
  detail: string
}

export interface HistoryList {
  rows: HistoryRow[]
  /** The role may not read this list (403 permission-denied). */
  denied: boolean
}

export interface PatientHistory {
  pastProblems: HistoryList
  surgical: HistoryList
  family: HistoryList
  social: HistoryList
}


/** Every page of one list (up to MAX_PAGES), or `denied` on 403 permission-denied. */
async function allPages<T>(fetchPage: (cursor?: string) => Promise<{ status: number; data: unknown }>, toRow: (item: T) => HistoryRow | null): Promise<HistoryList> {
  const rows: HistoryRow[] = []
  let cursor: string | undefined
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetchPage(cursor)
      if (res.status !== 200) throw new Error('The history could not be read')
      const data = res.data as { items: T[]; nextCursor?: string }
      for (const item of data.items) {
        const row = toRow(item)
        if (row) rows.push(row)
      }
      cursor = data.nextCursor
      if (!cursor) break
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 403 && e.code === 'permission-denied') return { rows: [], denied: true }
    throw e
  }
  return { rows, denied: false }
}

const textOf = (c?: CodeableConcept) => c?.text ?? c?.codings?.[0]?.display ?? ''
const join = (parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' · ')

function pastProblem(p: Problem2): HistoryRow | null {
  if (!p.clinicalStatus || p.clinicalStatus === 'active' || p.clinicalStatus === 'recurrence' || p.clinicalStatus === 'relapse') return null
  const icd = p.code.codings?.find((c) => c.system === ICD10)?.code
  const status = p.clinicalStatus === 'remission' ? 'in remission' : p.clinicalStatus
  return {
    id: p.id,
    title: textOf(p.code) || 'Problem',
    detail: join([icd && `ICD-10 ${icd}`, p.onsetDate && `since ${partialDate(p.onsetDate)}`, p.abatementDate ? `${status} ${partialDate(p.abatementDate)}` : status]),
  }
}

function surgery(s: SurgicalHistory): HistoryRow {
  return { id: s.id, title: textOf(s.code) || 'Procedure', detail: join([partialDate(s.performedDate), textOf(s.bodySite), s.note]) }
}

function relative(f: FamilyHistory): HistoryRow {
  const conditions = (f.conditions ?? []).map((c) => join([textOf(c.code), c.onsetAge !== undefined && `at ${c.onsetAge}`])).join('; ')
  return { id: f.id, title: textOf(f.relationship) || 'Relative', detail: join([conditions || (f.status === 'health-unknown' ? 'Health unknown' : 'No conditions recorded'), f.deceased && 'deceased', f.note]) }
}

function socialItem(s: SocialHistory): HistoryRow {
  const v = s.value
  const value = textOf(v.codeableConcept) || (v.quantity ? `${v.quantity.value}${v.quantity.unit ? ` ${v.quantity.unit}` : ''}` : '') || v.text || ''
  return { id: s.id, title: textOf(s.code) || 'Social history', detail: join([value, s.effectiveDate && `as of ${partialDate(s.effectiveDate)}`]) }
}

async function loadHistory(patientId: string): Promise<PatientHistory> {
  const [pastProblems, surgical, family, social] = await Promise.all([
    allPages<Problem2>((cursor) => listProblems(patientId, { limit: PAGE, ...(cursor ? { cursor } : {}) }), pastProblem),
    allPages<SurgicalHistory>((cursor) => listSurgicalHistory(patientId, { limit: PAGE, ...(cursor ? { cursor } : {}) }), surgery),
    allPages<FamilyHistory>((cursor) => listFamilyHistory(patientId, { limit: PAGE, ...(cursor ? { cursor } : {}) }), relative),
    allPages<SocialHistory>((cursor) => listSocialHistory(patientId, { limit: PAGE, ...(cursor ? { cursor } : {}) }), socialItem),
  ])
  return { pastProblems, surgical, family, social }
}

/** The patient's history from the API (suspends until all four lists are read). */
export function usePatientHistory(patientId: string): PatientHistory {
  return read(`history:${patientId}`, () => loadHistory(patientId))
}

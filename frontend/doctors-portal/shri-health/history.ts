// SHRI_HEALTH data layer: the patient's problem list (#280, Vimal's note on #85), for the record's
// "Current condition" page (S-06-15, src/shri/record/ConditionPage.tsx) and its tab count.
//   problems   ⇐ listProblems(patientId, { limit, cursor }): newest first; entered-in-error left out
//                (no includeEnteredInError). A restricted chart answers 403 break-glass-required,
//                which goes to the route's sealed card (RouteBoundary); a role without the read
//                (the front desk) answers 403 permission-denied, which the page says in words.
// TODO(gap): family, social and surgical history (listFamilyHistory, listSocialHistory,
// listSurgicalHistory) have no screen in this portal; getProblem (one problem with its ETag) has no
// detail screen either. Writes come after the demo.
import { ApiError } from '../../src/api/client'
import { listProblems } from '../../src/api/generated/endpoints/history/history'
import type { Problem2 } from '../../src/api/generated/model'
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

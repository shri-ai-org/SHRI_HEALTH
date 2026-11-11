// SHRI_HEALTH data layer: care-entry's selectors (src/domain/selectors.ts), with patient search over
// POST /patients/search. The screen reads its selectors synchronously from the store; this search
// returns what the store holds for the query and asks the server once per query, whose matches the
// store then receives (shri-health/patients.ts), so the screen redraws with them. Only patients
// from the server are offered: the sample patients never appear.
import type { PatientSearchMatch } from '../src/types/patient'
import type { AppState } from '../src/types/store'
import {
  getPatientSearchSuggestions as sampleSuggestions,
  searchPatients as sampleSearch,
  type PatientSearchSuggestions,
} from '../src/domain/selectors'

import { setState } from '../src/domain/store'
import { problemMessage } from './client'
import { isApiPatientId, planSearch, searchPatientsOnServer } from './patients'

export * from '../src/domain/selectors'

let asked = ''
let timer: number | undefined
/** The server's matches for the last query, by ID: a phone match can't be found again in the store,
 *  whose search results carry only the last four digits (D54). */
let matched: { query: string; ids: string[] } = { query: '', ids: [] }
/** The last query the server refused or never answered, with why: never shown as "no patient found". */
let failed: { query: string; message: string } = { query: '', message: '' }

function askServer(query: string): void {
  const q = query.trim()
  if (q === asked) return
  asked = q
  window.clearTimeout(timer)
  const plan = planSearch(q)
  // TODO(gap): a query the contract can't search on (one word, under two letters) asks nothing.
  if (!('criteria' in plan)) return
  timer = window.setTimeout(
    () =>
      void searchPatientsOnServer(plan.criteria)
        .then((found) => {
          matched = { query: q, ids: found.map((p) => p.patientId) }
          failed = { query: '', message: '' }
          // Redraw: the store already holds the patients; the screen's search reads `matched` too.
          setState((state) => ({ ...state }))
        })
        .catch((err: unknown) => {
          failed = { query: q, message: problemMessage(err) }
          setState((state) => ({ ...state }))
        }),
    250,
  )
}

export function searchPatients(state: AppState, rawQuery: string): PatientSearchMatch[] {
  if (rawQuery.trim()) askServer(rawQuery)
  const local = sampleSearch(state, rawQuery).filter((m) => isApiPatientId(m.patient.patientId))
  if (matched.query !== rawQuery.trim()) return local
  // The server's other matches for this query (a phone search, say), in its order.
  const seen = new Set(local.map((m) => m.patient.patientId))
  const extra: PatientSearchMatch[] = matched.ids
    .filter((id) => !seen.has(id))
    .map((id) => state.patients.find((p) => p.patientId === id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((patient) => ({ patient, matchedOn: 'Mobile', tier: 4 }))
  return [...local, ...extra]
}

/** Why the server's search for this query failed, or null: the screen says so instead of "No patient found". */
export function searchFailure(_state: AppState, rawQuery: string): string | null {
  return failed.query && failed.query === rawQuery.trim() ? failed.message : null
}

/** Before anything is typed: only patients the server has returned this session (no sample data). */
export function getPatientSearchSuggestions(state: AppState): PatientSearchSuggestions {
  const s = sampleSuggestions(state)
  return { recent: s.recent.filter((p) => isApiPatientId(p.patientId)), mostOpened: s.mostOpened.filter((p) => isApiPatientId(p.patientId)) }
}

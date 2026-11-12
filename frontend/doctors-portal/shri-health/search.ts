// SHRI_HEALTH data layer: the patient search overlay (src/shri/overlays/PatientSearch.tsx) over
// POST /patients/search (D13: the query goes in the body, never the URL) and, before anything is
// typed, today's patients from the staff status board (no all-patients list, D65).
//
// What the one box can ask (API_STANDARDS §14.3): an exact identifier, or at least two of last
// name, first name and date of birth. So: an MRN, a 10-digit US phone, or a first and last name.
// Field mapping, the screen's Patient ⇐ PatientSummary: id ⇐ id, name ⇐ given + family,
// uhid ⇐ mrn (the practice's record number, D41), age ⇐ birthDate, sex ⇐ gender, bed ⇐ none.
import { useEffect, useState } from 'react'

import type { Patient, Payer } from '@/data/kit'

import { getPatientSummaries, searchPatients } from '../../src/api/generated/endpoints/patients/patients'
import type { PatientSearchRequestCriteria, PatientSummary } from '../../src/api/generated/model'

import { useBoard, userFacility } from './opd'
import { clinicNow } from './format'
import { listAppointments } from '../../src/api/generated/endpoints/scheduling/scheduling'

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The patients booked at the user's facility in the last 31 days, most recent first (one D62 window). */
async function recentPatientIds(): Promise<string[]> {
  const facility = await userFacility()
  if (!facility) return []
  const today = clinicNow()
  const from = new Date(today)
  from.setDate(from.getDate() - 30)
  const res = await listAppointments({ facilityId: facility.id, dateFrom: dayKey(from), dateTo: dayKey(today), limit: 100 })
  if (res.status !== 200) return []
  return [...new Set([...res.data.items].sort((a, b) => (a.startAt < b.startAt ? 1 : -1)).map((a) => a.patient.id))]
}

const DEBOUNCE_MS = 250

function ageOn(birthDate: string | undefined, on: Date): number {
  if (!birthDate) return 0
  const [y, m, d] = birthDate.split('-').map(Number)
  const age = on.getFullYear() - y
  return on.getMonth() + 1 < m || (on.getMonth() + 1 === m && on.getDate() < d) ? age - 1 : age
}

function fromSummary(s: PatientSummary): Patient {
  // The screen's shape, with what a summary carries; the rest stays empty (as shri-health/kit.ts).
  return {
    id: s.id,
    name: [...(s.name.given ?? []), s.name.family].filter(Boolean).join(' '),
    age: ageOn(s.birthDate, new Date()),
    sex: s.gender === 'male' ? 'M' : s.gender === 'female' ? 'F' : 'O',
    uhid: s.mrn,
    scenario: '',
    payer: 'None yet' as Payer,
    abha: null,
    abhaStatus: 'Not linked',
    allergies: [],
    bed: null,
    facilityCode: '',
  }
}

/** The search the typed text allows, or null when it is not enough yet. */
export function criteriaFor(query: string): PatientSearchRequestCriteria | null {
  const q = query.trim()
  const digits = q.replace(/\D/g, '')
  if (/^[+\d\s().-]+$/.test(q) && (digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) return { phone: `+1${digits.slice(-10)}` }
  if (/\d/.test(q) && /^[A-Za-z0-9-]+$/.test(q)) return { mrn: q.toUpperCase() }
  const words = q.split(/\s+/).filter(Boolean)
  if (words.length >= 2 && words[words.length - 1]!.length >= 2) return { given: words[0]!, family: words[words.length - 1]! }
  return null
}

/** Today's patients (from the status board), or the search's matches once enough is typed. */
export function usePatientMatches(query: string): Patient[] {
  const boardIds = useBoard((s) => [...new Set(s.items.map((i) => i.patient?.id).filter((id): id is string => Boolean(id)))].join(','))
  const [rows, setRows] = useState<Patient[]>([])

  useEffect(() => {
    let live = true
    const criteria = criteriaFor(query)
    const run = async (): Promise<Patient[]> => {
      if (query.trim() === '') {
        if (useBoard.getState().items.length === 0) await useBoard.getState().load().catch(() => undefined)
        // Today's board first, then the clinic's recent patients (booked in the last 31 days, D65).
        const ids = [...new Set([...(boardIds ? boardIds.split(',') : []), ...(await recentPatientIds().catch(() => []))])]
        if (ids.length === 0) return []
        const res = await getPatientSummaries({ patientIds: ids.slice(0, 8) })
        return res.status === 200 ? res.data.items.map(fromSummary) : []
      }
      if (!criteria) return []
      const res = await searchPatients({ criteria, limit: 8 })
      return res.status === 200 ? res.data.items.map(fromSummary) : []
    }
    const t = window.setTimeout(() => {
      run()
        .then((found) => live && setRows(found))
        .catch(() => live && setRows([]))
    }, query.trim() === '' ? 0 : DEBOUNCE_MS)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [query, boardIds])

  return rows
}

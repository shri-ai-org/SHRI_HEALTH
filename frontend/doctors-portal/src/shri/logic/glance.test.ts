import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../../../src/api/client'
import { listPatientEncounters, listPatientVitals } from '../../../../src/api/generated/endpoints/encounters/encounters'
import { listAllergies, listProblems } from '../../../../src/api/generated/endpoints/history/history'
import { listMedications } from '../../../../src/api/generated/endpoints/medications/medications'
import { listLabResults } from '../../../../src/api/generated/endpoints/orders/orders'
import type { Allergy, EncounterSummary, LabResult, Medication, Problem2, Vital } from '../../../../src/api/generated/model'
import { GLANCE_KEYS, loadGlance, type Glance, type GlanceKey } from './glance'

vi.mock('../../../../src/api/generated/endpoints/encounters/encounters', () => ({ listPatientEncounters: vi.fn(), listPatientVitals: vi.fn() }))
vi.mock('../../../../src/api/generated/endpoints/history/history', () => ({ listAllergies: vi.fn(), listProblems: vi.fn() }))
vi.mock('../../../../src/api/generated/endpoints/medications/medications', () => ({ listMedications: vi.fn() }))
vi.mock('../../../../src/api/generated/endpoints/orders/orders', () => ({ listLabResults: vi.fn() }))

// Synthetic records only.
const PATIENT = '5eed0017-0000-4000-8000-0000000000aa'
const concept = (text: string, code?: string) => ({ text, ...(code ? { codings: [{ system: 'http://snomed.info/sct', code, display: text }] } : {}) })
const base = { patientId: PATIENT, recordedAt: '2026-10-01T16:00:00Z' }

const problem = (name: string, clinicalStatus: Problem2['clinicalStatus']): Problem2 =>
  ({ ...base, id: name, code: concept(name), clinicalStatus, verificationStatus: 'confirmed', entrySource: 'clinician' }) as unknown as Problem2
const medication = (name: string, status: Medication['status'], dosageText?: string): Medication =>
  ({ ...base, id: name, medication: concept(name), status, source: 'prescribed', ...(dosageText ? { dosageText } : {}) }) as unknown as Medication
const allergy = (name: string, extra: Partial<Allergy> = {}): Allergy =>
  ({ ...base, id: name, code: concept(name), verificationStatus: 'confirmed', clinicalStatus: 'active', entrySource: 'clinician', ...extra }) as unknown as Allergy
const vital = (type: Vital['type'], at: string, extra: Partial<Vital>): Vital => ({ ...base, id: `${type}-${at}`, type, effectiveAt: at, status: 'final', entrySource: 'clinician', ...extra }) as unknown as Vital
const lab = (at: string, observations: Partial<LabResult['observations'][number]>[]): LabResult =>
  ({
    id: at,
    patientId: PATIENT,
    code: concept('Panel'),
    status: 'final',
    collectedAt: at,
    observations: observations.map((o, i) => ({ id: `${at}-${i}`, code: concept('Test'), status: 'final', ...o })),
  }) as unknown as LabResult
const encounter = (at: string, status: EncounterSummary['status'], extra: Partial<EncounterSummary> = {}): EncounterSummary =>
  ({ id: at, status, class: 'AMB', facilityId: 'f', startedAt: at, ...extra }) as unknown as EncounterSummary

const ok = (items: unknown[]) => Promise.resolve({ status: 200, data: { items }, headers: new Headers() })
const CALL: Record<GlanceKey, ReturnType<typeof vi.fn>> = {
  problems: vi.mocked(listProblems),
  medications: vi.mocked(listMedications),
  allergies: vi.mocked(listAllergies),
  vitals: vi.mocked(listPatientVitals),
  labs: vi.mocked(listLabResults),
  lastVisit: vi.mocked(listPatientEncounters),
}

function answer(items: Partial<Record<GlanceKey, unknown[]>>) {
  for (const k of GLANCE_KEYS) CALL[k].mockImplementation(() => ok(items[k] ?? []))
}
const data = <K extends GlanceKey>(g: Glance, k: K) => {
  const row = g[k]
  if (row.status !== 'ok') throw new Error(`${k} failed`)
  return row.data
}

beforeEach(() => answer({}))

describe('At a glance: each row with data', () => {
  it('lists active problems by name, up to five, and counts the rest', async () => {
    answer({ problems: ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => problem(n, 'active')).concat(problem('Old', 'resolved')) })
    expect(data(await loadGlance(PATIENT), 'problems')).toEqual({ items: ['A', 'B', 'C', 'D', 'E'], more: 1 })
  })

  it('lists active medications with their directions only', async () => {
    answer({ medications: [medication('Lisinopril 10 MG Oral Tablet', 'active', '1 tablet by mouth once daily'), medication('Amoxicillin', 'completed')] })
    expect(data(await loadGlance(PATIENT), 'medications')).toEqual({ items: [{ name: 'Lisinopril 10 MG Oral Tablet', directions: '1 tablet by mouth once daily' }], more: 0 })
  })

  it('lists allergies with their reactions', async () => {
    answer({ allergies: [allergy('Penicillin', { reactions: [{ manifestations: [concept('Hives')] }] }), allergy('Latex', { verificationStatus: 'entered-in-error' })] })
    expect(data(await loadGlance(PATIENT), 'allergies')).toEqual({ kind: 'listed', items: [{ substance: 'Penicillin', reaction: 'Hives' }] })
  })

  it('says no known allergies only for the no-known-allergy statement', async () => {
    answer({ allergies: [allergy('No known allergy', { code: concept('No known allergy', '716186003') })] })
    expect(data(await loadGlance(PATIENT), 'allergies')).toEqual({ kind: 'none-known' })
  })

  it('shows the latest set of vitals, in words, with its time', async () => {
    answer({
      vitals: [
        vital('heart-rate', '2026-10-27T16:35:00Z', { value: { value: 72, unit: '/min' } }),
        vital('blood-pressure', '2026-10-27T16:35:00Z', { bloodPressure: { systolic: { value: 126, unit: 'mm[Hg]' }, diastolic: { value: 76, unit: 'mm[Hg]' } } }),
        vital('heart-rate', '2026-06-01T16:00:00Z', { value: { value: 88, unit: '/min' } }),
      ],
    })
    expect(data(await loadGlance(PATIENT), 'vitals')).toEqual({ at: '2026-10-27T16:35:00Z', readings: [{ label: 'BP', value: '126/76 mmHg' }, { label: 'Pulse', value: '72 beats/min' }] })
  })

  it('lists the three newest flagged lab results', async () => {
    answer({
      labs: [
        lab('2026-06-16T15:00:00Z', [{ code: concept('A1c'), value: { value: 7.2, unit: '%' }, interpretation: 'H' }]),
        lab('2026-09-15T15:00:00Z', [
          { code: concept('A1c'), value: { value: 7.1, unit: '%' }, interpretation: 'H' },
          { code: concept('Sodium'), value: { value: 140, unit: 'mmol/L' }, interpretation: 'N' },
          { code: concept('Potassium'), value: { value: 6.8, unit: 'mmol/L' }, interpretation: 'HH' },
        ]),
        lab('2026-01-10T15:00:00Z', [{ code: concept('Glucose'), value: { value: 60, unit: 'mg/dL' }, interpretation: 'L' }]),
      ],
    })
    expect(data(await loadGlance(PATIENT), 'labs')).toEqual([
      { test: 'A1c', value: '7.1', unit: '%', flag: 'High', at: '2026-09-15T15:00:00Z' },
      { test: 'Potassium', value: '6.8', unit: 'mmol/L', flag: 'Critical high', at: '2026-09-15T15:00:00Z' },
      { test: 'A1c', value: '7.2', unit: '%', flag: 'High', at: '2026-06-16T15:00:00Z' },
    ])
  })

  it('shows the newest finished visit with its type and clinician', async () => {
    answer({
      lastVisit: [
        encounter('2026-11-17T17:00:00Z', 'in-progress'),
        encounter('2026-10-27T16:30:00Z', 'finished', { types: [concept('Office visit')], renderingProvider: { id: 'p', displayName: 'Dr. Example Provider MD' } }),
        encounter('2026-06-16T16:30:00Z', 'finished'),
      ],
    })
    expect(data(await loadGlance(PATIENT), 'lastVisit')).toEqual({ at: '2026-10-27T16:30:00Z', type: 'Office visit', clinician: 'Dr. Example Provider MD' })
  })
})

describe('At a glance: each row empty', () => {
  it('has nothing to list in any row', async () => {
    const g = await loadGlance(PATIENT)
    expect(data(g, 'problems')).toEqual({ items: [], more: 0 })
    expect(data(g, 'medications')).toEqual({ items: [], more: 0 })
    expect(data(g, 'allergies')).toEqual({ kind: 'not-recorded' })
    expect(data(g, 'vitals')).toBeNull()
    expect(data(g, 'labs')).toEqual([])
    expect(data(g, 'lastVisit')).toBeNull()
  })
})

describe('At a glance: a failed read', () => {
  it.each(GLANCE_KEYS)('fails the %s row only, and the other rows still load', async (key) => {
    CALL[key].mockImplementation(() => Promise.reject(new Error('network')))
    const g = await loadGlance(PATIENT)
    expect(g[key]).toEqual({ status: 'error' })
    for (const other of GLANCE_KEYS.filter((k) => k !== key)) expect(g[other].status).toBe('ok')
  })

  it('throws for a restricted chart, so the sealed card shows instead of part of the chart', async () => {
    const restricted = new ApiError({ type: 'about:blank', title: 'Break-glass required', status: 403, code: 'break-glass-required', requestId: 'r' } as never)
    CALL.labs.mockImplementation(() => Promise.reject(restricted))
    await expect(loadGlance(PATIENT)).rejects.toBe(restricted)
  })
})

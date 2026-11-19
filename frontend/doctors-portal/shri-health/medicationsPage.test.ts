import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../src/api/client'
import { sinceText } from '../src/shri/logic/medicationDisplay'
import { breakGlassPatientOf } from './breakglass'
import { setFacilityTimeZone } from './format'
import { loadMedications } from './medications'

// The record's Prescriptions page with the API: what the medication list maps to, and the states the
// page's route shows. A plain stand-in, not a vi.fn, so a refused read can reject. Synthetic only.
let answer: () => Promise<unknown> = () => Promise.resolve({ status: 200, data: { items: [] } })
vi.mock('../../src/api/generated/endpoints/medications/medications', () => ({ listMedications: () => answer() }))

const PATIENT = '00000000-0000-4000-8000-0000000000aa'
const med = (over: Record<string, unknown>) => ({
  id: 'm1',
  patientId: PATIENT,
  medication: { text: 'omeprazole 20 MG Delayed Release Oral Capsule' },
  dosageText: '20 mg (1 capsule) by mouth once daily before breakfast',
  status: 'active',
  source: 'prescription',
  prescriptionId: 'rx1',
  recordedAt: '2026-09-29T17:10:00Z',
  ...over,
})
const items = (...list: unknown[]) => () => Promise.resolve({ status: 200, data: { items: list } })

beforeEach(() => setFacilityTimeZone('America/Los_Angeles'))

describe('the medication list on the Prescriptions page', () => {
  it('maps current medicines first and past ones after, with the dose text whole and the status in words', async () => {
    answer = items(
      med({ id: 'm1', prescriberDisplayName: 'Dr. Example Prescriber MD' }),
      med({ id: 'm2', status: 'stopped', prescriptionId: 'rx2', medication: { text: 'naproxen 500 MG Oral Tablet' }, recordedAt: '2025-11-18T18:10:00Z' }),
      med({ id: 'm3', status: 'completed', source: 'reported', prescriptionId: undefined, medication: { codings: [{ display: 'ibuprofen 200 MG Oral Tablet' }] } }),
      med({ id: 'm4', status: 'entered-in-error' }),
    )
    const list = await loadMedications(PATIENT)
    expect(list.current).toHaveLength(1)
    expect(list.current[0]).toMatchObject({ id: 'm1', drug: 'omeprazole 20 MG Delayed Release Oral Capsule', frequency: '20 mg (1 capsule) by mouth once daily before breakfast', status: 'Active', prescriptionId: 'rx1', by: 'Dr. Example Prescriber MD' })
    expect(list.history.map((h) => [h.items[0].drug, h.items[0].status, h.prescriptionId, h.by])).toEqual([
      ['ibuprofen 200 MG Oral Tablet', 'Completed', undefined, 'Reported'],
      ['naproxen 500 MG Oral Tablet', 'Stopped', 'rx2', 'Prescriber unavailable'],
    ])
  })

  it('takes the prescriber from the list, never from recordedBy, and says "Reported" for a reported medicine', async () => {
    answer = items(
      med({ id: 'm1', prescriberDisplayName: 'Dr. Example Prescriber MD', recordedBy: 'example-recorder' }),
      med({ id: 'm2', source: 'reported', prescriptionId: undefined, recordedBy: 'example-recorder', recordedAt: '2026-09-28T17:10:00Z' }),
      med({ id: 'm3', prescriptionId: 'rx3', recordedBy: 'example-recorder', recordedAt: '2026-09-27T17:10:00Z' }),
    )
    const list = await loadMedications(PATIENT)
    expect(list.current.map((m) => m.by)).toEqual(['Dr. Example Prescriber MD', 'Reported', 'Prescriber unavailable'])
  })

  it('reads the day it went on the list in the clinic’s calendar: omeprazole reads Sep 29, not a day early', async () => {
    answer = items(med({}), med({ id: 'm2', recordedAt: '2026-09-30T03:30:00Z' }))
    const list = await loadMedications(PATIENT)
    // 10:10 AM and 8:30 PM on Sep 29 in Los Angeles.
    expect(list.current.map((m) => sinceText(m.since))).toEqual(['Sep 29, 2026', 'Sep 29, 2026'])
  })

  it('is empty when the record has no medications (the page says "No medications on this record yet.")', async () => {
    answer = items()
    const list = await loadMedications(PATIENT)
    expect(list).toEqual({ current: [], history: [] })
  })

  it('hands a failed read to the route, which shows its error with Try again', async () => {
    const down = new ApiError({ type: 'about:blank', title: 'Unavailable', status: 503, code: 'service-unavailable' } as never, new Headers())
    answer = () => Promise.reject(down)
    await expect(loadMedications(PATIENT)).rejects.toBe(down)
    expect(breakGlassPatientOf(down, `/patient/${PATIENT}/prescriptions`)).toBeNull()
  })

  it('hands a restricted chart (403 break-glass-required) to the route’s "Restricted chart" card', async () => {
    const sealed = new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'break-glass-required' } as never, new Headers())
    answer = () => Promise.reject(sealed)
    await expect(loadMedications(PATIENT)).rejects.toBe(sealed)
    expect(breakGlassPatientOf(sealed, `/patient/${PATIENT}/prescriptions`)).toBe(PATIENT)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setFacilityTimeZone } from '../../../shri-health/format'
import { loadMedications } from '../../../shri-health/medications'
import { sinceDay } from '../record/PatientReportCard'

// The record's summary card reads "since …" for the first medicine (PatientReportCard sinceDay). The
// loader already turned recordedAt into clinic time, so the card must not convert it again: that put
// it a day early in a browser east of the clinic. Synthetic only.
let items: unknown[] = []
vi.mock('../../../../src/api/generated/endpoints/medications/medications', () => ({
  listMedications: () => Promise.resolve({ status: 200, data: { items } }),
}))

const med = (recordedAt: string) => ({
  id: 'm1',
  patientId: 'p1',
  medication: { text: 'omeprazole 20 MG Delayed Release Oral Capsule' },
  status: 'active',
  source: 'prescription',
  recordedAt,
})

beforeEach(() => setFacilityTimeZone('America/Los_Angeles'))

describe("the summary card's since day", () => {
  it('reads omeprazole as Sep 29, 2026 in Los Angeles, from the loaded medicine', async () => {
    items = [med('2026-09-29T17:10:00Z')]
    const [first] = (await loadMedications('p1')).current
    expect(sinceDay(first.since)).toBe('Sep 29, 2026')
  })

  it('reads an evening entry (after midnight UTC) as its Los Angeles calendar day', async () => {
    items = [med('2026-09-30T03:30:00Z')]
    const [first] = (await loadMedications('p1')).current
    expect(sinceDay(first.since)).toBe('Sep 29, 2026')
  })

  it('reads a clinic-time date as it stands, on any machine: 12:30 AM on Sep 29 stays Sep 29', () => {
    // Converting it again (the old bug) would read 12:30 AM as an instant and land on Sep 28 in Los Angeles.
    expect(sinceDay(new Date(2026, 8, 29, 0, 30))).toBe('Sep 29, 2026')
  })

  it('reads an instant given as text in the clinic’s calendar too', () => {
    expect(sinceDay('2026-09-29T17:10:00Z')).toBe('Sep 29, 2026')
    // Midnight UTC is still Sep 28 in Los Angeles (5:00 PM): the clinic's day, as D40 reads it.
    expect(sinceDay('2026-09-29T00:00:00Z')).toBe('Sep 28, 2026')
  })
})

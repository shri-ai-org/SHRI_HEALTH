import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setFacilityTimeZone } from './format'
import { loadNoteVersions, noteVersionsFor } from './record'

// A signed note's version history (listNoteVersions): what each version maps to, and a refused or
// failed read. A plain stand-in, not a vi.fn, so a read can reject. Synthetic only.
let answer: () => Promise<unknown> = () => Promise.resolve({ status: 200, data: { items: [] } })
vi.mock('../../src/api/generated/endpoints/encounters/encounters', () => ({
  getNote: vi.fn(),
  listEncounterNotes: vi.fn(),
  listPatientEncounters: vi.fn(),
  listNoteVersions: () => answer(),
}))

const NOTE = '00000000-0000-4000-8000-0000000000bb'
const version = (versionId: number, status: string, recordedBy?: { id: string; displayName: string }) => ({
  versionId,
  recordedAt: '2026-11-17T18:05:00Z',
  ...(recordedBy ? { recordedBy } : {}),
  status,
  cosignStatus: 'not-required',
  title: 'Consultation',
  sections: [],
})

beforeEach(() => setFacilityTimeZone('America/Los_Angeles'))

describe('a note version history', () => {
  it('maps every version, newest first as the API sends them, with who saved it', async () => {
    const doctor = { id: '00000000-0000-4000-8000-0000000000cc', displayName: 'Kaia401 Lindgren118' }
    answer = () => Promise.resolve({ status: 200, data: { items: [version(3, 'amended', doctor), version(2, 'final', doctor), version(1, 'preliminary')] } })
    const got = await loadNoteVersions(NOTE)
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.rows.map((r) => [r.version, r.status, r.by])).toEqual([
      [3, 'Amended', 'Kaia401 Lindgren118'],
      [2, 'Signed', 'Kaia401 Lindgren118'],
      [1, 'Draft', null],
    ])
    expect(got.rows[0].at.getDate()).toBe(17) // 10:05 in San Jose, the clinic's day
  })

  it('a refused read (403, 404) and a failed one both show as not readable', async () => {
    answer = () => Promise.resolve({ status: 403, data: {} })
    expect(await loadNoteVersions(NOTE)).toEqual({ ok: false })
    answer = () => Promise.reject(new Error('network'))
    expect(await loadNoteVersions(NOTE)).toEqual({ ok: false })
  })

  it('a mock note has no history and never calls the API', () => {
    answer = () => Promise.reject(new Error('must not be called'))
    expect(noteVersionsFor('note-1')).toEqual({ ok: true, rows: [] })
  })
})

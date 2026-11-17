import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../../../api/client'
import type { PortalLabResult } from '../../../../api/generated/model'
import { axeViolations } from '../../../../test/axe'
import { PortalApiContext, type PortalApi } from '../../api/portalApi'
import { ClinicZone } from '../../clinicZone'
import { pathEnabled } from '../../features'
import { PortalRouter } from '../../router'
import { HELD_TEXT, LabResultsPage, flagOf, flagWords, outOfRange, rangeText, trendsOf, unitText } from './LabResultsPage'

// The patient's own lab results with the real API (listPortalLabResults, #398). Synthetic reports
// only; the API is a stand-in that answers the two reads the page makes.

const ESR = { code: '4537-7', display: 'Erythrocyte sedimentation rate', text: 'ESR (Westergren)' }
const CRP = { code: '1988-5', display: 'C reactive protein', text: 'C-reactive protein' }

const report = (id: string, at: string, over: Partial<PortalLabResult> = {}): PortalLabResult => ({
  id,
  releaseStatus: 'available',
  code: ESR,
  shortName: 'ESR',
  status: 'final',
  effectiveAt: at,
  issuedAt: at,
  results: [{ code: ESR, shortName: 'ESR', value: { value: 12, unit: 'mm/h' }, referenceRange: { low: 0, high: 20 }, interpretation: 'N' }],
  ...over,
})

// Newest first, as the API lists them. 2026-02-24T22:00Z is Feb 24 in San Jose.
const LIST: PortalLabResult[] = [
  report('a1', '2026-02-24T22:00:00Z', { results: [{ code: ESR, shortName: 'ESR', value: { value: 32, unit: 'mm/h' }, referenceRange: { low: 0, high: 20 }, interpretation: 'H' }], conclusion: 'Higher than last time.' }),
  { id: 'held-1', releaseStatus: 'held' },
  report('a2', '2025-11-18T22:00:00Z'),
  report('c1', '2025-11-18T22:00:00Z', { code: CRP, shortName: 'CRP', results: [{ code: CRP, shortName: 'CRP', value: { value: 0.2, unit: 'mg/dL' }, referenceRange: { high: 0.9 }, interpretation: 'L' }] }),
]

function setup(listLabResults: () => Promise<PortalLabResult[]>) {
  const api = {
    listLabResults: vi.fn(listLabResults),
    listBookingFacilities: () => Promise.resolve([{ timeZone: 'America/Los_Angeles' }]),
  } as unknown as PortalApi
  render(
    <PortalApiContext.Provider value={api}>
      <PortalRouter>
        <ClinicZone>
          <LabResultsPage />
        </ClinicZone>
      </PortalRouter>
    </PortalApiContext.Provider>,
  )
  return api
}

describe('Test Results with the real API', () => {
  it('lists each result with its date, value and unit, range and a flag in words', async () => {
    setup(() => Promise.resolve(LIST))
    const list = await screen.findByRole('list', { name: 'Your test results' })
    const [first, held, third, crp] = within(list).getAllByRole('listitem')
    expect(first).toHaveTextContent('ESR')
    expect(first).toHaveTextContent('Collected 02/24/2026')
    expect(first).toHaveTextContent('32 mm/h')
    expect(first).toHaveTextContent('Range 0–20 mm/h')
    expect(first).toHaveTextContent('High')
    expect(first).toHaveTextContent('Higher than last time.')
    expect(held).toHaveTextContent(HELD_TEXT)
    expect(third).toHaveTextContent('Within range')
    expect(crp).toHaveTextContent('0.2 mg/dL')
    expect(crp).toHaveTextContent('Range 0.9 mg/dL or less')
    expect(crp).toHaveTextContent('Low')
    expect(await axeViolations()).toEqual([])
  })

  it('never shows anything of a held result but the line that it is not released yet', async () => {
    setup(() => Promise.resolve([{ id: 'held-1', releaseStatus: 'held' }]))
    const list = await screen.findByRole('list', { name: 'Your test results' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(list).toHaveTextContent(HELD_TEXT)
    expect(list).not.toHaveTextContent(/Collected|Range|mm\/h/)
    expect(screen.queryByRole('heading', { name: 'Over time' })).toBeNull()
  })

  it('draws a graph for a test with two or more values, with out-of-range values marked in words', async () => {
    setup(() => Promise.resolve(LIST))
    expect(await screen.findByRole('heading', { name: 'Over time' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'ESR over 2 results. Latest: 32 mm/h on 02/24/2026, high.' })).toBeInTheDocument()
    const values = screen.getByRole('list', { name: 'ESR values' })
    expect(within(values).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['02/24/2026: 32 mm/h (High)', '11/18/2025: 12 mm/h (Within range)'])
    // CRP has one value: no graph.
    expect(screen.queryByRole('list', { name: 'CRP values' })).toBeNull()
  })

  it('says so when there are none', async () => {
    setup(() => Promise.resolve([]))
    expect(await screen.findByText('No test results on your record yet.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Your test results' })).toBeNull()
  })

  it("shows the portal's error with Try again, and no sample data, when the read fails", async () => {
    const user = userEvent.setup()
    let calls = 0
    const api = setup(() => {
      calls += 1
      return calls === 1
        ? Promise.reject(new ApiError({ type: 'about:blank', title: 'Unavailable', status: 503, code: 'service-unavailable', requestId: 'req-503' } as never))
        : Promise.resolve(LIST)
    })
    expect(await screen.findByText("Couldn't load your test results")).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Your test results' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('list', { name: 'Your test results' })).toBeInTheDocument()
    expect(api.listLabResults).toHaveBeenCalledTimes(2)
  })
})

describe('the graph series', () => {
  it('one series per analyte with 2 or more numeric values, oldest first, without held reports', () => {
    const trends = trendsOf(LIST)
    expect(trends).toHaveLength(1)
    expect(trends[0]).toMatchObject({ key: '4537-7', name: 'ESR', unit: 'mm/h', low: 0, high: 20 })
    expect(trends[0]?.points.map((p) => [p.at.slice(0, 10), p.value, p.flag])).toEqual([
      ['2025-11-18', 12, 'N'],
      ['2026-02-24', 32, 'H'],
    ])
  })

  it('leaves out a value in another unit and text results', () => {
    const other = report('x', '2025-06-01T17:00:00Z', { results: [{ code: ESR, value: { value: 5, unit: 'mm/hr' } }] })
    const text = report('t', '2025-05-01T17:00:00Z', { results: [{ code: ESR, text: 'Negative' }] })
    const [latest, , older] = LIST
    expect(trendsOf([latest!, older!, other, text])[0]?.points).toHaveLength(2)
  })

  it('marks out of range by the lab flag, or by the range when there is no flag', () => {
    expect(outOfRange({ at: '', value: 32, flag: 'H' }, { low: 0, high: 20 })).toBe('high')
    expect(outOfRange({ at: '', value: 32, flag: 'N' }, { low: 0, high: 20 })).toBeNull()
    expect(outOfRange({ at: '', value: -1 }, { low: 0, high: 20 })).toBe('low')
    expect(outOfRange({ at: '', value: 10 }, {})).toBeNull()
  })

  it('words for flags and ranges', () => {
    expect([flagWords('N'), flagWords('H'), flagWords('L'), flagWords('A'), flagWords(undefined)]).toEqual(['Within range', 'High', 'Low', 'Needs attention', null])
    expect(rangeText({ code: ESR, value: { value: 1, unit: 'mg/dL' }, referenceRange: { low: 60 } })).toBe('60 mg/dL or more')
    expect(rangeText({ code: ESR, referenceRange: { text: 'Negative' } })).toBe('Negative')
  })

  it('shows the list with the real API, and keeps the sample detail page hidden', () => {
    expect(pathEnabled('/test-results', true)).toBe(true)
    expect(pathEnabled('/test-results/:resultId', true)).toBe(false)
    expect(pathEnabled('/test-results/:resultId', false)).toBe(true)
  })

  it('writes UCUM units as people do', () => {
    expect(unitText('mL/min/{1.73_m2}')).toBe('mL/min/1.73 m²')
    expect(unitText('mg/dL')).toBe('mg/dL')
  })

  it("takes the lab's flag, or else the range, for the flag in words", () => {
    expect(flagOf({ code: CRP, value: { value: 3.4, unit: 'mg/L' }, referenceRange: { high: 3 } })).toBe('H')
    expect(flagOf({ code: CRP, value: { value: 1, unit: 'mg/L' }, referenceRange: { low: 2, high: 3 } })).toBe('L')
    expect(flagOf({ code: CRP, value: { value: 2.5, unit: 'mg/L' }, referenceRange: { low: 2, high: 3 } })).toBe('N')
    expect(flagOf({ code: CRP, value: { value: 9, unit: 'mg/L' }, referenceRange: { high: 3 }, interpretation: 'A' })).toBe('A')
    expect(flagOf({ code: CRP, value: { value: 9, unit: 'mg/L' } })).toBeUndefined()
  })
})

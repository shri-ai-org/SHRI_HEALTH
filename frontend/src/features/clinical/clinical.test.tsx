import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '../../api/client'
import { todayIn, ToastProvider } from '../../design-system'
import { axeViolations } from '../../test/axe'
import { json, problem, serve } from '../../test/fakeServer'
import { RoomingPage } from './RoomingPage'
import { TodayPage } from './TodayPage'
import { bmi, EMPTY_VITALS, toVitalEntries } from './vitals'

// Synthetic data only.
const TZ = 'America/Chicago'
const facility = { id: '00000000-0000-4000-8000-0000000007f1', code: 'MAIN', name: 'Test Main Clinic', timeZone: TZ }
const provider = { id: '00000000-0000-4000-8000-0000000007b1', displayName: 'Dr. Test Provider', facilityIds: [facility.id] }
const patientId = '00000000-0000-4000-8000-0000000007aa'
const encounterId = '00000000-0000-4000-8000-0000000007e1'
const appointmentId = '00000000-0000-4000-8000-0000000007a1'
const room1 = { id: '00000000-0000-4000-8000-0000000007c1', facilityId: facility.id, name: 'Exam 1', physicalType: 'ro' }
const room2 = { id: '00000000-0000-4000-8000-0000000007c2', facilityId: facility.id, name: 'Exam 2', physicalType: 'ro' }
const lobby = { id: '00000000-0000-4000-8000-0000000007c9', facilityId: facility.id, name: 'Lobby', physicalType: 'wi' }

const now = new Date()
const today = todayIn(TZ, now)
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString()

const item = (n: number, extra: object = {}) => ({
  appointmentId: `00000000-0000-4000-8000-0000000007d${n}`,
  initials: 'AT',
  patient: { id: patientId, displayName: `Testperson${n}, Ana` },
  provider: { id: provider.id, displayName: provider.displayName },
  startAt: now.toISOString(),
  status: 'booked',
  appointmentType: { id: '00000000-0000-4000-8000-0000000007f9', name: 'Follow-up' },
  reasonForVisit: 'Knee pain',
  ...extra,
})

const REFERENCE = {
  'GET /api/v1/booking/facilities?limit=100': [() => json(200, { items: [facility] })],
  'GET /api/v1/booking/appointment-types?limit=100': [() => json(200, { items: [] })],
  [`GET /api/v1/booking/providers?facilityId=${facility.id}&limit=100`]: [() => json(200, { items: [provider] })],
}
const BOARD = `GET /api/v1/status-board?facilityId=${facility.id}&date=${today}&view=staff&limit=100`

function renderRoutes(initial: string) {
  const router = createMemoryRouter(
    [
      { path: '/today', element: <TodayPage /> },
      { path: '/visits/:encounterId/rooming', element: <RoomingPage /> },
    ],
    { initialEntries: [initial] },
  )
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  )
}

beforeEach(() => setCsrfToken('tok'))
afterEach(() => {
  setCsrfToken(null)
  vi.unstubAllGlobals()
})

describe('TodayPage', () => {
  it("lists today's patients with their step, wait, room and the way into rooming", async () => {
    serve({
      ...REFERENCE,
      [BOARD]: [
        () =>
          json(200, {
            items: [
              item(1),
              item(2, { status: 'checked-in', visitStatus: 'checked-in', visitStatusAt: minutesAgo(12), encounterId }),
              item(3, { status: 'checked-in', visitStatus: 'roomed', visitStatusAt: minutesAgo(3), roomName: 'Exam 2', encounterId: '00000000-0000-4000-8000-0000000007e3' }),
              item(4, { patient: { id: patientId, displayName: 'Testperson4, Ana', restricted: true } }),
            ],
          }),
      ],
    })
    renderRoutes('/today')
    const table = await screen.findByRole('table', { name: 'Test Main Clinic, today: 4 patients' })
    const rows = within(table).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('Knee pain')
    expect(within(rows[1]!).queryByRole('link')).not.toBeInTheDocument()
    expect(rows[2]).toHaveTextContent(/Checked in\s*waiting 12 min/)
    expect(within(rows[2]!).getByRole('link', { name: 'Room Testperson2, Ana' })).toHaveAttribute('href', `/visits/${encounterId}/rooming`)
    expect(rows[3]).toHaveTextContent('Exam 2')
    expect(within(rows[3]!).getByRole('link', { name: 'Open rooming for Testperson3, Ana' })).toBeInTheDocument()
    expect(within(rows[4]!).getByText('Restricted')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('shows a refused board in plain words', async () => {
    serve({ ...REFERENCE, [BOARD]: [() => problem(403, 'forbidden', { requestId: 'r-9' })] })
    renderRoutes('/today')
    expect(await screen.findByText('Reference: r-9')).toBeInTheDocument()
  })
})

const encounter = (extra: object = {}) => ({
  id: encounterId,
  patientId,
  status: 'arrived',
  class: 'AMB',
  facilityId: facility.id,
  timeZone: TZ,
  appointmentId,
  reasons: [{ text: 'Knee pain' }],
  participants: [],
  diagnoses: [],
  vitals: [],
  notes: [],
  createdAt: minutesAgo(20),
  updatedAt: minutesAgo(20),
  ...extra,
})
const withEtag = (body: unknown, etag: string) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ETag: etag } })
const summary = { id: patientId, name: { family: 'Testperson', given: ['Ana'] }, birthDate: '1980-04-02', mrn: 'TST-1001', restricted: false, active: true }

const ENCOUNTER = `GET /api/v1/encounters/${encounterId}`
const ALLERGIES = `GET /api/v1/patients/${patientId}/allergies?limit=100`
const MEDICATIONS = `GET /api/v1/patients/${patientId}/medications?limit=100`
function visit(encounters: Array<() => Response> = [() => withEtag(encounter(), '"3"')], extra: Record<string, Array<() => Response>> = {}) {
  return serve({
    [ENCOUNTER]: encounters,
    'POST /api/v1/patients/summaries': [() => json(200, { items: [summary] })],
    [`GET /api/v1/booking/locations?facilityId=${facility.id}&limit=100`]: [() => json(200, { items: [room1, room2, lobby] })],
    [ALLERGIES]: [() => json(200, { items: [] })],
    [MEDICATIONS]: [() => json(200, { items: [] })],
    ...extra,
  })
}

describe('RoomingPage', () => {
  it('shows the patient by their minimum-necessary summary and offers exam rooms only', async () => {
    const server = visit()
    renderRoutes(`/visits/${encounterId}/rooming`)
    expect(await screen.findByRole('heading', { name: 'Rooming: Testperson, Ana' })).toBeInTheDocument()
    expect(screen.getByText(/MRN TST-1001/)).toBeInTheDocument()
    expect(server.bodies('POST /api/v1/patients/summaries')[0]?.body).toEqual({ patientIds: [patientId] })
    const select = screen.getByRole('combobox', { name: 'Room' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a room', 'Exam 1', 'Exam 2'])
    expect(await screen.findByText('No allergies recorded')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('rooms the patient, then shows the room', async () => {
    const user = userEvent.setup()
    const STATUS = `POST /api/v1/appointments/${appointmentId}/status`
    const server = visit([() => withEtag(encounter(), '"3"'), () => withEtag(encounter({ status: 'triaged', locationId: room2.id }), '"4"')], {
      [STATUS]: [() => json(200, { id: appointmentId })],
    })
    renderRoutes(`/visits/${encounterId}/rooming`)
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Room' }), 'Exam 2')
    await user.click(screen.getByRole('button', { name: 'Mark as roomed' }))
    expect(await screen.findByText('Current room: Exam 2')).toBeInTheDocument()
    expect(server.bodies(STATUS)[0]?.body).toEqual({ status: 'roomed', roomLocationId: room2.id })
    expect(screen.getByRole('button', { name: 'Move to this room' })).toBeInTheDocument()
  })

  it('records vitals in the units entered, with an Idempotency-Key, and shows the server’s flags', async () => {
    const user = userEvent.setup()
    const VITALS = `POST /api/v1/encounters/${encounterId}/vitals`
    const taken = [
      { id: '00000000-0000-4000-8000-0000000007f2', patientId, encounterId, type: 'blood-pressure', bloodPressure: { systolic: { value: 152, unit: 'mm[Hg]' }, diastolic: { value: 95, unit: 'mm[Hg]' } }, effectiveAt: now.toISOString(), status: 'final', interpretation: 'H', entrySource: 'clinician', recordedAt: now.toISOString() },
      { id: '00000000-0000-4000-8000-0000000007f3', patientId, encounterId, type: 'body-temperature', value: { value: 98.6, unit: '[degF]' }, effectiveAt: now.toISOString(), status: 'final', interpretation: 'N', entrySource: 'clinician', recordedAt: now.toISOString() },
    ]
    const server = visit([() => withEtag(encounter(), '"3"'), () => withEtag(encounter({ vitals: taken }), '"4"')], {
      [VITALS]: [() => json(201, { vitals: taken })],
    })
    renderRoutes(`/visits/${encounterId}/rooming`)
    await user.type(await screen.findByLabelText('Systolic (mmHg)'), '152')
    await user.type(screen.getByLabelText('Diastolic (mmHg)'), '95')
    await user.type(screen.getByLabelText('Temperature (°F)'), '98.6')
    await user.click(screen.getByRole('button', { name: 'Save vitals' }))

    expect(await screen.findByText('Vitals saved; 1 out of range')).toBeInTheDocument()
    const [sent] = server.bodies(VITALS)
    expect(sent?.body).toEqual({
      entries: [
        { type: 'blood-pressure', bloodPressure: { systolic: { value: 152, unit: 'mm[Hg]' }, diastolic: { value: 95, unit: 'mm[Hg]' } } },
        { type: 'body-temperature', value: { value: 98.6, unit: '[degF]' } },
      ],
    })
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    const table = await screen.findByRole('table', { name: 'Vitals taken this visit' })
    expect(within(table).getByText('152/95 mmHg')).toBeInTheDocument()
    expect(within(table).getByText('High')).toBeInTheDocument()
  })

  it('checks the vitals form before sending anything', async () => {
    const user = userEvent.setup()
    const server = visit()
    renderRoutes(`/visits/${encounterId}/rooming`)
    await user.click(await screen.findByRole('button', { name: 'Save vitals' }))
    expect(screen.getByText('Enter at least one vital sign.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Systolic (mmHg)'), '120')
    await user.type(screen.getByLabelText('Heart rate (beats/min)'), '7a')
    await user.click(screen.getByRole('button', { name: 'Save vitals' }))
    expect(screen.getAllByText('Enter both blood pressure values.')).toHaveLength(1)
    expect(screen.getByText('Enter a whole number.')).toBeInTheDocument()
    expect(server.calls().filter((c) => c.startsWith('POST') && c.includes('/vitals'))).toEqual([])
  })

  it('saves the reason for visit with If-Match, and shows a refusal in plain words', async () => {
    const user = userEvent.setup()
    const PATCH = `PATCH /api/v1/encounters/${encounterId}`
    const server = visit(undefined, { [PATCH]: [() => problem(403, 'forbidden', { requestId: 'r-12' })] })
    renderRoutes(`/visits/${encounterId}/rooming`)
    const reason = await screen.findByRole('textbox', { name: /^Reason for visit/ })
    await user.clear(reason)
    await user.type(reason, 'Knee pain, worse on stairs')
    await user.click(screen.getByRole('button', { name: 'Save reason' }))
    expect(await screen.findByText('Reference: r-12')).toBeInTheDocument()
    const [sent] = server.bodies(PATCH)
    expect(sent?.body).toEqual({ reasons: [{ text: 'Knee pain, worse on stairs' }] })
    expect(sent?.headers.get('If-Match')).toBe('"3"')
  })

  it('records a drug allergy coded in RxNorm, tied to this visit', async () => {
    const user = userEvent.setup()
    const ADD = `POST /api/v1/patients/${patientId}/allergies`
    const amoxicillin = { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '723', display: 'amoxicillin' }
    const server = visit(undefined, {
      'GET /api/v1/codes?system=rxnorm&q=amox&limit=10': [() => json(200, { items: [amoxicillin] })],
      [ADD]: [() => json(201, { id: '00000000-0000-4000-8000-0000000007f4' })],
      [ALLERGIES]: [
        () => json(200, { items: [] }),
        () => json(200, { items: [{ id: '00000000-0000-4000-8000-0000000007f4', patientId, code: { codings: [amoxicillin], text: 'amoxicillin' }, type: 'allergy', clinicalStatus: 'active', verificationStatus: 'confirmed', criticality: 'high', reactions: [{ manifestations: [{ text: 'Hives' }], severity: 'moderate' }], entrySource: 'clinician', recordedAt: now.toISOString() }] }),
      ],
    })
    renderRoutes(`/visits/${encounterId}/rooming`)
    await user.type(await screen.findByLabelText('Substance'), 'amox')
    await user.click(screen.getByRole('button', { name: 'Search drugs for substance' }))
    expect(await screen.findByRole('combobox', { name: 'Drug' })).toHaveValue(`${amoxicillin.system}|723`)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Criticality' }), 'High')
    await user.type(screen.getByLabelText('Reaction'), 'Hives')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Severity' }), 'Moderate')
    await user.click(screen.getByRole('button', { name: 'Record allergy' }))

    expect(await screen.findByText('Allergy to amoxicillin recorded')).toBeInTheDocument()
    const [sent] = server.bodies(ADD)
    expect(sent?.body).toEqual({
      code: { codings: [amoxicillin], text: 'amoxicillin' },
      type: 'allergy',
      encounterId,
      criticality: 'high',
      reactions: [{ manifestations: [{ text: 'Hives' }], severity: 'moderate' }],
    })
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    const table = await screen.findByRole('table', { name: 'Allergies on the chart' })
    expect(within(table).getByText('Hives · moderate')).toBeInTheDocument()
  })

  it('records “no known allergies” as the SNOMED CT statement, with its own key', async () => {
    const user = userEvent.setup()
    const ADD = `POST /api/v1/patients/${patientId}/allergies`
    const server = visit(undefined, { [ADD]: [() => problem(503, 'service-unavailable', { requestId: 'r-20' }), () => json(201, { id: '00000000-0000-4000-8000-0000000007f5' })] })
    renderRoutes(`/visits/${encounterId}/rooming`)
    await user.type(await screen.findByLabelText('Substance'), 'latex')
    await user.click(screen.getByRole('button', { name: 'Record allergy' }))
    expect(await screen.findByText('Reference: r-20')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'No known allergies' }))
    expect(await screen.findByText('No known allergies recorded')).toBeInTheDocument()
    const [typed, nka] = server.bodies(ADD)
    expect(typed?.body).toMatchObject({ code: { text: 'latex' } })
    expect(nka?.body).toEqual({ code: { codings: [{ system: 'http://snomed.info/sct', code: '716186003', display: 'No known allergy' }], text: 'No known allergies' }, encounterId })
    expect(nka?.headers.get('Idempotency-Key')).not.toBe(typed?.headers.get('Idempotency-Key'))
  })

  it('shows a closed visit read-only', async () => {
    visit([() => withEtag(encounter({ status: 'finished' }), '"9"')])
    renderRoutes(`/visits/${encounterId}/rooming`)
    expect(await screen.findByText('This visit is closed; it can no longer be changed here.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save vitals' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record allergy' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add medication' })).not.toBeInTheDocument()
    expect(screen.getByText('Knee pain')).toBeInTheDocument()
  })
})

describe('current medications at rooming', () => {
  const lisinopril = { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '314076', display: 'lisinopril 10 MG Oral Tablet' }
  const med = (n: number, extra: object = {}) => ({
    id: `00000000-0000-4000-8000-0000000008a${n}`,
    patientId,
    medication: { codings: [lisinopril], text: lisinopril.display },
    dosageText: '1 tablet by mouth once daily',
    status: 'active',
    source: 'reported',
    recordedAt: now.toISOString(),
    ...extra,
  })
  const ADD = `POST /api/v1/patients/${patientId}/medications`

  it('lists the medications, reported or prescribed here', async () => {
    visit(undefined, { [MEDICATIONS]: [() => json(200, { items: [med(1), med(2, { medication: { text: 'Fish oil' }, dosageText: undefined, source: 'prescription', prescriptionId: '00000000-0000-4000-8000-0000000008f1' })] })] })
    renderRoutes(`/visits/${encounterId}/rooming`)
    const table = await screen.findByRole('table', { name: 'Medications on the list' })
    const rows = within(table).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('lisinopril 10 MG Oral Tablet1 tablet by mouth once dailyActiveReported')
    expect(within(rows[2]!).getByText('Prescribed here')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('adds a medication coded in RxNorm, as active, with how it is taken and an Idempotency-Key', async () => {
    const user = userEvent.setup()
    const server = visit(undefined, {
      'GET /api/v1/codes?system=rxnorm&q=lisin&limit=10': [() => json(200, { items: [lisinopril] })],
      [ADD]: [() => json(201, med(1))],
      [MEDICATIONS]: [() => json(200, { items: [] }), () => json(200, { items: [med(1)] })],
    })
    renderRoutes(`/visits/${encounterId}/rooming`)
    await user.type(await screen.findByLabelText('Medication'), 'lisin')
    await user.click(screen.getByRole('button', { name: 'Search drugs for medication' }))
    expect(await screen.findByRole('combobox', { name: 'Matching medication' })).toHaveValue(`${lisinopril.system}|314076`)
    await user.type(screen.getByLabelText(/How the patient takes it/), '1 tablet by mouth once daily')
    await user.click(screen.getByRole('button', { name: 'Add medication' }))

    expect(await screen.findByText('lisinopril 10 MG Oral Tablet added to the medication list')).toBeInTheDocument()
    const [sent] = server.bodies(ADD)
    expect(sent?.body).toEqual({ medication: { codings: [lisinopril], text: lisinopril.display }, status: 'active', dosageText: '1 tablet by mouth once daily' })
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(await within(await screen.findByRole('table', { name: 'Medications on the list' })).findByText('lisinopril 10 MG Oral Tablet')).toBeInTheDocument()
  })

  it('records a medication as typed when it isn’t searched, and asks for a name when empty', async () => {
    const user = userEvent.setup()
    const server = visit(undefined, { [ADD]: [() => json(201, med(1, { medication: { text: 'Fish oil' } }))] })
    renderRoutes(`/visits/${encounterId}/rooming`)
    await user.click(await screen.findByRole('button', { name: 'Add medication' }))
    expect(screen.getByText('Search for the medication, or type its name.')).toBeInTheDocument()
    expect(server.bodies(ADD)).toEqual([])

    await user.type(screen.getByLabelText('Medication'), 'Fish oil')
    await user.click(screen.getByRole('button', { name: 'Add medication' }))
    expect(await screen.findByText('Fish oil added to the medication list')).toBeInTheDocument()
    expect(server.bodies(ADD)[0]?.body).toEqual({ medication: { text: 'Fish oil' }, status: 'active' })
  })

  it('keeps the entry and its key after a refusal, and uses a new key once it changes', async () => {
    const user = userEvent.setup()
    const server = visit(undefined, { [ADD]: [() => problem(422, 'validation-failed', { requestId: 'r-31' }), () => json(201, med(1, { medication: { text: 'Fish oil 1000 mg' } }))] })
    renderRoutes(`/visits/${encounterId}/rooming`)
    await user.type(await screen.findByLabelText('Medication'), 'Fish oil')
    await user.click(screen.getByRole('button', { name: 'Add medication' }))
    expect(await screen.findByText('Reference: r-31')).toBeInTheDocument()
    expect(screen.getByLabelText('Medication')).toHaveValue('Fish oil')
    await user.type(screen.getByLabelText('Medication'), ' 1000 mg')
    await user.click(screen.getByRole('button', { name: 'Add medication' }))
    expect(await screen.findByText('Fish oil 1000 mg added to the medication list')).toBeInTheDocument()
    const [first, second] = server.bodies(ADD)
    expect(second?.headers.get('Idempotency-Key')).not.toBe(first?.headers.get('Idempotency-Key'))
  })
})

describe('vitals form', () => {
  it('leaves empty fields out and keeps the units as entered (D69)', () => {
    expect(toVitalEntries({ ...EMPTY_VITALS, heartRate: '72', weight: '165.5', height: '66' }).entries).toEqual([
      { type: 'heart-rate', value: { value: 72, unit: '/min' } },
      { type: 'body-height', value: { value: 66, unit: '[in_i]' } },
      { type: 'body-weight', value: { value: 165.5, unit: '[lb_av]' } },
    ])
  })

  it('works out BMI from inches and pounds for display', () => {
    expect(bmi({ ...EMPTY_VITALS, height: '66', weight: '165' })).toBe(26.6)
    expect(bmi({ ...EMPTY_VITALS, height: '66' })).toBeNull()
  })
})

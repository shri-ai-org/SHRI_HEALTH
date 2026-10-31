import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '../../api/client'
import { ToastProvider } from '../../design-system'
import { axeViolations } from '../../test/axe'
import { json, problem, serve } from '../../test/fakeServer'
import { VisitPage } from './VisitPage'

// Synthetic data only.
const TZ = 'America/Chicago'
const patientId = '00000000-0000-4000-8000-0000000008aa'
const encounterId = '00000000-0000-4000-8000-0000000008e1'
const noteId = '00000000-0000-4000-8000-0000000008b1'
const templateId = '00000000-0000-4000-8000-0000000008c1'
const author = { id: '00000000-0000-4000-8000-0000000008d1', displayName: 'Dr. Test Provider' }
const HPI = '00000000-0000-4000-8000-0000000008f1'
const PLAN = '00000000-0000-4000-8000-0000000008f2'
const INSTRUCTIONS = '00000000-0000-4000-8000-0000000008f3'
const at = '2026-11-20T15:00:00Z'

const encounter = (extra: object = {}) => ({
  id: encounterId,
  patientId,
  status: 'triaged',
  class: 'AMB',
  facilityId: '00000000-0000-4000-8000-0000000008f9',
  timeZone: TZ,
  reasons: [{ text: 'Cough' }],
  participants: [],
  diagnoses: [],
  vitals: [],
  notes: [],
  createdAt: at,
  updatedAt: at,
  ...extra,
})

const sinusitis = { system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'J01.90', display: 'Acute sinusitis, unspecified' }
const diagnosis = { id: '00000000-0000-4000-8000-0000000008a1', encounterId, rank: 1, code: sinusitis, verificationStatus: 'confirmed', entrySource: 'clinician', recordedAt: at }

// The server lists the sections in its own order; the screen shows them by `sequence`.
const sections = (texts: { hpi?: string; plan?: string } = {}) => [
  { id: PLAN, code: '51847-2', title: 'Assessment and plan', sequence: 2, required: true, text: texts.plan ?? '', entrySource: 'clinician' },
  { id: HPI, code: '10164-2', title: 'History of present illness', sequence: 1, required: true, text: texts.hpi ?? '', entrySource: 'clinician' },
  { id: INSTRUCTIONS, code: '69730-0', title: 'Patient instructions', sequence: 3, required: false, text: 'Rest and fluids.', entrySource: 'clinician' },
]
const note = (extra: object = {}, texts: { hpi?: string; plan?: string } = {}) => ({
  id: noteId,
  encounterId,
  patientId,
  noteType: { text: 'Progress note' },
  title: 'General visit',
  status: 'preliminary',
  cosignStatus: 'not-required',
  templateId,
  author,
  aiAssisted: false,
  sections: sections(texts),
  addenda: [],
  createdAt: at,
  updatedAt: at,
  ...extra,
})
const noteSummary = (status = 'preliminary') => ({ id: noteId, noteType: { text: 'Progress note' }, title: 'General visit', status, cosignStatus: 'not-required', author, aiAssisted: false, updatedAt: at })
const signed = (texts = { hpi: 'Cough for three days.', plan: 'Viral URI. Supportive care.' }) => note({ status: 'final', signedAt: at, signedBy: author }, texts)

const withEtag = (body: unknown, etag: string, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ETag: etag } })
const summary = { id: patientId, name: { family: 'Testperson', given: ['Bo'] }, birthDate: '1975-06-09', mrn: 'TST-2001', restricted: false, active: true }
const template = { id: templateId, code: 'general', name: 'General visit', noteTypeLoinc: '11506-3', active: true, sections: [], createdAt: at, updatedAt: at }

const ENCOUNTER = `GET /api/v1/encounters/${encounterId}`
const TEMPLATES = 'GET /api/v1/note-templates?active=true&limit=100'
const NOTE = `GET /api/v1/notes/${noteId}`
const PATCH = `PATCH /api/v1/notes/${noteId}`
const SIGN = `POST /api/v1/notes/${noteId}/sign`

function visit(encounters: Array<() => Response>, extra: Record<string, Array<() => Response>> = {}) {
  return serve({
    [ENCOUNTER]: encounters,
    'POST /api/v1/patients/summaries': [() => json(200, { items: [summary] })],
    [TEMPLATES]: [() => json(200, { items: [template] })],
    ...extra,
  })
}

/** The headers of each call to `key`; sign has no body, so `serve().bodies()` can't read it. */
function headersOf(key: string): Headers[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}` === key)
    .map(([, init]) => new Headers(init?.headers))
}

function renderVisit() {
  const router = createMemoryRouter([{ path: '/visits/:encounterId', element: <VisitPage /> }], { initialEntries: [`/visits/${encounterId}`] })
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

describe('VisitPage: diagnoses', () => {
  it('finds an ICD-10-CM code, adds it with an Idempotency-Key, then removes it with a reason', async () => {
    const user = userEvent.setup()
    const ADD = `POST /api/v1/encounters/${encounterId}/diagnoses`
    const REMOVE = `POST /api/v1/encounters/${encounterId}/diagnoses/${diagnosis.id}/remove`
    const server = visit([() => json(200, encounter()), () => json(200, encounter({ diagnoses: [diagnosis] })), () => json(200, encounter())], {
      'GET /api/v1/codes?system=icd-10-cm&q=sinusitis&billableOnly=true&limit=10': [() => json(200, { items: [{ ...sinusitis, billable: true }] })],
      [ADD]: [() => json(201, diagnosis)],
      [REMOVE]: [() => json(200, { ...diagnosis, verificationStatus: 'entered-in-error' })],
    })
    renderVisit()
    expect(await screen.findByRole('heading', { name: 'Visit: Testperson, Bo' })).toBeInTheDocument()
    expect(screen.getByText('Reason for visit: Cough')).toBeInTheDocument()
    expect(screen.getByText('No diagnoses yet')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])

    await user.type(screen.getByRole('textbox', { name: /^Diagnosis/ }), 'sinusitis')
    await user.click(screen.getByRole('button', { name: 'Search codes' }))
    expect(await screen.findByRole('combobox', { name: 'Matching codes' })).toHaveDisplayValue('J01.90 Acute sinusitis, unspecified')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'Provisional')
    await user.click(screen.getByRole('button', { name: 'Add diagnosis' }))

    const table = await screen.findByRole('table', { name: 'Diagnoses for this visit' })
    expect(await within(table).findByText('J01.90 Acute sinusitis, unspecified')).toBeInTheDocument()
    const [sent] = server.bodies(ADD)
    expect(sent?.body).toEqual({ code: sinusitis, verificationStatus: 'provisional' })
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)

    await user.click(within(table).getByRole('button', { name: 'Remove J01.90 Acute sinusitis, unspecified' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove this diagnosis?' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove diagnosis' }))
    expect(within(dialog).getByText('Give the reason for removing it.')).toBeInTheDocument()
    expect(server.calls()).not.toContain(REMOVE)
    await user.type(within(dialog).getByRole('textbox', { name: /^Reason/ }), 'Added to the wrong visit')
    await user.click(within(dialog).getByRole('button', { name: 'Remove diagnosis' }))
    expect(await screen.findByText('No diagnoses yet')).toBeInTheDocument()
    expect(server.bodies(REMOVE)[0]?.body).toEqual({ reason: 'Added to the wrong visit' })
  })

  it('shows the code search’s refusal in plain words', async () => {
    const user = userEvent.setup()
    visit([() => json(200, encounter())], {
      'GET /api/v1/codes?system=icd-10-cm&q=sinusitis&billableOnly=true&limit=10': [() => problem(403, 'permission-denied', { requestId: 'r-21' })],
    })
    renderVisit()
    await user.type(await screen.findByRole('textbox', { name: /^Diagnosis/ }), 'sinusitis')
    await user.click(screen.getByRole('button', { name: 'Search codes' }))
    expect(await screen.findByText('Reference: r-21')).toBeInTheDocument()
  })
})

describe('VisitPage: the note', () => {
  it('starts a note from a template, saves each section on leaving it with If-Match, then signs the saved version', async () => {
    const user = userEvent.setup()
    const CREATE = `POST /api/v1/encounters/${encounterId}/notes`
    const server = visit(
      [() => json(200, encounter()), () => json(200, encounter({ status: 'in-progress', notes: [noteSummary()] })), () => json(200, encounter({ status: 'in-progress', diagnoses: [diagnosis], notes: [noteSummary('final')] }))],
      {
        [CREATE]: [() => withEtag(note(), '"n1"', 201)],
        [NOTE]: [() => withEtag(note(), '"n1"')],
        [PATCH]: [() => withEtag(note({}, { hpi: 'Cough for three days.' }), '"n2"'), () => withEtag(note({}, { hpi: 'Cough for three days.', plan: 'Viral URI. Supportive care.' }), '"n3"')],
        [SIGN]: [() => withEtag(signed(), '"n4"')],
      },
    )
    renderVisit()
    await user.click(await screen.findByRole('button', { name: 'Start note' }))
    expect(server.bodies(CREATE)[0]?.body).toEqual({ templateId })
    expect(server.bodies(CREATE)[0]?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)

    // Shown by sequence, not in the server's order.
    const hpi = await screen.findByRole('textbox', { name: /^History of present illness \(required\)/ })
    const plan = screen.getByRole('textbox', { name: /^Assessment and plan \(required\)/ })
    expect(hpi.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('textbox', { name: /^Patient instructions/ })).toHaveValue('Rest and fluids.')

    await user.type(hpi, 'Cough for three days.')
    await user.click(plan) // leaving the section saves it
    await user.type(plan, 'Viral URI. Supportive care.')
    await user.click(screen.getByRole('button', { name: 'Sign note' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sign this note?' })
    await user.click(within(dialog).getByRole('button', { name: 'Sign note' }))

    expect(await screen.findByText('Signed')).toBeInTheDocument()
    const patches = server.bodies(PATCH)
    expect(patches.map((p) => p.body)).toEqual([{ sections: [{ id: HPI, text: 'Cough for three days.' }] }, { sections: [{ id: PLAN, text: 'Viral URI. Supportive care.' }] }])
    expect(patches.map((p) => p.headers.get('If-Match'))).toEqual(['"n1"', '"n2"'])
    expect(headersOf(SIGN).map((h) => h.get('If-Match'))).toEqual(['"n3"'])
    expect(screen.getByText('Viral URI. Supportive care.')).toBeInTheDocument()
    expect(await screen.findByText('The note is signed, so these diagnoses are locked.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add diagnosis' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
  })

  it('shows a sign refusal on the section it names, by the note’s own section order', async () => {
    const user = userEvent.setup()
    visit([() => json(200, encounter({ notes: [noteSummary()] }))], {
      [NOTE]: [() => withEtag(note({}, { hpi: 'Cough for three days.' }), '"n1"')],
      [SIGN]: [() => problem(422, 'business-rule-violation', { errors: [{ in: 'body', pointer: '/sections/0/text', code: 'required' }] })],
    })
    renderVisit()
    await user.click(await screen.findByRole('button', { name: 'Sign note' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Sign this note?' })).getByRole('button', { name: 'Sign note' }))
    // `/sections/0` is the server's first section: Assessment and plan, shown second.
    const plan = await screen.findByRole('textbox', { name: /^Assessment and plan \(required\)/ })
    expect(plan).toHaveAccessibleDescription(/This section is required\. Write it before signing\./)
    expect(screen.getByRole('textbox', { name: /^History of present illness/ })).not.toHaveAccessibleDescription(/required/)
    expect(screen.getByText('Draft')).toBeInTheDocument()
  })

  it('reloads the note when it changed in another tab (412), instead of overwriting it', async () => {
    const user = userEvent.setup()
    const server = visit([() => json(200, encounter({ notes: [noteSummary()] }))], {
      [NOTE]: [() => withEtag(note(), '"n1"'), () => withEtag(note({}, { hpi: 'Written in the other tab.' }), '"n5"')],
      [PATCH]: [() => problem(412, 'precondition-failed')],
    })
    renderVisit()
    await user.type(await screen.findByRole('textbox', { name: /^History of present illness/ }), 'Typed here.')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(await screen.findByRole('textbox', { name: /^History of present illness/ })).toHaveValue('Written in the other tab.')
    expect(screen.getByText(/Someone else changed this record while you were working/)).toBeInTheDocument()
    expect(server.calls().filter((c) => c === NOTE)).toHaveLength(2)
  })

  it('adds a signed addendum to a signed note with If-Match and an Idempotency-Key', async () => {
    const user = userEvent.setup()
    const ADDENDA = `POST /api/v1/notes/${noteId}/addenda`
    const addendum = { id: '00000000-0000-4000-8000-0000000008a9', text: 'Chest X-ray reviewed: clear.', author, signedAt: at }
    const server = visit([() => json(200, encounter({ status: 'finished', notes: [noteSummary('final')] }))], {
      [NOTE]: [() => withEtag(signed(), '"s1"')],
      [ADDENDA]: [() => withEtag({ ...signed(), status: 'amended', addenda: [addendum] }, '"s2"')],
    })
    renderVisit()
    expect(await screen.findByText('Signed')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /^History of present illness/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sign addendum' }))
    expect(screen.getByText('Write the addendum first.')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: /^Addendum/ }), 'Chest X-ray reviewed: clear.')
    await user.click(screen.getByRole('button', { name: 'Sign addendum' }))

    expect(await screen.findByText('Signed, amended')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Addenda' })).getByText('Chest X-ray reviewed: clear.')).toBeInTheDocument()
    const [sent] = server.bodies(ADDENDA)
    expect(sent?.body).toEqual({ text: 'Chest X-ray reviewed: clear.' })
    expect(sent?.headers.get('If-Match')).toBe('"s1"')
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(await axeViolations()).toEqual([])
  })
})

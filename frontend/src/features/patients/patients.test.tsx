import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '../../api/client'
import { ToastProvider } from '../../design-system'
import { axeViolations } from '../../test/axe'
import { PatientPage } from './PatientPage'
import { criteriaProblem, PatientSearchPage } from './PatientSearchPage'
import { RegisterPatientPage } from './RegisterPatientPage'

// Synthetic data only.
const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } })
const problem = (status: number, code: string, extra: object = {}) =>
  json(status, { type: 'about:blank', title: code, status, code, ...extra }, 'application/problem+json')

const summary = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  name: { given: ['Ana'], family: `Testperson${n}` },
  birthDate: '1984-07-19',
  gender: 'female',
  mrn: `SH-${1000 + n}`,
  phoneLast4: '0123',
  restricted: n === 2,
  active: true,
})

const patient = {
  ...summary(1),
  id: '00000000-0000-4000-8000-0000000000aa',
  mrn: 'SH-2001',
  name: { given: ['Ana'], family: 'Testperson' },
  createdAt: '2026-10-24T12:00:00Z',
  updatedAt: '2026-10-24T12:00:00Z',
}

/** A fake server: answers by "METHOD /path"; each route's last response repeats. */
function serve(routes: Record<string, Array<() => Response>>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    const list = routes[key]
    if (!list) throw new Error(`unexpected ${key}`)
    return (list.length > 1 ? list.shift()! : list[0]!)()
  })
  vi.stubGlobal('fetch', fetchMock)
  const bodies = (key: string) =>
    fetchMock.mock.calls
      .filter(([url, init]) => `${init?.method ?? 'GET'} ${url}` === key)
      .map(([, init]) => ({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) }))
  return { bodies }
}

function renderAt(path: string, state?: unknown) {
  const router = createMemoryRouter(
    [
      { path: '/patients/search', element: <PatientSearchPage /> },
      { path: '/patients/new', element: <RegisterPatientPage /> },
      { path: '/patients/:patientId', element: <PatientPage /> },
    ],
    { initialEntries: [{ pathname: path, state }] },
  )
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  )
  return router
}

beforeEach(() => setCsrfToken('tok'))
afterEach(() => {
  setCsrfToken(null)
  vi.unstubAllGlobals()
})

describe('criteriaProblem', () => {
  const form = { family: '', given: '', birthDate: '', phone: '', mrn: '' }
  it('accepts one exact identifier or two criteria', () => {
    expect(criteriaProblem({ ...form, mrn: 'SH-1' })).toBeNull()
    expect(criteriaProblem({ ...form, phone: '+16175550123' })).toBeNull()
    expect(criteriaProblem({ ...form, family: 'Te', birthDate: '1984-07-19' })).toBeNull()
  })
  it('refuses one name alone, a one-letter last name and half-typed values', () => {
    expect(criteriaProblem({ ...form, family: 'Testperson' })).toMatch(/two of/)
    expect(criteriaProblem({ ...form, family: 'T', given: 'Ana' })).toMatch(/2 letters/)
    expect(criteriaProblem({ ...form, birthDate: null })).toMatch(/MM\/DD\/YYYY/)
    expect(criteriaProblem({ ...form, phone: null })).toMatch(/10-digit/)
  })
})

describe('PatientSearchPage', () => {
  it('checks the criteria before calling the server', async () => {
    const user = userEvent.setup()
    serve({})
    renderAt('/patients/search')
    await user.type(screen.getByLabelText('Last name'), 'Testperson')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(screen.getByRole('alert')).toHaveTextContent('two of: last name, first name, date of birth')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends criteria in the body, lists results with masked phones and loads more', async () => {
    const user = userEvent.setup()
    const server = serve({
      'POST /api/v1/patients/search': [() => json(200, { items: [summary(1), summary(2)], nextCursor: 'c2' }), () => json(200, { items: [summary(3)] })],
    })
    renderAt('/patients/search')
    await user.type(screen.getByLabelText('Last name'), 'Testperson')
    await user.type(screen.getByLabelText(/Date of birth/), '07/19/1984')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    const table = await screen.findByRole('table', { name: /Search results: 2\+ patients/ })
    expect(within(table).getByRole('link', { name: 'Testperson1, Ana' })).toHaveAttribute('href', '/patients/00000000-0000-4000-8000-000000000001')
    expect(within(table).getAllByText('Restricted')).toHaveLength(1)
    expect(within(table).getAllByText('(•••) •••-0123')).toHaveLength(2)
    expect(await axeViolations()).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('table', { name: 'Search results: 3 patients' })).toBeInTheDocument()
    const [first, second] = server.bodies('POST /api/v1/patients/search')
    expect(first?.body).toEqual({ criteria: { family: 'Testperson', birthDate: '1984-07-19' }, limit: 25 })
    expect(second?.body).toEqual({ criteria: { family: 'Testperson', birthDate: '1984-07-19' }, limit: 25, cursor: 'c2' })
  })

  it('shows a refused search in plain words', async () => {
    const user = userEvent.setup()
    serve({ 'POST /api/v1/patients/search': [() => problem(422, 'business-rule-violation', { requestId: 'r-1' })] })
    renderAt('/patients/search')
    await user.type(screen.getByLabelText('MRN'), 'SH-1')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('Reference: r-1')).toBeInTheDocument()
  })

  it('carries the typed name and date of birth to registration in router state, not the URL', async () => {
    const user = userEvent.setup()
    serve({})
    const router = renderAt('/patients/search')
    await user.type(screen.getByLabelText('Last name'), 'Testperson')
    await user.type(screen.getByLabelText(/Date of birth/), '07/19/1984')
    await user.click(screen.getByRole('button', { name: 'Register new patient' }))
    expect(router.state.location.pathname).toBe('/patients/new')
    expect(router.state.location.search).toBe('')
    expect(screen.getByLabelText(/Last name/)).toHaveValue('Testperson')
    expect(screen.getByLabelText(/Date of birth/)).toHaveValue('07/19/1984')
  })
})

describe('RegisterPatientPage', () => {
  async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/First name/), 'Ana')
    await user.type(screen.getByLabelText(/Last name/), 'Testperson')
    await user.type(screen.getByLabelText(/Date of birth/), '07/19/1984')
  }

  it('requires name and date of birth before sending', async () => {
    const user = userEvent.setup()
    serve({})
    renderAt('/patients/new')
    await user.click(screen.getByRole('button', { name: 'Register patient' }))
    expect(screen.getByLabelText(/First name/)).toBeInvalid()
    expect(screen.getByLabelText(/Last name/)).toBeInvalid()
    expect(screen.getByLabelText(/Date of birth/)).toBeInvalid()
    expect(fetch).not.toHaveBeenCalled()
    expect(await axeViolations()).toEqual([])
  })

  it('registers with an Idempotency-Key and opens the new chart', async () => {
    const user = userEvent.setup()
    const server = serve({
      'POST /api/v1/patients': [() => json(201, patient)],
      [`GET /api/v1/patients/${patient.id}`]: [() => json(200, patient)],
    })
    const router = renderAt('/patients/new')
    await fillRequired(user)
    await user.type(screen.getByLabelText('Mobile phone'), '6175550123')
    await user.click(screen.getByRole('button', { name: 'Register patient' }))

    expect(await screen.findByRole('heading', { name: 'Ana Testperson' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(`/patients/${patient.id}`)
    expect(screen.getByText('Patient registered. MRN SH-2001')).toBeInTheDocument()
    const [sent] = server.bodies('POST /api/v1/patients')
    expect(sent?.body).toEqual({
      name: { given: ['Ana'], family: 'Testperson' },
      birthDate: '1984-07-19',
      phones: [{ number: '+16175550123', use: 'mobile' }],
    })
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('warns of a possible duplicate and registers anyway only with a reason, under a new key', async () => {
    const user = userEvent.setup()
    const server = serve({
      'POST /api/v1/patients': [() => problem(409, 'possible-duplicate'), () => json(201, patient)],
      [`GET /api/v1/patients/${patient.id}`]: [() => json(200, patient)],
    })
    renderAt('/patients/new')
    await fillRequired(user)
    await user.click(screen.getByRole('button', { name: 'Register patient' }))

    expect(await screen.findByText('This patient may already be registered')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Search for the patient' })).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Register anyway' }))
    expect(screen.getByText('Explain why this is a different patient.')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/Reason to register anyway/), 'Twin of the existing patient')
    await user.click(screen.getByRole('button', { name: 'Register anyway' }))
    expect(await screen.findByRole('heading', { name: 'Ana Testperson' })).toBeInTheDocument()

    const [first, second] = server.bodies('POST /api/v1/patients')
    expect(first?.body.duplicateCheck).toBeUndefined()
    expect(second?.body).toMatchObject({ duplicateCheck: 'override', duplicateOverrideReason: 'Twin of the existing patient' })
    expect(second?.headers.get('Idempotency-Key')).not.toBe(first?.headers.get('Idempotency-Key'))
  })

  it('names the field a 422 points at', async () => {
    const user = userEvent.setup()
    serve({
      'POST /api/v1/patients': [() => problem(422, 'validation-failed', { errors: [{ in: 'body', pointer: '/birthDate', code: 'invalid-format' }] })],
    })
    renderAt('/patients/new')
    await fillRequired(user)
    await user.click(screen.getByRole('button', { name: 'Register patient' }))
    expect(await screen.findByText('Date of birth:')).toBeInTheDocument()
    expect(screen.getByLabelText(/Date of birth/)).toBeInvalid()
  })
})

describe('PatientPage', () => {
  it('shows demographics', async () => {
    serve({ [`GET /api/v1/patients/${patient.id}`]: [() => json(200, { ...patient, phones: [{ number: '+16175550123' }] })] })
    renderAt(`/patients/${patient.id}`)
    expect(await screen.findByRole('heading', { name: 'Ana Testperson' })).toBeInTheDocument()
    expect(screen.getByText('SH-2001')).toBeInTheDocument()
    expect(screen.getByText('(617) 555-0123')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('shows a refused read in plain words', async () => {
    serve({ [`GET /api/v1/patients/${patient.id}`]: [() => problem(404, 'not-found', { requestId: 'r-9' })] })
    renderAt(`/patients/${patient.id}`)
    expect(await screen.findByText('Reference: r-9')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to patient search' })).toBeInTheDocument()
  })
})

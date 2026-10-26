import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '../../../api/client'
import { ToastProvider } from '../../../design-system'
import { axeViolations } from '../../../test/axe'
import { json, problem, serve } from '../../../test/fakeServer'
import { validate } from './AddCoverageDialog'
import { InsurancePanel } from './InsurancePanel'

// Synthetic data only.
const patientId = '00000000-0000-4000-8000-0000000000aa'
const LIST = `GET /api/v1/patients/${patientId}/coverages?limit=9`
const ADD = `POST /api/v1/patients/${patientId}/coverages`

const coverage = (n: number, extra: object = {}) => ({
  id: `00000000-0000-4000-8000-0000000001a${n}`,
  patientId,
  order: n,
  payerId: `00000000-0000-4000-8000-0000000002a${n}`,
  payerName: `Test Health Plan ${n}`,
  memberId: `TST${n}0001`,
  groupNumber: 'GRP-100',
  relationshipToSubscriber: 'self',
  status: 'active',
  createdAt: '2026-10-24T12:00:00Z',
  updatedAt: '2026-10-24T12:00:00Z',
  ...extra,
})

const payer = { id: '00000000-0000-4000-8000-0000000002b1', name: 'Test Mutual Insurance', payerType: 'commercial', state: 'IL', active: true }

function renderPanel() {
  render(
    <ToastProvider>
      <InsurancePanel patientId={patientId} />
    </ToastProvider>,
  )
}

beforeEach(() => setCsrfToken('tok'))
afterEach(() => {
  setCsrfToken(null)
  vi.unstubAllGlobals()
})

describe('InsurancePanel', () => {
  it('lists coverages by priority with their status', async () => {
    serve({
      [LIST]: [
        () =>
          json(200, {
            items: [
              coverage(1),
              coverage(2, { endDate: '2020-12-31' }),
              coverage(3, { status: 'entered-in-error' }),
            ],
          }),
      ],
    })
    renderPanel()
    const table = await screen.findByRole('table', { name: 'Insurance coverages' })
    const rows = within(table).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('PrimaryTest Health Plan 1TST10001GRP-100Self—ActiveMark as error')
    expect(rows[2]).toHaveTextContent('Ended')
    expect(rows[3]).toHaveTextContent('Entered in error')
    // A corrected coverage has no further action.
    expect(within(rows[3]!).queryByRole('button')).not.toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('shows an empty state for self-pay', async () => {
    serve({ [LIST]: [() => json(200, { items: [] })] })
    renderPanel()
    expect(await screen.findByText('No insurance on file')).toBeInTheDocument()
  })

  it('adds a coverage from the payer directory with an Idempotency-Key, as the next priority', async () => {
    const user = userEvent.setup()
    const server = serve({
      [LIST]: [() => json(200, { items: [coverage(1)] }), () => json(200, { items: [coverage(1), coverage(2)] })],
      'GET /api/v1/payers?payerName=Test+Mutual&active=true&limit=25': [() => json(200, { items: [payer] })],
      [ADD]: [() => json(201, coverage(2))],
    })
    renderPanel()
    await screen.findByRole('table', { name: 'Insurance coverages' })
    await user.click(screen.getByRole('button', { name: 'Add insurance' }))
    const dialog = screen.getByRole('dialog', { name: 'Add insurance' })

    await user.type(within(dialog).getByLabelText(/^Insurance company/), 'Test Mutual')
    await user.click(within(dialog).getByRole('button', { name: 'Find' }))
    // One match is chosen for the user.
    expect(await within(dialog).findByLabelText(/Choose the insurance company/)).toHaveValue(payer.id)
    expect(within(dialog).getByLabelText('Priority')).toHaveValue('2')
    await user.type(within(dialog).getByLabelText(/Member ID/), 'TST20001')
    await user.type(within(dialog).getByLabelText(/Start date/), '01/01/2026')
    expect(await axeViolations()).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Add insurance' }))

    expect(await screen.findByText('Insurance added')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const [sent] = server.bodies(ADD)
    expect(sent?.body).toEqual({ order: 2, payerId: payer.id, memberId: 'TST20001', relationshipToSubscriber: 'self', startDate: '2026-01-01' })
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(await screen.findByText('Test Health Plan 2')).toBeInTheDocument()
  })

  it('needs a subscriber from the related persons when the patient is not the subscriber', async () => {
    const user = userEvent.setup()
    serve({
      [LIST]: [() => json(200, { items: [] })],
      [`GET /api/v1/patients/${patientId}/related-persons?limit=50`]: [() => json(200, { items: [] })],
    })
    renderPanel()
    await screen.findByText('No insurance on file')
    await user.click(screen.getByRole('button', { name: 'Add insurance' }))
    await user.selectOptions(screen.getByLabelText('Patient is the subscriber’s'), 'child')
    expect(await screen.findByText('No related persons on file')).toBeInTheDocument()
  })

  it('marks a coverage entered in error only with a reason', async () => {
    const user = userEvent.setup()
    const MARK = `POST /api/v1/patients/${patientId}/coverages/${coverage(1).id}/entered-in-error`
    const server = serve({
      [LIST]: [() => json(200, { items: [coverage(1)] }), () => json(200, { items: [coverage(1, { status: 'entered-in-error' })] })],
      [MARK]: [() => json(200, coverage(1, { status: 'entered-in-error' }))],
    })
    renderPanel()
    await screen.findByRole('table', { name: 'Insurance coverages' })
    await user.click(screen.getByRole('button', { name: 'Mark Test Health Plan 1 entered in error' }))
    const dialog = screen.getByRole('dialog', { name: 'Mark this coverage entered in error?' })
    await user.click(within(dialog).getByRole('button', { name: 'Mark entered in error' }))
    expect(within(dialog).getByText('Explain what was wrong with this coverage.')).toBeInTheDocument()
    expect(server.bodies(MARK)).toHaveLength(0)

    await user.type(within(dialog).getByLabelText(/Reason/), 'Duplicate entry')
    await user.click(within(dialog).getByRole('button', { name: 'Mark entered in error' }))
    expect(await screen.findByText('Coverage marked entered in error')).toBeInTheDocument()
    expect(server.bodies(MARK)[0]?.body).toEqual({ reason: 'Duplicate entry' })
    expect(await screen.findByText('Entered in error')).toBeInTheDocument()
  })

  it('shows a refused add in plain words, naming the field', async () => {
    const user = userEvent.setup()
    serve({
      [LIST]: [() => json(200, { items: [] })],
      'GET /api/v1/payers?payerName=Test+Mutual&active=true&limit=25': [() => json(200, { items: [payer] })],
      [ADD]: [() => problem(422, 'validation-failed', { errors: [{ in: 'body', pointer: '/memberId', code: 'too-long' }] })],
    })
    renderPanel()
    await screen.findByText('No insurance on file')
    await user.click(screen.getByRole('button', { name: 'Add insurance' }))
    await user.type(screen.getByLabelText(/^Insurance company/), 'Test Mutual')
    await user.click(screen.getByRole('button', { name: 'Find' }))
    await screen.findByLabelText(/Choose the insurance company/)
    await user.type(screen.getByLabelText(/Member ID/), 'X')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add insurance' }))
    expect(await screen.findByText('Member ID:')).toBeInTheDocument()
  })
})

describe('validate', () => {
  const form = {
    payerQuery: '',
    payerId: 'p',
    memberId: 'm',
    groupNumber: '',
    groupName: '',
    planName: '',
    relationship: 'self' as const,
    subscriberRelatedPersonId: '',
    subscriberId: '',
    startDate: '',
    endDate: '',
    order: 1,
  }
  it('needs a payer, a member ID, real dates in order, and a subscriber unless self', () => {
    expect(validate(form)).toEqual({})
    expect(validate({ ...form, payerId: '', memberId: ' ' })).toMatchObject({ payerId: expect.any(String), memberId: expect.any(String) })
    expect(validate({ ...form, relationship: 'spouse' as never })).toHaveProperty('subscriberRelatedPersonId')
    expect(validate({ ...form, startDate: '2026-02-01', endDate: '2026-01-01' })).toHaveProperty('endDate')
    expect(validate({ ...form, startDate: null })).toHaveProperty('startDate')
  })
})

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '../../api/client'
import type { Encounter } from '../../api/generated/model'
import { ToastProvider } from '../../design-system'
import { axeViolations } from '../../test/axe'
import { json, problem, serve } from '../../test/fakeServer'
import { PrescriptionsSection } from './PrescriptionsSection'

// Synthetic data only.
const TZ = 'America/Chicago'
const patientId = '00000000-0000-4000-8000-0000000009aa'
const encounterId = '00000000-0000-4000-8000-0000000009e1'
const rxId = '00000000-0000-4000-8000-0000000009b1'
const alertId = '00000000-0000-4000-8000-0000000009c1'
const pharmacy = { id: '00000000-0000-4000-8000-0000000009d1', name: 'Test Pharmacy Main Street' }
const at = '2026-11-20T15:00:00Z'
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm'
const amoxicillin = { system: RXNORM, code: '308182', display: 'Amoxicillin 500 MG Oral Capsule' }

const encounter = {
  id: encounterId,
  patientId,
  status: 'in-progress',
  class: 'AMB',
  facilityId: '00000000-0000-4000-8000-0000000009f9',
  timeZone: TZ,
  participants: [],
  diagnoses: [],
  vitals: [],
  notes: [],
  createdAt: at,
  updatedAt: at,
} as unknown as Encounter

const draft = (extra: object = {}) => ({
  id: rxId,
  patientId,
  encounterId,
  status: 'draft',
  medication: { codings: [amoxicillin], text: amoxicillin.display },
  dosageText: 'Take 1 capsule by mouth three times a day.',
  quantity: { value: 30, unit: 'capsule' },
  daysSupply: 10,
  refills: 0,
  substitutionAllowed: true,
  pharmacyId: pharmacy.id,
  transmission: { status: 'not-sent' },
  alerts: [],
  createdAt: at,
  updatedAt: at,
  ...extra,
})
const highAlert = (extra: object = {}) => ({ id: alertId, kind: 'allergy', severity: 'high', message: 'Active allergy to penicillins.', overrideRequired: true, ...extra })
const checked = (alerts: object[] = [highAlert()]) => draft({ safetyCheckedAt: at, alerts })

const withEtag = (body: unknown, etag: string, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ETag: etag } })

const PATIENT = `GET /api/v1/patients/${patientId}`
const CODES = 'GET /api/v1/codes?system=rxnorm&q=amox&limit=10'
const CREATE = 'POST /api/v1/prescriptions'
const GET = `GET /api/v1/prescriptions/${rxId}`
const CHECK = `POST /api/v1/prescriptions/${rxId}/safety-check`
const OVERRIDE = `POST /api/v1/alerts/${alertId}/override`
const SIGN = `POST /api/v1/prescriptions/${rxId}/sign-and-send`
const DISCARD = `POST /api/v1/prescriptions/${rxId}/entered-in-error`
const STORAGE = `shri.visit-prescriptions.${encounterId}`

const patient = (extra: object = {}) => json(200, { id: patientId, name: { family: 'Testperson', given: ['Cy'] }, birthDate: '1970-01-15', mrn: 'TST-3001', preferredPharmacy: pharmacy, ...extra })

/** The headers of each call to `key` (sign-and-send has no body, so `serve().bodies()` can't read it). */
function headersOf(key: string): Headers[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}` === key)
    .map(([, init]) => new Headers(init?.headers))
}

function renderSection(open = true) {
  render(
    <ToastProvider>
      <PrescriptionsSection encounter={encounter} open={open} />
    </ToastProvider>,
  )
}

beforeEach(() => {
  setCsrfToken('tok')
  sessionStorage.clear()
})
afterEach(() => {
  setCsrfToken(null)
  vi.unstubAllGlobals()
})

describe('PrescriptionsSection', () => {
  it('writes an RxNorm draft for the preferred pharmacy, checks it, needs an override for a high alert, then signs and sends', async () => {
    const user = userEvent.setup()
    const server = serve({
      [PATIENT]: [() => patient()],
      [CODES]: [() => json(200, { items: [{ ...amoxicillin, drug: { strength: '500 MG', doseForm: 'Oral Capsule', route: 'Oral', ingredients: [{ rxcui: '723', name: 'Amoxicillin' }] } }] })],
      [CREATE]: [() => withEtag(draft(), '"p1"', 201)],
      [CHECK]: [() => json(200, { prescriptionId: rxId, checkedAt: at, alerts: [highAlert()] })],
      [GET]: [() => withEtag(checked(), '"p1"'), () => withEtag(checked([highAlert({ override: { reason: 'Tolerated amoxicillin last year.', overriddenBy: patientId, overriddenAt: at } })]), '"p1"')],
      [OVERRIDE]: [() => json(200, highAlert({ override: { reason: 'Tolerated amoxicillin last year.', overriddenBy: patientId, overriddenAt: at } }))],
      [SIGN]: [() => withEtag(draft({ status: 'active', signedAt: at, safetyCheckedAt: at, transmission: { status: 'queued' }, alerts: [highAlert({ override: { reason: 'Tolerated amoxicillin last year.', overriddenBy: patientId, overriddenAt: at } })] }), '"p2"')],
    })
    renderSection()
    expect(await screen.findByText('Test Pharmacy Main Street')).toBeInTheDocument()
    expect(screen.getByText('(the patient’s preferred pharmacy)')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])

    await user.type(screen.getByRole('textbox', { name: /^Drug/ }), 'amox')
    await user.click(screen.getByRole('button', { name: 'Search drugs for drug' }))
    expect(await screen.findByRole('combobox', { name: 'RxNorm match' })).toHaveDisplayValue('Amoxicillin 500 MG Oral Capsule')
    expect(screen.getByText('500 MG · Oral Capsule · Oral')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /^Unit/ })).toHaveValue('capsule')
    await user.type(screen.getByRole('textbox', { name: /^Directions/ }), 'Take 1 capsule by mouth three times a day.')
    await user.type(screen.getByRole('textbox', { name: 'Quantity' }), '30')
    await user.type(screen.getByRole('textbox', { name: /^Days supply/ }), '10')
    await user.click(screen.getByRole('button', { name: 'Save draft and check safety' }))

    const card = await screen.findByRole('article', { name: amoxicillin.display })
    const [sent] = server.bodies(CREATE)
    expect(sent?.body).toEqual({
      patientId,
      encounterId,
      medication: { codings: [amoxicillin], text: amoxicillin.display },
      dosageText: 'Take 1 capsule by mouth three times a day.',
      quantity: { value: 30, unit: 'capsule' },
      daysSupply: 10,
      refills: 0,
      substitutionAllowed: true,
      pharmacyId: pharmacy.id,
    })
    expect(sent?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(sessionStorage.getItem(STORAGE) ?? '[]')).toEqual([rxId])

    // The safety check runs on its own; a high alert blocks signing until it's overridden with a reason.
    expect(await within(card).findByText('Active allergy to penicillins.')).toBeInTheDocument()
    expect(server.calls()).toContain(CHECK)
    const signButton = within(card).getByRole('button', { name: 'Sign and send' })
    expect(signButton).toBeDisabled()
    await user.click(within(card).getByRole('button', { name: 'Override alert' }))
    expect(within(card).getByText('Give the reason for going ahead.')).toBeInTheDocument()
    expect(server.calls()).not.toContain(OVERRIDE)
    await user.type(within(card).getByRole('textbox', { name: /^Reason to go ahead/ }), 'Tolerated amoxicillin last year.')
    await user.click(within(card).getByRole('button', { name: 'Override alert' }))
    expect(await within(card).findByText('Overridden: Tolerated amoxicillin last year.')).toBeInTheDocument()
    expect(server.bodies(OVERRIDE)[0]?.body).toEqual({ reason: 'Tolerated amoxicillin last year.' })

    await user.click(within(card).getByRole('button', { name: 'Sign and send' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sign and send this prescription?' })
    expect(dialog).toHaveTextContent('goes to Test Pharmacy Main Street')
    await user.click(within(dialog).getByRole('button', { name: 'Sign and send' }))
    expect(await within(card).findByText('Queued for the pharmacy')).toBeInTheDocument()
    expect(within(card).getByText('Signed')).toBeInTheDocument()
    const [signed] = headersOf(SIGN)
    expect(signed?.get('If-Match')).toBe('"p1"')
    expect(signed?.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(within(card).getByRole('button', { name: 'Refresh status' })).toBeInTheDocument()
  })

  it('checks the form before sending anything, including the pharmacy when there is no preferred one', async () => {
    const user = userEvent.setup()
    const server = serve({ [PATIENT]: [() => patient({ preferredPharmacy: undefined })] })
    renderSection()
    expect(await screen.findByText('No pharmacy chosen')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save draft and check safety' }))
    expect(screen.getByText('Search for the drug and choose it from the RxNorm matches.')).toBeInTheDocument()
    expect(screen.getByText(/^Write the directions/)).toBeInTheDocument()
    expect(screen.getByText('Enter the amount to dispense.')).toBeInTheDocument()
    expect(screen.getByText('Enter the unit, for example tablet.')).toBeInTheDocument()
    expect(screen.getByText('Choose the pharmacy.')).toBeInTheDocument()
    await user.clear(screen.getByRole('textbox', { name: 'Refills' }))
    await user.type(screen.getByRole('textbox', { name: 'Refills' }), '12')
    await user.click(screen.getByRole('button', { name: 'Save draft and check safety' }))
    expect(screen.getByText('Enter a whole number from 0 to 11.')).toBeInTheDocument()
    expect(server.calls()).not.toContain(CREATE)
  })

  it('keeps a draft across a reload, and explains a sign refusal in plain words', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem(STORAGE, JSON.stringify([rxId]))
    serve({
      [PATIENT]: [() => patient()],
      [GET]: [() => withEtag(checked([highAlert({ severity: 'warning', overrideRequired: false })]), '"p1"')],
      [SIGN]: [
        () =>
          problem(422, 'business-rule-violation', {
            requestId: 'r-31',
            errors: [
              { in: 'body', pointer: '/alerts', code: 'safety-check-stale' },
              { in: 'body', pointer: '/alerts/0', code: 'override-required' },
              { in: 'body', pointer: '/pharmacyId', code: 'required' },
            ],
          }),
      ],
    })
    renderSection(false)
    const card = await screen.findByRole('article', { name: amoxicillin.display })
    // A closed visit shows its prescriptions but takes no new one.
    expect(screen.queryByRole('button', { name: 'Save draft and check safety' })).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Sign and send' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Sign and send this prescription?' })).getByRole('button', { name: 'Sign and send' }))
    const refusal = await within(card).findByRole('alert')
    expect(refusal).toHaveTextContent('Not signed yet')
    expect(refusal).toHaveTextContent('The safety check is out of date for this version. Run it again.')
    expect(refusal).toHaveTextContent('Override each high alert with a reason first.')
    expect(refusal).toHaveTextContent('Add the pharmacy.')
    expect(refusal).toHaveTextContent('Reference: r-31')
  })

  it('treats a draft with no current check as unchecked: no override prompt, no signing, and it runs the check', async () => {
    sessionStorage.setItem(STORAGE, JSON.stringify([rxId]))
    const server = serve({
      [PATIENT]: [() => patient()],
      // Changed after its last check: the old alerts are still stored, `safetyCheckedAt` is gone.
      [GET]: [() => withEtag(draft({ alerts: [highAlert()] }), '"p3"')],
      [CHECK]: [() => json(200, { prescriptionId: rxId, checkedAt: at, alerts: [highAlert()] })],
    })
    renderSection()
    const card = await screen.findByRole('article', { name: amoxicillin.display })
    expect(await within(card).findByText('Not checked on this version yet. Run the safety check to sign.')).toBeInTheDocument()
    expect(within(card).queryByText('Override the high alert to sign.')).not.toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Sign and send' })).toBeDisabled()
    expect(server.calls()).toContain(CHECK)
  })

  it('discards a draft as entered in error with a reason, and forgets it', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem(STORAGE, JSON.stringify([rxId]))
    const server = serve({
      [PATIENT]: [() => patient()],
      [GET]: [() => withEtag(checked([]), '"p1"')],
      [DISCARD]: [() => json(200, draft({ status: 'entered-in-error' }))],
    })
    renderSection()
    const card = await screen.findByRole('article', { name: amoxicillin.display })
    expect(within(card).getByText(/Safety check passed/)).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Discard draft' }))
    const dialog = await screen.findByRole('dialog', { name: 'Discard this draft?' })
    await user.click(within(dialog).getByRole('button', { name: 'Discard draft' }))
    expect(within(dialog).getByText('Give the reason for discarding it.')).toBeInTheDocument()
    await user.type(within(dialog).getByRole('textbox', { name: /^Reason/ }), 'Wrong strength chosen')
    await user.click(within(dialog).getByRole('button', { name: 'Discard draft' }))
    expect(await screen.findByText('No prescriptions started on this visit.')).toBeInTheDocument()
    expect(server.bodies(DISCARD)[0]?.body).toEqual({ reason: 'Wrong strength chosen' })
    expect(JSON.parse(sessionStorage.getItem(STORAGE) ?? '[]')).toEqual([])
  })
})

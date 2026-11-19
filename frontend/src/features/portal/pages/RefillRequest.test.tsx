import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '../../../api/client'
import type { PortalMedication, PortalRefillRequest } from '../../../api/generated/model'
import { axeViolations } from '../../../test/axe'
import { PortalApiContext, type PortalApi } from '../api/portalApi'
import { ClinicZone } from '../clinicZone'
import { latestByPrescription, noRefillReason, requestOutcome, type RequestOutcome } from '../refills'
import { PortalRouter } from '../router'
import { MedicationsPage } from './PrescriptionPages'
import { outcomeText, RefillControl, requestStatusText } from './RefillRequest'

// "Request refill" on the patient portal's Prescriptions page (#415's API). Synthetic medications
// only; the API is a stand-in. The list of the patient's own requests is mocked at the module.

let myRequests: () => Promise<PortalRefillRequest[]> = () => Promise.resolve([])
vi.mock('../refills', async (importOriginal) => {
  const real = await importOriginal<typeof import('../refills')>()
  return { ...real, loadMyRefillRequests: () => myRequests() }
})

const TZ = 'America/Los_Angeles'
const med = (over: Partial<PortalMedication> = {}): PortalMedication => ({
  id: 'b1d0c7a2-1111-4aaa-8bbb-000000000001',
  display: 'lisinopril 10 MG Oral Tablet',
  dosageText: '1 tablet by mouth once daily',
  status: 'active',
  source: 'prescription',
  ...over,
})
const req = (over: Partial<PortalRefillRequest> = {}): PortalRefillRequest => ({
  id: 'rr-1',
  prescriptionId: 'b1d0c7a2-1111-4aaa-8bbb-000000000001',
  display: 'lisinopril 10 MG Oral Tablet',
  status: 'requested',
  // 2026-11-19T17:30Z is 9:30 AM in Los Angeles.
  requestedAt: '2026-11-19T17:30:00Z',
  ...over,
})
const problem = (status: number, code: string, errors?: unknown[]) => new ApiError({ type: 'about:blank', title: code, status, code, ...(errors ? { errors } : {}) } as never)

function control(m: PortalMedication, latest: PortalRefillRequest | undefined, outcome: RequestOutcome | (() => Promise<RequestOutcome>) = { kind: 'done', request: req() }) {
  const calls: Array<[string, string]> = []
  const onChanged = vi.fn()
  render(
    <PortalRouter>
      <RefillControl
        med={m}
        latest={latest}
        timeZone={TZ}
        onChanged={onChanged}
        request={(id, key) => {
          calls.push([id, key])
          return typeof outcome === 'function' ? outcome() : Promise.resolve(outcome)
        }}
      />
    </PortalRouter>,
  )
  return { calls, onChanged }
}

async function askAndConfirm() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Request a refill of/ }))
  })
  const dialog = screen.getByRole('dialog')
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }))
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  myRequests = () => Promise.resolve([])
})

describe('the refill rules', () => {
  it('keeps the latest request per prescription', () => {
    const latest = latestByPrescription([req({ id: 'a', requestedAt: '2026-11-01T00:00:00Z', status: 'declined' }), req({ id: 'b', requestedAt: '2026-11-19T00:00:00Z' })])
    expect(latest.get('b1d0c7a2-1111-4aaa-8bbb-000000000001')?.id).toBe('b')
  })

  it('gives a reason when a medicine has no "Request refill"', () => {
    expect(noRefillReason(med({ source: 'reported' }), undefined, new Set())).toBe('reported')
    expect(noRefillReason(med({ status: 'stopped' }), undefined, new Set())).toBe('not-active')
    expect(noRefillReason(med(), req(), new Set())).toBe('open-request')
    expect(noRefillReason(med(), undefined, new Set([med().id]))).toBe('not-refillable')
    expect(noRefillReason(med(), req({ status: 'declined' }), new Set())).toBeNull()
  })

  it.each([
    [problem(409, 'invalid-state-transition', [{ in: 'body', pointer: '/prescriptionId', code: 'not-refillable' }]), { kind: 'refused', reason: 'not-refillable' }],
    [problem(409, 'invalid-state-transition', [{ in: 'body', pointer: '/prescriptionId', code: 'refill-already-requested' }]), { kind: 'refused', reason: 'refill-already-requested' }],
    [problem(409, 'invalid-state-transition', [{ in: 'body', pointer: '/prescriptionId', code: 'not-active' }]), { kind: 'refused', reason: 'not-active' }],
    [problem(409, 'idempotency-request-in-progress'), { kind: 'refused', reason: 'other' }],
    [problem(403, 'permission-denied'), { kind: 'forbidden' }],
    [problem(404, 'not-found'), { kind: 'not-found' }],
    [problem(412, 'precondition-failed'), { kind: 'stale' }],
    [problem(422, 'validation-failed'), { kind: 'invalid' }],
    [problem(429, 'rate-limited'), { kind: 'rate-limited' }],
    [new Error('offline'), { kind: 'error' }],
  ])('reads %s as %o', (err, outcome) => {
    expect(requestOutcome(err)).toEqual(outcome)
  })

  it('words each status in the clinic’s time, with a decline’s reason as the clinic sent it', () => {
    expect(requestStatusText(req(), TZ)).toBe('Requested 11/19/2026, 9:30 AM PST. Waiting for your clinic.')
    expect(requestStatusText(req({ status: 'approved', respondedAt: '2026-11-19T18:00:00Z' }), TZ)).toBe('Approved by your clinic on 11/19/2026, 10:00 AM PST. Your doctor still needs to sign the prescription before it goes to your pharmacy.')
    expect(requestStatusText(req({ status: 'declined', respondedAt: '2026-11-19T18:00:00Z', declineReason: 'Please book a visit so your clinician can review this medicine.' }), TZ)).toBe(
      'Declined 11/19/2026, 10:00 AM PST. Please book a visit so your clinician can review this medicine.',
    )
  })
})

describe('Request refill under a medicine', () => {
  it('asks only after the confirmation, sends the prescription with a key, and moves focus to the result', async () => {
    const { calls, onChanged } = control(med(), undefined)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Request a refill of lisinopril 10 MG Oral Tablet' }))
    })
    expect(calls).toEqual([])
    expect(within(screen.getByRole('dialog')).getByText(/Ask your clinic to refill/)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send request' }))
    })
    expect(calls[0]?.[0]).toBe(med().id)
    expect(calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/)
    expect(onChanged).toHaveBeenCalledOnce()
    expect(screen.getByText('Refill requested')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Request a refill of/ })).toBeNull()
    const result = screen.getByText(/Your clinic will review it/)
    await waitFor(() => expect(document.activeElement?.contains(result)).toBe(true))
    expect(await axeViolations()).toEqual([])
  })

  it('makes no request when the confirmation is cancelled', async () => {
    const { calls } = control(med(), undefined)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Request a refill of/ }))
    })
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    })
    expect(calls).toEqual([])
  })

  it('shows an open request’s status and no button', () => {
    control(med(), req())
    expect(screen.getByText('Refill requested')).toBeInTheDocument()
    expect(screen.getByText('Requested 11/19/2026, 9:30 AM PST. Waiting for your clinic.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Request a refill of/ })).toBeNull()
  })

  it('shows a declined request’s reason, and lets the patient ask again', () => {
    control(med(), req({ status: 'declined', respondedAt: '2026-11-19T18:00:00Z', declineReason: 'Please contact the office about this request.' }))
    expect(screen.getByText(/Please contact the office about this request\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Request a refill of/ })).toBeInTheDocument()
  })

  it.each([
    [med({ source: 'reported' }), 'Refills for medicines you reported come from the clinic that prescribed them.'],
    [med({ status: 'stopped' }), 'Only current medicines can be refilled here.'],
  ])('says why there is no button for %o', (m, text) => {
    control(m, undefined)
    expect(screen.getByText(text)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Request a refill of/ })).toBeNull()
  })

  it('replaces the button with the reason when the API says the medicine can’t be refilled online', async () => {
    control(med(), undefined, { kind: 'refused', reason: 'not-refillable' })
    await askAndConfirm()
    expect(screen.getAllByText("This medicine can't be refilled online. Call your clinic.").length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /Request a refill of/ })).toBeNull()
  })

  it.each([
    [{ kind: 'refused', reason: 'refill-already-requested' } as const, 'A refill is already requested for this medicine.', true],
    [{ kind: 'refused', reason: 'not-active' } as const, "This medicine isn't current anymore, so it can't be refilled here.", false],
    [{ kind: 'forbidden' } as const, "Your account can't request refills. Call your clinic.", false],
    [{ kind: 'not-found' } as const, "That medicine isn't on your record anymore. Refresh the page to see your current list.", false],
    [{ kind: 'stale' } as const, 'Your medicines changed. The page has been updated; try again.', true],
    [{ kind: 'invalid' } as const, "That request couldn't be sent. Try again, or call your clinic.", false],
    [{ kind: 'rate-limited' } as const, 'Too many requests. Wait a few minutes, then try again.', false],
    [{ kind: 'error' } as const, "We couldn't send your request. Check your connection, then try again.", false],
  ])('says so for %o, and reads the requests again only when they changed', async (outcome, text, reload) => {
    expect(outcomeText(outcome).text).toBe(text)
    const { onChanged } = control(med(), undefined, outcome)
    await askAndConfirm()
    expect(screen.getByText(text)).toBeInTheDocument()
    expect(onChanged).toHaveBeenCalledTimes(reload ? 1 : 0)
  })

  it('reuses the same Idempotency-Key when the same request is retried after a failure', async () => {
    const { calls } = control(med(), undefined, { kind: 'error' })
    await askAndConfirm()
    await askAndConfirm()
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[1]).toBe(calls[1]?.[1])
  })
})

describe('the Prescriptions page', () => {
  function page() {
    const api = {
      listMedications: () => Promise.resolve([med()]),
      listBookingFacilities: () => Promise.resolve([{ timeZone: TZ }]),
    } as unknown as PortalApi
    render(
      <PortalApiContext.Provider value={api}>
        <PortalRouter>
          <ClinicZone>
            <MedicationsPage />
          </ClinicZone>
        </PortalRouter>
      </PortalApiContext.Provider>,
    )
  }

  it('has no refill button and keeps today’s wording with the switch off', async () => {
    page()
    await screen.findByRole('list', { name: 'Your medications' })
    expect(screen.getByText('To request a refill, contact your clinic.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Request a refill of/ })).toBeNull()
  })

  it('offers "Request refill" with the switch on, once the requests are read', async () => {
    vi.stubEnv('VITE_FEATURE_REFILL_REQUESTS', 'on')
    page()
    expect(await screen.findByRole('button', { name: 'Request a refill of lisinopril 10 MG Oral Tablet' })).toBeInTheDocument()
    expect(screen.getByText('Ask your clinic to refill a current prescription, or contact your clinic.')).toBeInTheDocument()
  })

  it('says so, with Try again, when the requests can’t be read, and offers no button', async () => {
    vi.stubEnv('VITE_FEATURE_REFILL_REQUESTS', 'on')
    myRequests = () => Promise.reject(problem(500, 'internal-error'))
    page()
    expect(await screen.findByText("We couldn't read your refill requests.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Request a refill of/ })).toBeNull()
  })

  it('says the account can’t see them on a 403', async () => {
    vi.stubEnv('VITE_FEATURE_REFILL_REQUESTS', 'on')
    myRequests = () => Promise.reject(problem(403, 'permission-denied'))
    page()
    expect(await screen.findByText("Your account can't see refill requests. Contact your clinic for a refill.")).toBeInTheDocument()
  })
})

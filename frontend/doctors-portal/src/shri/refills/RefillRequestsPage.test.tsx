import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axeViolations } from '../../../../src/test/axe'
import { setFacilityTimeZone } from '../../../shri-health/format'
import type { DecisionOutcome, RefillRow } from '../../../shri-health/refills'
import { RefillRequestsPage } from './RefillRequestsPage'

// Refill requests (#415's API) for the doctor: the list, approve after a confirmation, decline
// with a fixed reason, and every answer. The data layer is passed in; synthetic patients only.

const OPEN: RefillRow = {
  id: 'rr1',
  patientId: 'p1',
  patientName: 'Example Patient',
  mrn: 'RFM-000099',
  drug: 'omeprazole 20 MG Delayed Release Oral Capsule',
  directions: '1 capsule by mouth daily',
  note: 'Down to my last week.',
  requestedAt: '2026-11-19T17:30:00Z',
  restricted: false,
}
const SEALED: RefillRow = { id: 'rr2', patientId: 'p2', requestedAt: '2026-11-19T16:00:00Z', restricted: true }

function data(rows: RefillRow[] | (() => Promise<RefillRow[]>), outcome: DecisionOutcome = { kind: 'done' }) {
  const calls = { load: 0, respond: [] as Array<[string, unknown, string]> }
  return {
    calls,
    load: () => {
      calls.load += 1
      return typeof rows === 'function' ? rows() : Promise.resolve(rows)
    },
    respond: (id: string, decision: unknown, key: string) => {
      calls.respond.push([id, decision, key])
      return Promise.resolve(outcome)
    },
  }
}

async function open(d: ReturnType<typeof data>) {
  await act(async () => {
    render(
      <MemoryRouter>
        <RefillRequestsPage load={d.load} respond={d.respond as never} />
      </MemoryRouter>,
    )
  })
}

async function press(name: string | RegExp, within_?: HTMLElement) {
  await act(async () => {
    fireEvent.click((within_ ? within(within_) : screen).getByRole('button', { name }))
  })
}

const dialog = () => screen.getByRole('alertdialog')

beforeEach(() => {
  setFacilityTimeZone('America/Los_Angeles')
  // jsdom has no ResizeObserver or matchMedia, which the dialog reads (its size, reduced motion, phone layout).
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the list', () => {
  it('shows each request with the drug, directions, patient, MRN, note and the time in the clinic’s zone', async () => {
    await open(data([OPEN]))
    expect(screen.getByText('omeprazole 20 MG Delayed Release Oral Capsule')).toBeTruthy()
    expect(screen.getByText('1 capsule by mouth daily')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Example Patient' }).getAttribute('href')).toBe('/patient/p1')
    expect(screen.getByText(/RFM-000099/)).toBeTruthy()
    expect(screen.getByText('Patient’s note: Down to my last week.')).toBeTruthy()
    // 17:30 UTC on Nov 19 is 9:30 AM in Los Angeles.
    expect(screen.getByText('Requested Nov 19, 2026, 9:30 AM')).toBeTruthy()
    expect(await axeViolations()).toEqual([])
  })

  it('shows a restricted chart as "Restricted chart", with no details and no Approve or Decline', async () => {
    await open(data([SEALED]))
    expect(screen.getByText('Restricted chart')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open the chart' }).getAttribute('href')).toBe('/patient/p2')
    expect(screen.queryByRole('button', { name: /Approve|Decline/ })).toBeNull()
  })

  it('says "Reading the refill requests…" while it reads', async () => {
    await open(data(() => new Promise<RefillRow[]>(() => undefined)))
    expect(screen.getByText('Reading the refill requests…')).toBeTruthy()
  })

  it('says so when nothing is waiting', async () => {
    await open(data([]))
    expect(screen.getByText('No refill requests are waiting.')).toBeTruthy()
  })

  it.each([
    [{ status: 403, code: 'permission-denied' }, "Your account can't see refill requests.", false],
    [{ status: 429, code: 'rate-limited' }, 'Too many reads. Wait a few minutes, then try again.', true],
    [{ status: 500, code: 'internal-error' }, "Couldn't read the refill requests.", true],
  ])('says so for a %o list, with Try again where it helps', async (p, text, retry) => {
    const { ApiError } = await import('../../../../src/api/client')
    const d = data(() => Promise.reject(new ApiError({ type: 'about:blank', title: p.code, ...p } as never, new Headers())))
    await open(d)
    expect(screen.getByText(text)).toBeTruthy()
    expect(Boolean(screen.queryByRole('button', { name: 'Try again' }))).toBe(retry)
    if (retry) {
      await press('Try again')
      expect(d.calls.load).toBe(2)
    }
  })
})

describe('approving and declining', () => {
  it('approves only after the confirmation, removes the request and moves focus to the result', async () => {
    const d = data([OPEN])
    await open(d)
    await press(/Approve the refill of omeprazole/)
    expect(d.calls.respond).toEqual([])
    expect(within(dialog()).getByText('Approve this refill?')).toBeTruthy()
    await press('Approve', dialog())
    expect(d.calls.respond.map(([id, decision]) => [id, decision])).toEqual([['rr1', { approve: true }]])
    expect(d.calls.respond[0][2]).toMatch(/^[0-9a-f-]{36}$/)
    await waitFor(() => expect(screen.queryByText('omeprazole 20 MG Delayed Release Oral Capsule')).toBeNull())
    const result = screen.getByText(/Approved\. A draft prescription of omeprazole/)
    await waitFor(() => expect(document.activeElement?.contains(result)).toBe(true))
  })

  it('declines only with a reason, and sends its code', async () => {
    const d = data([OPEN])
    await open(d)
    await press(/Decline the refill of omeprazole/)
    await press('Decline', dialog())
    expect(d.calls.respond).toEqual([])
    expect(within(dialog()).getByText('Choose a reason.')).toBeTruthy()
    expect(document.activeElement?.id).toBe('refill-decline-reason')
    fireEvent.change(within(dialog()).getByLabelText(/Reason/), { target: { value: 'needs-lab-work' } })
    await press('Decline', dialog())
    expect(d.calls.respond.map(([id, decision]) => [id, decision])).toEqual([['rr1', { decline: 'needs-lab-work' }]])
    expect(screen.getByText(/Declined\. Example Patient will see the reason/)).toBeTruthy()
  })

  it('reuses the same Idempotency-Key when the same decision is retried after a failure', async () => {
    const d = data([OPEN], { kind: 'error' })
    await open(d)
    for (let i = 0; i < 2; i += 1) {
      await press(/Approve the refill of omeprazole/)
      await press('Approve', dialog())
    }
    expect(d.calls.respond).toHaveLength(2)
    expect(d.calls.respond[0][2]).toBe(d.calls.respond[1][2])
  })

  it.each([
    [{ kind: 'restricted' } as const, "Restricted chart: open the patient's chart with break-glass access to answer this request.", false],
    [{ kind: 'forbidden' } as const, 'Only physicians and advanced practice providers can approve or decline refills.', false],
    [{ kind: 'not-found' } as const, 'That request no longer exists. The list has been updated.', true],
    [{ kind: 'conflict' } as const, 'That request was already answered. The list has been updated.', true],
    [{ kind: 'stale' } as const, 'That request changed after the list was read. The list has been updated; check it and try again.', true],
    [{ kind: 'invalid' } as const, "That decision couldn't be saved as sent. Check the reason and try again.", false],
    [{ kind: 'rate-limited' } as const, 'Too many actions. Wait a few minutes, then try again.', false],
    [{ kind: 'error' } as const, "Couldn't save the decision. Check your connection, then try again.", false],
  ])('says so for %o, and reads the list again only when it changed', async (outcome, text, reload) => {
    const d = data([OPEN], outcome)
    await open(d)
    await press(/Approve the refill of omeprazole/)
    await press('Approve', dialog())
    expect(screen.getByText(text)).toBeTruthy()
    expect(d.calls.load).toBe(reload ? 2 : 1)
  })
})

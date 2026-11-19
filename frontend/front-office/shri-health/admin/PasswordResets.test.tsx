import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axeViolations } from '../../../src/test/axe'
import { setClinicTimeZone } from '../../src/domain/time'
import { sectionsFor } from './access'
import { PasswordResetsPanel } from './PasswordResetsPage'
import { maskedMobile, showPasswordResets, type DecisionOutcome, type ListOutcome, type PasswordResetHandlers, type ResetRequestRow } from './passwordResets'

// Administration > Password resets (#85): the administrator approves or declines "Forgot password?"
// requests. Plain stand-ins for the handlers; fictional people only.

const STAFF: ResetRequestRow = {
  id: 'r-1',
  version: '3',
  displayName: 'Jordan Example',
  role: 'Physician (MD)',
  realm: 'staff',
  username: 'jordan.example',
  requestedAt: '2026-11-19T23:10:00Z',
  expiresAt: '2026-11-20T23:10:00Z',
}
const PATIENT: ResetRequestRow = { id: 'r-2', version: '1', displayName: 'Casey Sample', role: 'Patient', realm: 'patients', mobileLast4: '0142', requestedAt: '2026-11-19T18:05:00Z', expiresAt: '2026-11-20T18:05:00Z' }

function handlers(list: ListOutcome | (() => Promise<ListOutcome>), decision: DecisionOutcome = { kind: 'done' }) {
  const calls = { list: 0, approve: [] as string[], decline: [] as Array<[string, string | undefined]> }
  const h: PasswordResetHandlers = {
    list: () => {
      calls.list += 1
      return typeof list === 'function' ? list() : Promise.resolve(list)
    },
    approve: (row) => {
      calls.approve.push(row.id)
      return Promise.resolve(decision)
    },
    decline: (row, note) => {
      calls.decline.push([row.id, note])
      return Promise.resolve(decision)
    },
  }
  return { h, calls }
}

async function open(h: PasswordResetHandlers) {
  await act(async () => {
    render(<PasswordResetsPanel handlers={h} />)
  })
}

async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

/** A row's Approve or Decline (the table and its phone list both have one; the table's is used). */
async function ask(name: string) {
  await act(async () => {
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name }))
  })
}

// jsdom has no ResizeObserver, which the front office's table uses to choose its layout.
class NoResize {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoResize)
  setClinicTimeZone('America/Los_Angeles')
})
afterEach(() => {
  setClinicTimeZone(null)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('the list', () => {
  it('shows each request with its role, sign-in, username, masked mobile and US times in the clinic’s zone', async () => {
    await open(handlers({ kind: 'ok', items: [STAFF, PATIENT] }).h)
    const table = screen.getByRole('table')
    expect(within(table).getByText('Jordan Example')).toBeTruthy()
    expect(within(table).getByText('Physician (MD)')).toBeTruthy()
    expect(within(table).getByText('Staff')).toBeTruthy()
    expect(within(table).getByText('Patient portal')).toBeTruthy()
    expect(within(table).getByText('jordan.example')).toBeTruthy()
    expect(within(table).getByLabelText('ending in 0142').textContent).toBe('•••-•••-0142')
    // 23:10 UTC on Nov 19 is 3:10 PM in Los Angeles.
    expect(within(table).getByText('Nov 19, 2026, 3:10 PM')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\(408\)|555-?0142/)
    expect(await axeViolations()).toEqual([])
  })

  it('says "Reading the requests…" while it reads, and "No requests are waiting." when there are none', async () => {
    await open(handlers(() => new Promise<ListOutcome>(() => undefined)).h)
    expect(screen.getByText('Reading the requests…')).toBeTruthy()
  })

  it('says so when the list is empty', async () => {
    await open(handlers({ kind: 'ok', items: [] }).h)
    expect(screen.getByText('No requests are waiting.')).toBeTruthy()
  })

  it('says the account can’t see them on a 403', async () => {
    await open(handlers({ kind: 'forbidden' }).h)
    expect(screen.getByText("Your account can't see password reset requests.")).toBeTruthy()
  })

  it.each([
    [{ kind: 'error' } as const, "Couldn't read the requests."],
    [{ kind: 'rate-limited' } as const, 'Too many reads. Wait a few minutes, then try again.'],
  ])('says so for %o and reads again on "Try again"', async (outcome, text) => {
    const { h, calls } = handlers(outcome)
    await open(h)
    expect(screen.getByText(text)).toBeTruthy()
    await click('Try again')
    expect(calls.list).toBe(2)
  })
})

describe('approving and declining', () => {
  it('approves only after the confirmation, removes the row and moves focus to the result', async () => {
    const { h, calls } = handlers({ kind: 'ok', items: [STAFF, PATIENT] })
    await open(h)
    await ask('Approve the reset for Jordan Example')
    expect(calls.approve).toEqual([])
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Approve this password reset?')).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }))
    })
    expect(calls.approve).toEqual(['r-1'])
    await waitFor(() => expect(screen.queryAllByText('jordan.example')).toEqual([]))
    const result = screen.getByText(/Approved\. Jordan Example will get an email/)
    await waitFor(() => expect(document.activeElement?.contains(result)).toBe(true))
  })

  it('makes no decision when the confirmation is cancelled', async () => {
    const { h, calls } = handlers({ kind: 'ok', items: [STAFF] })
    await open(h)
    await ask('Approve the reset for Jordan Example')
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    })
    expect(calls.approve).toEqual([])
    expect(within(screen.getByRole('table')).getByText('jordan.example')).toBeTruthy()
  })

  it('declines with the optional note, or with none', async () => {
    const { h, calls } = handlers({ kind: 'ok', items: [STAFF, PATIENT] })
    await open(h)
    await ask('Decline the reset for Jordan Example')
    fireEvent.change(screen.getByLabelText(/Note for the requester/), { target: { value: '  Please call the front desk.  ' } })
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Decline' }))
    })
    await ask('Decline the reset for Casey Sample')
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Decline' }))
    })
    expect(calls.decline).toEqual([
      ['r-1', 'Please call the front desk.'],
      ['r-2', undefined],
    ])
    expect(screen.getByText(/Declined\. Casey Sample will see/)).toBeTruthy()
  })

  it.each([
    [{ kind: 'forbidden' } as const, "Your account can't approve or decline password resets.", false],
    [{ kind: 'not-found' } as const, 'That request no longer exists. The list has been updated.', true],
    [{ kind: 'conflict' } as const, 'That request was already decided or has expired. The list has been updated.', true],
    [{ kind: 'stale' } as const, 'That request changed after the list was read. The list has been updated; check it and try again.', true],
    [{ kind: 'rate-limited' } as const, 'Too many actions. Wait a few minutes, then try again.', false],
    [{ kind: 'error' } as const, "Couldn't save the decision. Check your connection, then try again.", false],
  ])('says so for %o, and reads the list again only when it changed', async (outcome, text, reload) => {
    const { h, calls } = handlers({ kind: 'ok', items: [STAFF] }, outcome)
    await open(h)
    await ask('Approve the reset for Jordan Example')
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }))
    })
    expect(screen.getByText(text)).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.list).toBe(reload ? 2 : 1)
  })

  it('keeps the decline open with the 422 on the note field', async () => {
    const { h } = handlers({ kind: 'ok', items: [STAFF] }, { kind: 'invalid', message: 'The note can be at most 200 characters.' })
    await open(h)
    await ask('Decline the reset for Jordan Example')
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Decline' }))
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText(/Note for the requester/).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('The note can be at most 200 characters.')).toBeTruthy()
  })
})

describe('who sees the section', () => {
  const ADM = new Set(['roles:read', 'password-resets:approve'])

  it('is off unless VITE_FEATURE_PASSWORD_HELP=on, even with the permission', () => {
    expect(sectionsFor(ADM).map((s) => s.path)).toEqual(['users'])
    vi.stubEnv('VITE_FEATURE_PASSWORD_HELP', 'on')
    expect(sectionsFor(ADM).map((s) => s.path)).toEqual(['users', 'password-resets'])
  })

  it('needs password-resets:approve with the switch on (no development preview in tests)', () => {
    vi.stubEnv('VITE_FEATURE_PASSWORD_HELP', 'on')
    expect(showPasswordResets(new Set(['roles:read']))).toBe(false)
    expect(showPasswordResets(new Set(['password-resets:approve']))).toBe(true)
  })

  it('shows the development preview only on a development server with its own switch', () => {
    expect(showPasswordResets(new Set(), { VITE_FEATURE_PASSWORD_HELP: 'on', DEV: true, VITE_PASSWORD_HELP_PREVIEW: 'on' })).toBe(true)
    expect(showPasswordResets(new Set(), { VITE_FEATURE_PASSWORD_HELP: 'on', DEV: false, VITE_PASSWORD_HELP_PREVIEW: 'on' })).toBe(false)
    expect(showPasswordResets(new Set(), { VITE_FEATURE_PASSWORD_HELP: 'on', DEV: true })).toBe(false)
  })

  it('masks a mobile number to its last four digits', () => {
    expect(maskedMobile('0142')).toBe('•••-•••-0142')
    expect(maskedMobile(undefined)).toBe('—')
    expect(maskedMobile('4085550142')).toBe('—')
  })
})

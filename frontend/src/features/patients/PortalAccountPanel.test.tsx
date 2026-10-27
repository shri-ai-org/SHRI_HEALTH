import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '../../api/client'
import { ToastProvider } from '../../design-system'
import { axeViolations } from '../../test/axe'
import { json, problem, serve } from '../../test/fakeServer'
import { PortalAccountPanel } from './PortalAccountPanel'

// Synthetic data only.
const patientId = '00000000-0000-4000-8000-0000000000aa'
const BASE = `/api/v1/patients/${patientId}`
const GET = `GET ${BASE}/portal-account`
const invitationId = '00000000-0000-4000-8000-0000000003a1'

const account = (status: string, extra: object = {}) => ({ patientId, status, ...extra })
const email = 'ana.testperson@example.com'
const active = account('active', { email, enrolledAt: '2026-10-20T15:00:00Z' })

afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken(null)
})

function renderPanel() {
  setCsrfToken('test-csrf')
  render(
    <ToastProvider>
      <PortalAccountPanel patientId={patientId} />
    </ToastProvider>,
  )
  return userEvent.setup()
}

describe('PortalAccountPanel', () => {
  it('issues an invitation only after the ID check, and shows the code once', async () => {
    const server = serve({
      [GET]: [() => json(200, account('none')), () => json(200, account('invited', { invitation: { id: invitationId, status: 'active', issuedAt: '2026-10-27T15:00:00Z', expiresAt: '2026-10-30T15:00:00Z' } }))],
      [`POST ${BASE}/portal-invitations`]: [() => json(201, { id: invitationId, code: 'ABCD-1234-EFGH', issuedAt: '2026-10-27T15:00:00Z', expiresAt: '2026-10-30T15:00:00Z' })],
    })
    const user = renderPanel()
    expect(await screen.findByText('No account')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Issue invitation' }))
    const dialog = await screen.findByRole('dialog', { name: 'Issue a portal invitation?' })
    await user.click(within(dialog).getByRole('button', { name: 'Issue invitation' }))
    expect(within(dialog).getByText("Check the patient's photo ID in person first.")).toBeInTheDocument()
    expect(server.calls()).not.toContain(`POST ${BASE}/portal-invitations`)

    await user.click(within(dialog).getByRole('checkbox', { name: /I checked the patient's photo ID in person/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Issue invitation' }))
    const shown = await screen.findByRole('dialog', { name: 'Portal invitation' })
    expect(within(shown).getByText('ABCD-1234-EFGH')).toBeInTheDocument()
    expect(server.bodies(`POST ${BASE}/portal-invitations`)[0]?.body).toEqual({ idChecked: true })
    expect(await screen.findByText('Invited')).toBeInTheDocument()

    await user.click(within(shown).getByRole('button', { name: 'Done' }))
    // Closing the dialog drops the code; the panel never shows it again.
    expect(screen.queryByText('ABCD-1234-EFGH')).toBeNull()
    expect(screen.getByRole('button', { name: 'Issue new invitation' })).toBeInTheDocument()
  })

  it('shows the sign-in email, or says it is unavailable, for an enrolled account', async () => {
    serve({ [GET]: [() => json(200, active)] })
    renderPanel()
    expect(await screen.findByText('ana.testperson@example.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset sign-in factors' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Issue/ })).toBeNull()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()

    serve({ [GET]: [() => json(200, account('pending-setup'))] })
    renderPanel()
    expect(await screen.findByText('Email unavailable')).toBeInTheDocument()
  })

  it('disables only with a reason', async () => {
    const server = serve({
      [GET]: [() => json(200, active), () => json(200, account('disabled', { email, disabledAt: '2026-10-27T16:00:00Z' }))],
      [`POST ${BASE}/portal-account/disable`]: [() => json(200, account('disabled'))],
    })
    const user = renderPanel()
    await user.click(await screen.findByRole('button', { name: 'Disable account' }))
    const dialog = await screen.findByRole('dialog', { name: 'Disable the portal account?' })
    await user.click(within(dialog).getByRole('button', { name: 'Disable account' }))
    expect(within(dialog).getByLabelText(/Reason/)).toHaveAccessibleDescription(/Say why the account is being disabled/)
    await user.type(within(dialog).getByLabelText(/Reason/), 'Requested by the patient.')
    await user.click(within(dialog).getByRole('button', { name: 'Disable account' }))
    expect(await screen.findByText('Portal account disabled')).toBeInTheDocument()
    expect(server.bodies(`POST ${BASE}/portal-account/disable`)[0]?.body).toEqual({ reason: 'Requested by the patient.' })
    expect(await screen.findByRole('button', { name: 'Enable account' })).toBeInTheDocument()
  })

  it('offers no Enable or Reset on a suspended account, only Disable', async () => {
    serve({ [GET]: [() => json(200, account('suspended'))] })
    renderPanel()
    expect(await screen.findByText('Suspended: chart merged')).toBeInTheDocument()
    expect(screen.getByText(/Issue a new invitation on the surviving chart/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Enable|Reset|Issue/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Disable account' })).toBeInTheDocument()
  })

  it('resets sign-in factors after the ID check, with an optional note', async () => {
    const server = serve({
      [GET]: [() => json(200, active)],
      [`POST ${BASE}/portal-account/reset-factors`]: [() => json(200, { ...active, factorsResetAt: '2026-10-27T16:00:00Z' })],
    })
    const user = renderPanel()
    await user.click(await screen.findByRole('button', { name: 'Reset sign-in factors' }))
    const dialog = await screen.findByRole('dialog', { name: "Reset the patient's sign-in factors?" })
    await user.click(within(dialog).getByRole('checkbox'))
    await user.type(within(dialog).getByLabelText(/Note/), 'Lost phone.')
    await user.click(within(dialog).getByRole('button', { name: 'Reset sign-in factors' }))
    expect(await screen.findByText('Sign-in factors reset')).toBeInTheDocument()
    expect(server.bodies(`POST ${BASE}/portal-account/reset-factors`)[0]?.body).toEqual({ idChecked: true, note: 'Lost phone.' })
  })

  it('shows a refusal and reads the account again when it changed elsewhere', async () => {
    const server = serve({
      [GET]: [() => json(200, account('invited', { invitation: { id: invitationId, status: 'active', issuedAt: '2026-10-27T15:00:00Z', expiresAt: '2026-10-30T15:00:00Z' } })), () => json(200, active)],
      [`POST ${BASE}/portal-invitations/${invitationId}/revoke`]: [() => problem(409, 'invalid-state-transition', { currentState: 'used' })],
    })
    const user = renderPanel()
    await user.click(await screen.findByRole('button', { name: 'Revoke invitation' }))
    const dialog = await screen.findByRole('dialog', { name: 'Revoke this invitation?' })
    await user.click(within(dialog).getByRole('button', { name: 'Revoke invitation' }))
    expect(await within(dialog).findByRole('status')).toBeInTheDocument()
    expect(server.calls().filter((c) => c === GET)).toHaveLength(2)
  })

  it('shows a permission refusal instead of the panel', async () => {
    serve({ [GET]: [() => problem(403, 'permission-denied', { requestId: 'r-7' })] })
    renderPanel()
    expect(await screen.findByText(/r-7/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

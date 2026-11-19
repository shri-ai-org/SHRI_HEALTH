import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../test/axe'
import { PortalApiContext, type PortalApi } from '../../api/portalApi'
import { forgetStatusToken, keepStatusToken, notYetConnected, passwordHelpOn, takeStatusToken, type PasswordHelpHandlers, type RequestOutcome, type StatusViewState } from '../../passwordHelp'
import { PortalApp, resetAutoSignInForTests } from '../../PortalApp'
import { PortalRouter } from '../../router'
import { PasswordHelpRequestPage, PasswordHelpStatusPage, SENT_TEXT, SENT_TITLE } from './PasswordHelpPages'
import { SignInPage } from './SignInPage'

// "Forgot password?" for patients (#85): the request form, the status page, the status token and
// the switch. Plain stand-ins for the handlers. Synthetic usernames and numbers only.

const TOKEN = 'portal-status-token-for-tests'
const KEY = 'shri.portal.passwordHelp.statusToken'
type Answer = Exclude<StatusViewState, { kind: 'loading' } | { kind: 'no-token' }>

function handlers(request: RequestOutcome | (() => Promise<RequestOutcome>), status: Answer | (() => Promise<Answer>) = { kind: 'ready', status: 'waiting' }) {
  const sent: string[] = []
  const asked: string[] = []
  const h: PasswordHelpHandlers = {
    requestReset: (identifier) => {
      sent.push(identifier)
      return typeof request === 'function' ? request() : Promise.resolve(request)
    },
    readStatus: (token) => {
      asked.push(token)
      return typeof status === 'function' ? status() : Promise.resolve(status)
    },
  }
  return { h, sent, asked }
}

function inRouter(children: React.ReactNode) {
  return render(
    <PortalApiContext.Provider value={{ startSignIn: vi.fn() } as unknown as PortalApi}>
      <PortalRouter>{children}</PortalRouter>
    </PortalApiContext.Provider>,
  )
}

async function send(value: string) {
  fireEvent.change(screen.getByLabelText(/Username or mobile number/), { target: { value } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
  })
}

async function openStatus(h: PasswordHelpHandlers) {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = inRouter(<PasswordHelpStatusPage handlers={h} />)
  })
  return result
}

beforeEach(() => {
  sessionStorage.clear()
  window.history.replaceState(null, '', '/portal/password-help')
})
afterEach(() => vi.unstubAllEnvs())

describe('the request form', () => {
  it('sends the username or mobile number to the handler only, and keeps the token for this tab', async () => {
    const { h, sent } = handlers({ kind: 'accepted', statusToken: TOKEN })
    inRouter(<PasswordHelpRequestPage handlers={h} />)
    await send('  (408) 555-0142  ')
    expect(sent).toEqual(['(408) 555-0142'])
    expect(window.location.href).not.toContain('555')
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN)
    expect(window.location.href).not.toContain(TOKEN)
    expect(screen.getByText(SENT_TITLE)).toBeInTheDocument()
    expect(screen.getByText(SENT_TEXT)).toBeInTheDocument()
  })

  it('gives exactly the same answer for any account and any accepted kind', async () => {
    const reference = inRouter(<PasswordHelpRequestPage handlers={handlers({ kind: 'accepted', statusToken: TOKEN }).h} />)
    await send('example.patient')
    const expected = reference.container.innerHTML
    reference.unmount()
    for (const outcome of [{ kind: 'accepted', statusToken: 'another-portal-token-for-tests' }, { kind: 'created' }, { kind: 'already-open' }, { kind: 'no-such-account' }, { kind: 'something-new' }]) {
      sessionStorage.clear()
      const view = inRouter(<PasswordHelpRequestPage handlers={handlers(outcome as RequestOutcome).h} />)
      await send('nobody.example')
      expect(view.container.innerHTML).toBe(expected)
      expect(document.title).not.toMatch(/found|exist/i)
      view.unmount()
    }
    expect(document.body.textContent).not.toMatch(/not found|no account|does not exist/i)
  })

  it('asks for a username or mobile number before sending anything', async () => {
    const { h, sent } = handlers({ kind: 'accepted', statusToken: TOKEN })
    inRouter(<PasswordHelpRequestPage handlers={h} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    })
    expect(sent).toEqual([])
    expect(screen.getAllByText('Enter your username or mobile number.').length).toBeGreaterThan(0)
    // Focus goes to the field, which reads its error out (aria-describedby).
    const field = screen.getByLabelText(/Username or mobile number/)
    expect(document.activeElement).toBe(field)
    expect(field.getAttribute('aria-describedby')).toContain('password-help-identifier-error')
  })

  it.each([
    [{ kind: 'rate-limited' } as const, 'Too many requests'],
    [{ kind: 'unavailable' } as const, "Password help isn't available right now"],
    [{ kind: 'error' } as const, "We couldn't send your request"],
  ])('says so for %o, keeps the form and keeps no token', async (outcome, title) => {
    inRouter(<PasswordHelpRequestPage handlers={handlers(outcome).h} />)
    await send('example.patient')
    expect(screen.getByText(title)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send request' })).toBeInTheDocument()
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  it('moves focus to the answer, has no password field, and passes axe', async () => {
    const { container } = inRouter(<PasswordHelpRequestPage handlers={handlers({ kind: 'accepted', statusToken: TOKEN }).h} />)
    expect(container.querySelector('input[type="password"]')).toBeNull()
    await send('example.patient')
    await waitFor(() => expect(document.activeElement?.textContent).toContain(SENT_TITLE))
    expect(await axeViolations()).toEqual([])
  })
})

describe('the status page', () => {
  it('takes the token from the fragment, removes it from the address, and gives it only to the handler', async () => {
    window.history.replaceState(null, '', `/portal/password-help/status#status=${TOKEN}`)
    const { h, asked } = handlers({ kind: 'accepted', statusToken: TOKEN })
    const { container } = await openStatus(h)
    expect(asked).toEqual([TOKEN])
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain(TOKEN)
    expect(container.innerHTML).not.toContain(TOKEN)
    expect(document.title).not.toContain(TOKEN)
  })

  it('takes a token that arrives while the page is open', async () => {
    const { h, asked } = handlers({ kind: 'accepted', statusToken: TOKEN })
    await openStatus(h)
    await act(async () => {
      window.history.replaceState(null, '', `/portal/password-help/status#status=${TOKEN}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(asked).toEqual([TOKEN])
    expect(window.location.hash).toBe('')
  })

  it('says so when there is no token, and asks nothing', async () => {
    const { h, asked } = handlers({ kind: 'accepted', statusToken: TOKEN })
    await openStatus(h)
    expect(asked).toEqual([])
    expect(screen.getByText('No request to show')).toBeInTheDocument()
  })

  it('shows "Checking your request…" while it reads', async () => {
    sessionStorage.setItem(KEY, TOKEN)
    await openStatus(handlers({ kind: 'accepted', statusToken: TOKEN }, () => new Promise<Answer>(() => undefined)).h)
    expect(screen.getByText('Checking your request…')).toBeInTheDocument()
  })

  it.each([
    ['waiting', 'Waiting for your clinic', true],
    ['approved', 'Approved', false],
    ['declined', 'Declined', false],
    ['expired', 'Expired', false],
    ['unavailable', "This request can't be shown", false],
  ] as const)('shows %s as "%s" with no input or reset link, and keeps the token only while waiting', async (status, title, kept) => {
    sessionStorage.setItem(KEY, TOKEN)
    const { container } = await openStatus(handlers({ kind: 'accepted', statusToken: TOKEN }, { kind: 'ready', status }).h)
    expect(screen.getByText(title)).toBeInTheDocument()
    expect(container.querySelector('input')).toBeNull()
    expect(screen.queryByRole('link', { name: /set a new password|reset/i })).toBeNull()
    expect(sessionStorage.getItem(KEY)).toBe(kept ? TOKEN : null)
  })

  it('says to check email once approved, and shows the clinic’s note on a decline', async () => {
    sessionStorage.setItem(KEY, TOKEN)
    const approved = await openStatus(handlers({ kind: 'accepted', statusToken: TOKEN }, { kind: 'ready', status: 'approved' }).h)
    expect(screen.getByText('Check your email for a link to set a new password.')).toBeInTheDocument()
    approved.unmount()
    sessionStorage.setItem(KEY, TOKEN)
    await openStatus(handlers({ kind: 'accepted', statusToken: TOKEN }, { kind: 'ready', status: 'declined', note: 'Example note from the clinic.' }).h)
    expect(screen.getByText('Example note from the clinic.')).toBeInTheDocument()
  })

  it.each([
    [{ kind: 'error' } as const, "We couldn't check your request"],
    [{ kind: 'rate-limited' } as const, 'Too many checks'],
  ])('says so for %o, keeps the token, and tries again on "Try again"', async (answer, title) => {
    sessionStorage.setItem(KEY, TOKEN)
    const { h, asked } = handlers({ kind: 'accepted', statusToken: TOKEN }, answer)
    await openStatus(h)
    expect(screen.getByText(title)).toBeInTheDocument()
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    })
    expect(asked).toEqual([TOKEN, TOKEN])
  })
})

describe('the route in the portal', () => {
  function app() {
    const startSignIn = vi.fn()
    const api = { getSession: () => Promise.reject(new Error('no session')), startSignIn } as unknown as PortalApi
    render(<PortalApp api={api} />)
    return { startSignIn }
  }

  it('is not routed with the switch off: a signed-out visit goes to sign-in as before', async () => {
    resetAutoSignInForTests()
    const { startSignIn } = app()
    await waitFor(() => expect(startSignIn).toHaveBeenCalledOnce())
    expect(screen.queryByRole('heading', { name: 'Forgot your password?' })).toBeNull()
  })

  it('opens without a session with the switch on, and starts no sign-in', async () => {
    vi.stubEnv('VITE_FEATURE_PASSWORD_HELP', 'on')
    resetAutoSignInForTests()
    const { startSignIn } = app()
    expect(await screen.findByRole('heading', { name: 'Forgot your password?' })).toBeInTheDocument()
    expect(startSignIn).not.toHaveBeenCalled()
  })
})

describe('the token helpers, the switch and the sign-in link', () => {
  it('ignores a fragment that is not a token, and keeps and forgets in storage only', () => {
    window.history.replaceState(null, '', '/portal/password-help/status#status=<script>')
    expect(takeStatusToken()).toBeNull()
    expect(window.location.hash).toBe('')
    keepStatusToken(TOKEN)
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN)
    forgetStatusToken()
    expect(sessionStorage.getItem(KEY)).toBeNull()
  })

  it('is off unless the build sets VITE_FEATURE_PASSWORD_HELP=on, and answers "unavailable" before the contract', async () => {
    expect(passwordHelpOn()).toBe(false)
    vi.stubEnv('VITE_FEATURE_PASSWORD_HELP', 'on')
    expect(passwordHelpOn()).toBe(true)
    expect(await notYetConnected.requestReset('example.patient')).toEqual({ kind: 'unavailable' })
    expect(await notYetConnected.readStatus(TOKEN)).toEqual({ kind: 'ready', status: 'unavailable' })
  })

  it('links "Forgot your password?" from the sign-in page only when the switch is on', () => {
    const off = inRouter(<SignInPage />)
    expect(screen.queryByRole('link', { name: 'Forgot your password?' })).toBeNull()
    expect(screen.getByText(/Choose "Forgot password" on the sign-in page/)).toBeInTheDocument()
    off.unmount()
    vi.stubEnv('VITE_FEATURE_PASSWORD_HELP', 'on')
    inRouter(<SignInPage />)
    expect(screen.getByRole('link', { name: 'Forgot your password?' })).toHaveAttribute('href', '/portal/password-help')
    expect(screen.queryByText(/Choose "Forgot password" on the sign-in page/)).toBeNull()
  })
})

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, setCsrfToken } from './client'
import { SessionProvider, useSession } from './session'

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString()

function session(idleInMinutes: number, csrfToken = 'tok') {
  return {
    user: { id: 'u1', name: { given: ['Test'], family: 'User' }, roles: ['FD'] },
    organization: { id: 'o1', name: 'Test Clinic' },
    csrfToken,
    idleExpiresAt: minutes(idleInMinutes),
    expiresAt: minutes(600),
  }
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ type: 'about:blank', title: code, status, code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })

/**
 * A fake server: answers by "METHOD /path". Each route takes a list of responses (made fresh per
 * call); the last one repeats. Unknown routes fail the test.
 */
function serve(routes: Record<string, Array<() => Response>>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    const list = routes[key]
    if (!list) throw new Error(`unexpected ${key}`)
    const next = list.length > 1 ? list.shift()! : list[0]!
    return next()
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    calls: () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url as string}`),
    init: (key: string) => {
      const found = fetchMock.mock.calls.find(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url as string}` === key)
      return found?.[1] as RequestInit | undefined
    },
  }
}

function Who() {
  const { state } = useSession()
  return <p>{state.status === 'signed-in' ? `Signed in at ${state.session.organization.name}` : state.status}</p>
}

let assign: ReturnType<typeof vi.fn>
beforeEach(() => {
  setCsrfToken(null)
  assign = vi.fn()
  vi.stubGlobal('location', { ...window.location, assign })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SessionProvider', () => {
  it('reads the session and shows the app', async () => {
    const server = serve({ 'GET /api/v1/auth/session': [() => ok(session(15))] })
    render(<SessionProvider><Who /></SessionProvider>)
    expect(await screen.findByText('Signed in at Test Clinic')).toBeInTheDocument()
    expect(server.calls()).toEqual(['GET /api/v1/auth/session'])
  })

  it('starts a login only when the user asks for it', async () => {
    serve({ 'GET /api/v1/auth/session': [() => problem(401, 'unauthenticated')] })
    render(<SessionProvider><Who /></SessionProvider>)
    expect(await screen.findByRole('heading', { name: 'Sign in to Shri Health' })).toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(assign).toHaveBeenCalledWith('/api/v1/auth/login')
  })

  it('re-reads the session before warning, then "Stay signed in" calls POST /auth/refresh', async () => {
    const oneMinuteLeft = session(1, 'tok-a')
    const server = serve({
      // First read and the check inside the warning window both say 1 minute left.
      'GET /api/v1/auth/session': [() => ok(oneMinuteLeft)],
      'POST /api/v1/auth/refresh': [() => ok(session(15, 'tok-a'))],
    })
    render(<SessionProvider><Who /></SessionProvider>)
    await userEvent.click(await screen.findByRole('button', { name: 'Stay signed in' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(server.calls().filter((c) => c === 'GET /api/v1/auth/session').length).toBeGreaterThanOrEqual(2)
    expect(new Headers(server.init('POST /api/v1/auth/refresh')?.headers).get('X-CSRF-Token')).toBe('tok-a')
  })

  it('does not warn when another tab has kept the session alive', async () => {
    serve({ 'GET /api/v1/auth/session': [() => ok(session(1)), () => ok(session(15))] })
    render(<SessionProvider><Who /></SessionProvider>)
    await screen.findByText('Signed in at Test Clinic')
    // The check inside the warning window got the later time from the server.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByText('Signed in at Test Clinic')).toBeInTheDocument()
  })

  it('stays signed in at expiry when the server gives a later idleExpiresAt', async () => {
    // Locally the idle time has already passed; the server says another tab extended it.
    serve({ 'GET /api/v1/auth/session': [() => ok(session(-0.1)), () => ok(session(15))] })
    render(<SessionProvider><Who /></SessionProvider>)
    await screen.findByText('Signed in at Test Clinic')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200))
    })
    expect(screen.getByText('Signed in at Test Clinic')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'You were signed out' })).not.toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
  })

  it('ends the session at expiry when the server says so, without starting a new login', async () => {
    serve({ 'GET /api/v1/auth/session': [() => ok(session(-0.1)), () => problem(401, 'session-expired')] })
    render(<SessionProvider><Who /></SessionProvider>)
    expect(await screen.findByRole('heading', { name: 'You were signed out' })).toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
  })

  it('times the warning by the server clock when the browser clock is behind', async () => {
    // Server time is 14 minutes ahead; its idleExpiresAt is 15 minutes from browser time,
    // so by the server's clock only 1 minute is left and the warning is due.
    const serverDate = () => new Date(Date.now() + 14 * 60_000).toUTCString()
    const body = session(15)
    serve({
      'GET /api/v1/auth/session': [
        () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', Date: serverDate() } }),
      ],
    })
    render(<SessionProvider><Who /></SessionProvider>)
    expect(await screen.findByRole('alertdialog', { name: 'Are you still there?' }, { timeout: 3000 })).toBeInTheDocument()
  })

  it('re-reads the session after a user request, so the warning follows the server', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const server = serve({
      'GET /api/v1/auth/session': [() => ok(session(15))],
      'GET /api/v1/booking/providers': [() => ok({ items: [] })],
      'GET /api/v1/pharmacies': [() => ok({ items: [] })],
    })
    render(<SessionProvider reloadDelayMs={500}><Who /></SessionProvider>)
    await screen.findByText('Signed in at Test Clinic')
    await act(async () => {
      await apiFetch('/booking/providers')
      await apiFetch('/pharmacies')
      vi.advanceTimersByTime(600)
    })
    await waitFor(() => expect(server.calls().filter((u) => u === 'GET /api/v1/auth/session')).toHaveLength(2))
  })

  it('signs out through POST /auth/logout and shows the prompt, without starting a new login', async () => {
    const oneMinuteLeft = session(1)
    const server = serve({
      'GET /api/v1/auth/session': [() => ok(oneMinuteLeft)],
      'POST /api/v1/auth/logout': [() => new Response(null, { status: 204 })],
    })
    render(<SessionProvider><Who /></SessionProvider>)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'You have signed out' })).toBeInTheDocument()
    expect(server.calls()).toContain('POST /api/v1/auth/logout')
    expect(assign).not.toHaveBeenCalled()
  })

  it('still signs this tab out when the logout call fails', async () => {
    const oneMinuteLeft = session(1)
    serve({
      'GET /api/v1/auth/session': [() => ok(oneMinuteLeft)],
      'POST /api/v1/auth/logout': [() => problem(500, 'internal-error')],
    })
    render(<SessionProvider><Who /></SessionProvider>)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'You have signed out' })).toBeInTheDocument()
  })

  it('ends the session when a background call gets 401', async () => {
    serve({
      'GET /api/v1/auth/session': [() => ok(session(15))],
      'GET /api/v1/events/poll': [() => problem(401, 'session-expired')],
    })
    render(<SessionProvider><Who /></SessionProvider>)
    await screen.findByText('Signed in at Test Clinic')
    await act(async () => {
      await apiFetch('/events/poll', { background: true }).catch(() => {})
    })
    expect(await screen.findByRole('heading', { name: 'You were signed out' })).toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
  })
})

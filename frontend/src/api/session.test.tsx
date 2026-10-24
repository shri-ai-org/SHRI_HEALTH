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

let fetchMock: ReturnType<typeof vi.fn>
const urls = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url as string}`)

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
afterEach(() => vi.unstubAllGlobals())

describe('SessionProvider', () => {
  it('reads the session and shows the app', async () => {
    fetchMock = vi.fn(async () => ok(session(15)))
    vi.stubGlobal('fetch', fetchMock)
    render(<SessionProvider><Who /></SessionProvider>)
    expect(await screen.findByText('Signed in at Test Clinic')).toBeInTheDocument()
    expect(urls()).toEqual(['GET /api/v1/auth/session'])
  })

  it('offers sign-in when there is no session', async () => {
    fetchMock = vi.fn(async () => problem(401, 'unauthenticated'))
    vi.stubGlobal('fetch', fetchMock)
    render(<SessionProvider><Who /></SessionProvider>)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    expect(assign).toHaveBeenCalledWith('/api/v1/auth/login')
  })

  it('"Stay signed in" calls POST /auth/refresh with the CSRF token and takes the new expiry', async () => {
    const queue = [ok(session(1, 'tok-a')), ok(session(15, 'tok-a'))]
    fetchMock = vi.fn(async () => queue.shift() ?? ok(session(15, 'tok-a')))
    vi.stubGlobal('fetch', fetchMock)
    render(<SessionProvider><Who /></SessionProvider>)
    // 1 minute left: inside the 2-minute warning window.
    await userEvent.click(await screen.findByRole('button', { name: 'Stay signed in' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    const [, refreshInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/auth/refresh')
    expect(refreshInit.method).toBe('POST')
    expect(new Headers(refreshInit.headers).get('X-CSRF-Token')).toBe('tok-a')
  })

  it('re-reads the session after a user request, so the warning follows the server', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock = vi.fn(async () => ok(session(15)))
    vi.stubGlobal('fetch', fetchMock)
    render(<SessionProvider reloadDelayMs={500}><Who /></SessionProvider>)
    await screen.findByText('Signed in at Test Clinic')
    await act(async () => {
      await apiFetch('/booking/providers')
      await apiFetch('/pharmacies')
      vi.advanceTimersByTime(600)
    })
    await waitFor(() => expect(urls().filter((u) => u === 'GET /api/v1/auth/session')).toHaveLength(2))
    vi.useRealTimers()
  })

  it('signs out through POST /auth/logout, then sends the browser to sign in', async () => {
    const queue = [ok(session(1)), new Response(null, { status: 204 })]
    fetchMock = vi.fn(async () => queue.shift() ?? ok(session(1)))
    vi.stubGlobal('fetch', fetchMock)
    render(<SessionProvider><Who /></SessionProvider>)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/v1/auth/login'))
    expect(urls()).toContain('POST /api/v1/auth/logout')
  })
})

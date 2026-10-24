import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch, etagOf, ifMatch, newIdempotencyKey, onUnauthenticated, onUserRequest, setCsrfToken } from './client'

type Call = { url: string; init: RequestInit }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const type = status >= 400 ? 'application/problem+json' : 'application/json'
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type, ...headers } })
}

const problem = (status: number, code: string) => ({ type: `tag:company-domain.invalid,2026:problem/${code}`, title: code, status, code })

let calls: Call[]
function mockFetch(...responses: Response[]) {
  calls = []
  const queue = [...responses]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const next = queue.shift()
      if (!next) throw new Error(`unexpected fetch ${url}`)
      return next
    }),
  )
}
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name)

beforeEach(() => setCsrfToken(null))
afterEach(() => vi.unstubAllGlobals())

describe('apiFetch', () => {
  it('reads with the session cookie, under /api/v1, without a CSRF header', async () => {
    setCsrfToken('tok-1')
    mockFetch(json(200, { items: [] }))
    const res = await apiFetch<{ data: unknown; status: number }>('/booking/providers', { method: 'GET' })
    expect(res).toMatchObject({ status: 200, data: { items: [] } })
    expect(calls[0]?.url).toBe('/api/v1/booking/providers')
    expect(calls[0]?.init.credentials).toBe('same-origin')
    expect(header(calls[0]!, 'X-CSRF-Token')).toBeNull()
  })

  it('loads the CSRF token from GET /auth/session before the first unsafe request', async () => {
    mockFetch(json(200, { csrfToken: 'tok-2', idleExpiresAt: 'x', expiresAt: 'y' }), json(201, { id: 'p1' }))
    await apiFetch('/patients', { method: 'POST', body: '{}' })
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/auth/session', '/api/v1/patients'])
    expect(header(calls[1]!, 'X-CSRF-Token')).toBe('tok-2')
  })

  it('re-reads the session once and retries after csrf-check-failed, keeping the Idempotency-Key', async () => {
    setCsrfToken('old')
    mockFetch(json(403, problem(403, 'csrf-check-failed')), json(200, { csrfToken: 'new' }), json(200, { ok: true }))
    const key = newIdempotencyKey()
    await apiFetch('/appointments/a1/check-in', { method: 'POST', body: '{}', headers: { 'Idempotency-Key': key } })
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/appointments/a1/check-in',
      '/api/v1/auth/session',
      '/api/v1/appointments/a1/check-in',
    ])
    expect(header(calls[2]!, 'X-CSRF-Token')).toBe('new')
    expect(header(calls[2]!, 'Idempotency-Key')).toBe(key)
  })

  it('throws ApiError with the Problem; screens switch on its code', async () => {
    setCsrfToken('t')
    mockFetch(json(412, problem(412, 'precondition-failed')))
    const error = await apiFetch('/patients/p1', { method: 'PATCH', headers: ifMatch('"v3"') }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('precondition-failed')
    expect((error as ApiError).status).toBe(412)
    expect(header(calls[0]!, 'If-Match')).toBe('"v3"')
  })

  it('keeps the response headers on ApiError, e.g. Retry-After on 429', async () => {
    mockFetch(json(429, problem(429, 'rate-limited'), { 'Retry-After': '30' }))
    const error = (await apiFetch('/pharmacies').catch((e: unknown) => e)) as ApiError
    expect(error.code).toBe('rate-limited')
    expect(error.headers.get('Retry-After')).toBe('30')
    expect(error.retryAfterSeconds()).toBe(30)
  })

  it('reads Retry-After as an HTTP date too, and the current ETag from a 412', async () => {
    const now = Date.parse('2026-11-03T15:00:00Z')
    mockFetch(json(503, problem(503, 'service-unavailable'), { 'Retry-After': 'Tue, 03 Nov 2026 15:01:00 GMT' }))
    const unavailable = (await apiFetch('/pharmacies').catch((e: unknown) => e)) as ApiError
    expect(unavailable.retryAfterSeconds(now)).toBe(60)

    setCsrfToken('t')
    mockFetch(json(412, problem(412, 'precondition-failed'), { ETag: '"v5"' }))
    const changed = (await apiFetch('/patients/p1', { method: 'PATCH', headers: ifMatch('"v3"') }).catch((e: unknown) => e)) as ApiError
    expect(changed.headers.get('ETag')).toBe('"v5"')
    expect(changed.retryAfterSeconds()).toBeNull()
  })

  it('maps a non-Problem error to the catalogue code for its status', async () => {
    mockFetch(new Response('Not here', { status: 404, headers: { 'Content-Type': 'text/plain' } }))
    const error = (await apiFetch('/pharmacies').catch((e: unknown) => e)) as ApiError
    expect(error.code).toBe('not-found')
  })

  it('tells the session layer about a 401 from any call, but not from its own session calls', async () => {
    const ended = vi.fn()
    const stop = onUnauthenticated(ended)
    mockFetch(json(401, problem(401, 'session-expired')), json(401, problem(401, 'unauthenticated')))
    await apiFetch('/events/poll', { background: true }).catch(() => {})
    await apiFetch('/auth/session').catch(() => {})
    expect(ended).toHaveBeenCalledTimes(1)
    stop()
  })

  it('turns a non-Problem error body into a Problem with a safe code', async () => {
    mockFetch(new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html', 'X-Request-ID': 'r-9' } }))
    const error = (await apiFetch('/pharmacies').catch((e: unknown) => e)) as ApiError
    expect(error.problem).toMatchObject({ status: 502, code: 'internal-error', requestId: 'r-9' })
  })

  it('reports a request that never reached the server as a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    const error = (await apiFetch('/pharmacies').catch((e: unknown) => e)) as ApiError
    expect(error.networkError).toBe(true)
    expect(error.code).toBe('service-unavailable')
  })

  it('returns the ETag for the next If-Match', async () => {
    mockFetch(json(200, { id: 'p1' }, { ETag: '"v4"' }))
    const res = await apiFetch<{ headers: Headers }>('/patients/p1')
    expect(etagOf(res)).toBe('"v4"')
  })

  it('tells the session layer about user requests, but not background or session calls', async () => {
    const seen = vi.fn()
    const stop = onUserRequest(seen)
    mockFetch(json(200, {}), json(200, {}), json(200, {}))
    await apiFetch('/booking/providers')
    await apiFetch('/events/poll', { background: true })
    await apiFetch('/auth/session')
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
  })

  it('makes a new UUID per user action', () => {
    const a = newIdempotencyKey()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(newIdempotencyKey()).not.toBe(a)
  })
})

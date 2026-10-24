/**
 * The one fetch wrapper every generated API call goes through (orval mutator; TOOLCHAIN §1, M4).
 *
 * - Same-origin `/api/v1`, session cookie only (SECURITY_MODEL §2.1). Tokens never reach the page.
 * - `X-CSRF-Token` on every unsafe method, from `GET /auth/session` (SECURITY_MODEL §2.2). A
 *   `403 csrf-check-failed` re-reads the session once and retries, because the token rotates at login.
 * - `ETag` comes back in `headers`; send it as `If-Match` with `ifMatch()` (API_STANDARDS §11).
 * - `Idempotency-Key`: make one with `newIdempotencyKey()` when the user acts, and reuse it when
 *   that same action is retried (API_STANDARDS §10). The wrapper never invents one.
 * - A non-2xx response throws `ApiError` carrying the Problem; screens switch on `problem.code`.
 */
import { isProblem, type Problem } from '../design-system'

export const API_BASE = '/api/v1'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Extra option for calls the user did not trigger (polling, background refresh). */
export interface ApiRequestInit extends RequestInit {
  /** Not a user request: does not prompt a session re-read (background calls never extend the session). */
  background?: boolean
}

export class ApiError extends Error {
  readonly problem: Problem
  readonly status: number
  /** True when the request never reached the server (offline, DNS, connection reset). */
  readonly networkError: boolean

  constructor(problem: Problem, networkError = false) {
    super(problem.title)
    this.name = 'ApiError'
    this.problem = problem
    this.status = problem.status
    this.networkError = networkError
  }

  get code(): string {
    return this.problem.code
  }
}

// ---- CSRF token, held in memory only (never in storage) ----------------------------------

let csrfToken: string | null = null
let csrfLoading: Promise<string | null> | null = null

/** Called by the session layer whenever it reads `GET /auth/session` or `POST /auth/refresh`. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

async function loadCsrfToken(): Promise<string | null> {
  csrfLoading ??= fetch(`${API_BASE}/auth/session`, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(async (res) => {
      if (!res.ok) return null
      const body: unknown = await res.json()
      const token = typeof body === 'object' && body !== null ? (body as { csrfToken?: unknown }).csrfToken : undefined
      csrfToken = typeof token === 'string' ? token : null
      return csrfToken
    })
    .catch(() => null)
    .finally(() => {
      csrfLoading = null
    })
  return csrfLoading
}

// ---- User-request notifications ---------------------------------------------------------

type Listener = () => void
const userRequestListeners = new Set<Listener>()

/**
 * The session layer listens here: a user request may have extended the idle timer, so it re-reads
 * `GET /auth/session` for the new `idleExpiresAt` (SECURITY_MODEL §2.1).
 */
export function onUserRequest(listener: Listener): () => void {
  userRequestListeners.add(listener)
  return () => userRequestListeners.delete(listener)
}

// ---- Helpers for screens ------------------------------------------------------------------

/** A new key for one user action. Keep it and pass the same key if that action is retried. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

/** The `ETag` of a response, to send back as `If-Match` on the next edit. */
export function etagOf(response: { headers: Headers }): string | null {
  return response.headers.get('ETag')
}

export function ifMatch(etag: string): { 'If-Match': string } {
  return { 'If-Match': etag }
}

// ---- The mutator ----------------------------------------------------------------------------

/** URLs that are about the session itself and must not trigger a session re-read. */
const SESSION_PATHS = ['/auth/session', '/auth/refresh', '/auth/logout']

export async function apiFetch<T>(url: string, init: ApiRequestInit = {}): Promise<T> {
  const { background = false, ...requestInit } = init
  const method = (requestInit.method ?? 'GET').toUpperCase()
  const unsafe = !SAFE_METHODS.has(method)

  if (unsafe && csrfToken === null) await loadCsrfToken()

  let res = await send(url, method, requestInit, unsafe)
  let body = await readBody(res)

  if (unsafe && res.status === 403 && isProblem(body) && body.code === 'csrf-check-failed') {
    // The token rotates at login (another tab may have signed in again). The server rejected the
    // request before running it, so sending it once more with a fresh token is safe.
    await loadCsrfToken()
    res = await send(url, method, requestInit, unsafe)
    body = await readBody(res)
  }

  if (!background && !SESSION_PATHS.some((p) => url.startsWith(p))) {
    for (const listener of userRequestListeners) listener()
  }

  if (!res.ok) throw new ApiError(toProblem(res, body))

  return { data: body, status: res.status, headers: res.headers } as T
}

async function send(url: string, method: string, init: RequestInit, unsafe: boolean): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json, application/problem+json')
  if (unsafe && csrfToken !== null) headers.set('X-CSRF-Token', csrfToken)
  try {
    return await fetch(`${API_BASE}${url}`, { ...init, method, headers, credentials: 'same-origin' })
  } catch {
    throw new ApiError(
      { type: 'about:blank', title: 'Network error', status: 0, code: 'service-unavailable' },
      true,
    )
  }
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return undefined
  const type = res.headers.get('Content-Type') ?? ''
  if (!/json/i.test(type)) return undefined
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/** Non-Problem error bodies (a proxy page, an empty 502) still become a Problem the screens can show. */
function toProblem(res: Response, body: unknown): Problem {
  if (isProblem(body)) return body
  const requestId = res.headers.get('X-Request-ID')
  return {
    type: 'about:blank',
    title: res.statusText || 'Request failed',
    status: res.status,
    code: res.status >= 500 ? 'internal-error' : 'unknown',
    ...(requestId ? { requestId } : {}),
  }
}

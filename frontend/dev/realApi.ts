/**
 * Development only: `SHRI_API=real npm run dev` runs the screens against the local stack
 * (infra/compose, through Nginx on https://localhost:8443) instead of the contract mock.
 *
 * The API's development sign-in takes the user from request headers (`AUTH_MODE=dev_header`:
 * `X-Dev-User`; `PATIENT_AUTH_MODE=dev_header`: `X-Dev-Patient` and `X-Dev-Patient-Clinic`, #99).
 * The browser never sends them: this dev server's proxy sets them on every /api/v1 request, from
 * the settings below, and drops any the browser sent. Nothing here reaches a production build.
 *
 * Core doesn't serve the session operations yet (`/auth/session`, `/auth/refresh`,
 * `/auth/logout`, `/auth/login` and the `/portal/auth/...` ones), and both apps read the session
 * before they show anything. Until it does, the dev server answers those itself with a synthetic
 * session for the same dev user (`sessionStub`). Turn that off with `SHRI_SESSION_STUB=off` once
 * core serves them in dev_header mode.
 *
 * Settings (environment variables):
 *   SHRI_API=real                 use the local stack (anything else: the mock, as before)
 *   SHRI_API_URL                  where it is (default https://localhost:8443)
 *   SHRI_DEV_USER                 staff dev user: fd, ma, rn, md, app, bil, adm, co, sup, dsp,
 *                                 none, md-b (default fd; backend/app/core/deps.py DEV_USERS)
 *   SHRI_DEV_PATIENT              portal: a synthetic patient's UUID (none: portal calls are 401)
 *   SHRI_DEV_PATIENT_CLINIC       portal: that patient's clinic (default clinic A)
 *   SHRI_SESSION_STUB=off         let the API answer the session operations
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ProxyOptions } from 'vite'

const API = '/api/v1'
const PORTAL = `${API}/portal`

/** The API's synthetic clinics and facilities (backend/app/core/deps.py). */
const CLINIC_A = '0a000000-0000-4000-8000-00000000000a'
const CLINIC_B = '0b000000-0000-4000-8000-00000000000b'
const FACILITY_A = 'fa000000-0000-4000-8000-00000000000a'
const FACILITY_B = 'fb000000-0000-4000-8000-00000000000b'

interface DevUser {
  id: string
  displayName: string
  roles: string[]
  facilityIds: string[]
  organization: { id: string; name: string }
}

function devUser(n: number, roles: string[], displayName: string, clinicB = false): DevUser {
  return {
    id: `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    displayName,
    roles,
    facilityIds: [clinicB ? FACILITY_B : FACILITY_A],
    organization: clinicB ? { id: CLINIC_B, name: 'Dev Clinic B' } : { id: CLINIC_A, name: 'Dev Clinic A' },
  }
}

/** Mirrors the API's DEV_USERS, so the stub session names the user the API signs in. */
export const DEV_USERS: Record<string, DevUser> = {
  ...Object.fromEntries(
    ['FD', 'MA', 'RN', 'MD', 'APP', 'BIL', 'ADM', 'CO', 'SUP', 'DSP'].map((role, i) => [role.toLowerCase(), devUser(i + 1, [role], `Dev ${role}`)]),
  ),
  none: devUser(90, [], 'Dev No Roles'),
  'md-b': devUser(91, ['MD'], 'Dev MD (Clinic B)', true),
}

export interface RealApiSettings {
  target: string
  devUser: string
  devPatient: string | null
  devPatientClinic: string
  stubSessions: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The settings, or `null` when the screens use the mock. Throws on a setting the API would refuse. */
export function realApiSettings(env: Record<string, string | undefined>): RealApiSettings | null {
  if (env.SHRI_API !== 'real') return null
  const devUser = env.SHRI_DEV_USER ?? 'fd'
  if (!(devUser in DEV_USERS)) throw new Error(`SHRI_DEV_USER must be one of: ${Object.keys(DEV_USERS).join(', ')}`)
  const devPatient = env.SHRI_DEV_PATIENT || null
  const devPatientClinic = env.SHRI_DEV_PATIENT_CLINIC || CLINIC_A
  for (const [name, value] of [['SHRI_DEV_PATIENT', devPatient], ['SHRI_DEV_PATIENT_CLINIC', devPatientClinic]] as const) {
    if (value !== null && !UUID.test(value)) throw new Error(`${name} must be a UUID`)
  }
  return {
    target: env.SHRI_API_URL ?? 'https://localhost:8443',
    devUser,
    devPatient,
    devPatientClinic,
    stubSessions: env.SHRI_SESSION_STUB !== 'off',
  }
}

/** Public portal operations (enrollment, pre-registration) go without a sign-in, as in production. */
function isPublicPortal(path: string): boolean {
  return path.startsWith(`${PORTAL}/enrollments`) || path.startsWith(`${PORTAL}/practices/`)
}

/** The sign-in headers the dev server sets on one /api/v1 request. */
export function devHeaders(path: string, s: RealApiSettings): Record<string, string> {
  if (path === PORTAL || path.startsWith(`${PORTAL}/`) || path.startsWith(`${PORTAL}?`)) {
    if (isPublicPortal(path) || s.devPatient === null) return {}
    return { 'X-Dev-Patient': s.devPatient, 'X-Dev-Patient-Clinic': s.devPatientClinic }
  }
  return { 'X-Dev-User': s.devUser }
}

const DEV_HEADERS = ['x-dev-user', 'x-dev-patient', 'x-dev-patient-clinic']

/** The /api/v1 proxy to the local stack. */
export function realApiProxy(s: RealApiSettings): ProxyOptions {
  return {
    target: s.target,
    changeOrigin: true,
    // Nginx's certificate on localhost is self-signed (infra/compose).
    secure: false,
    configure: (proxy) => {
      proxy.on('proxyReq', (req) => {
        for (const name of DEV_HEADERS) req.removeHeader(name)
        for (const [name, value] of Object.entries(devHeaders(req.path, s))) req.setHeader(name, value)
      })
    },
  }
}

const IDLE_MS = 15 * 60_000 // Q20
const ABSOLUTE_MS = 12 * 60 * 60_000

interface StubState {
  signedInAt: number | null
  lastActivity: number
}

/** A synthetic session for the dev user, shaped like the contract's `Session` and `PortalSession`. */
export class SessionStub {
  private readonly staff: StubState
  private readonly portal: StubState
  private readonly settings: RealApiSettings
  private readonly now: () => number

  constructor(settings: RealApiSettings, now: () => number = Date.now) {
    this.settings = settings
    this.now = now
    // The app opens signed in, as it would right after a real sign-in.
    this.staff = { signedInAt: now(), lastActivity: now() }
    this.portal = { signedInAt: settings.devPatient === null ? null : now(), lastActivity: now() }
  }

  /** Any other API call is user activity: it moves the idle limit. */
  activity(path: string): void {
    if (path.startsWith(`${API}/events/stream`) || path.startsWith(`${API}/operations/`)) return
    this.state(path).lastActivity = this.now()
  }

  /** Answers one session operation, or returns `null` for a path the stub doesn't serve. */
  handle(method: string, path: string): { status: number; headers?: Record<string, string>; body?: unknown } | null {
    const portal = path.startsWith(`${PORTAL}/auth/`)
    const op = path.slice((portal ? `${PORTAL}/auth/` : `${API}/auth/`).length).split('?')[0]
    if (!portal && !path.startsWith(`${API}/auth/`)) return null
    const state = portal ? this.portal : this.staff
    if (method === 'GET' && op === 'login') {
      if (portal && this.settings.devPatient === null) return unauthenticated('Set SHRI_DEV_PATIENT to sign in to the portal')
      state.signedInAt = this.now()
      state.lastActivity = this.now()
      return { status: 302, headers: { Location: portal ? '/portal' : '/' } }
    }
    if (!this.signedIn(state)) return unauthenticated('Not signed in')
    if (method === 'GET' && op === 'session') return { status: 200, body: this.session(portal, state) }
    if (method === 'POST' && op === 'refresh') {
      state.lastActivity = this.now()
      return { status: 200, body: this.session(portal, state) }
    }
    if (method === 'POST' && op === 'logout') {
      state.signedInAt = null
      return { status: 204 }
    }
    return null
  }

  private state(path: string): StubState {
    return path.startsWith(`${PORTAL}/`) ? this.portal : this.staff
  }

  private signedIn(state: StubState): boolean {
    if (state.signedInAt === null) return false
    const now = this.now()
    if (now >= state.lastActivity + IDLE_MS || now >= state.signedInAt + ABSOLUTE_MS) state.signedInAt = null
    return state.signedInAt !== null
  }

  private session(portal: boolean, state: StubState): unknown {
    const times = {
      csrfToken: 'dev-csrf-token',
      idleExpiresAt: new Date(state.lastActivity + IDLE_MS).toISOString(),
      expiresAt: new Date((state.signedInAt ?? this.now()) + ABSOLUTE_MS).toISOString(),
    }
    if (portal) return { patient: { displayName: 'Dev Patient' }, ...times }
    const { organization, ...user } = DEV_USERS[this.settings.devUser]!
    return { user, organization, ...times, build: { version: 'dev', commit: 'unknown' } }
  }
}

function unauthenticated(detail: string) {
  return {
    status: 401,
    headers: { 'Content-Type': 'application/problem+json' },
    body: { type: 'tag:company-domain.invalid,2026:problem/unauthenticated', title: 'Not signed in', status: 401, code: 'unauthenticated', detail },
  }
}

/** Serves the stubbed session operations in front of the proxy (see the header comment). */
export function sessionStub(s: RealApiSettings): Plugin {
  const stub = new SessionStub(s)
  return {
    name: 'shri-dev-session-stub',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const path = req.url ?? ''
        if (!path.startsWith(`${API}/`)) return next()
        const answer = stub.handle(req.method ?? 'GET', path)
        if (answer === null) {
          stub.activity(path)
          return next()
        }
        res.statusCode = answer.status
        const headers = { 'Cache-Control': 'no-store', ...(answer.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...answer.headers }
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
        res.end(answer.body === undefined ? undefined : JSON.stringify(answer.body))
      })
    },
  }
}

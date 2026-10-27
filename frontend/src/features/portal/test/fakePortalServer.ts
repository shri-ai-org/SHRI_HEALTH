import { vi } from 'vitest'
import type {
  PortalAllergy,
  PortalAppointment,
  PortalBookingAppointmentType,
  PortalBookingFacility,
  PortalBookingProvider,
  PortalChangeRequest,
  PortalProblem,
  PortalProfile,
  PortalSession,
  PortalSlot,
  PortalVisitSummary,
  PortalVital,
} from '../../../api/generated/model'

/*
 * A fake `/api/v1/portal` for screen tests, shaped as the B8a contract (D89). SYNTHETIC DATA ONLY:
 * made-up names (letters only, as the profile form requires), 555-01xx phones, made-up IDs. It keeps a little state (cancel, booking,
 * change requests) so a journey reads back what it did. Each call starts from fresh data.
 */

export const TZ = 'America/Chicago'
const DAY = 86_400_000

export function id(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

export const IDS = {
  upcoming: id(501),
  past: id(503),
  summary: id(601),
  heldSummary: id(602),
  problem: id(901),
  heldProblem: id(902),
  allergy: id(1001),
  facility: id(101),
  officeVisit: id(301),
  provider: id(201),
} as const

export const INVITATION_CODE = 'ABCD-1234-EFGH'
export const BIRTH_DATE = '1984-07-19'

const address = { lines: ['200 Example Ave', 'Suite 300'], city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US' as const }
const facility = { id: IDS.facility, name: 'Shri Health Springfield Clinic', address }
const provider = { id: IDS.provider, displayName: 'Dr. Alvina56 Hettinger94, MD' }
const officeVisit = { id: IDS.officeVisit, name: 'Office Visit' }

/** An instant `days` from now at 15:30 UTC (morning in Chicago), on a weekday. */
function at(days: number, hourUtc = 15, minute = 30): string {
  const d = new Date(Date.now() + days * DAY)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
  d.setUTCHours(hourUtc, minute, 0, 0)
  return d.toISOString()
}

function appointment(over: Partial<PortalAppointment> & Pick<PortalAppointment, 'id' | 'startAt'>): PortalAppointment {
  return {
    endAt: new Date(Date.parse(over.startAt) + 20 * 60_000).toISOString(),
    timeZone: TZ,
    status: 'booked',
    facility,
    provider,
    appointmentType: officeVisit,
    telehealth: false,
    reasonForVisit: 'Medical Problem Followup Visit',
    canCancel: true,
    canReschedule: true,
    ...over,
  }
}

export interface FakeCall {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  headers: Headers
}

export interface FakeOptions {
  signedIn?: boolean
  /** The first booking answers `409 booking-conflict`. */
  bookingConflict?: boolean
  /** These paths answer `401`, as when the session has ended on the server. */
  unauthorized?: string[]
  /** The held problem wrongly carries content, as a server bug might send (the screen must hide it, D90). */
  heldProblemLeaks?: boolean
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const empty = (status: number) => new Response(null, { status })
const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ type: 'about:blank', title: code, status, code }), { status, headers: { 'Content-Type': 'application/problem+json' } })
const list = <T>(items: T[]) => json(200, { items })

export function fakePortalServer({ signedIn = true, bookingConflict = false, unauthorized = [], heldProblemLeaks = false }: FakeOptions = {}) {
  const calls: FakeCall[] = []
  let conflictLeft = bookingConflict
  let slotReads = 0

  const session = (): PortalSession => ({
    patient: { displayName: 'Ramona' },
    csrfToken: 'test-csrf-token',
    idleExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
  })

  const appointments: PortalAppointment[] = [
    appointment({ id: IDS.upcoming, startAt: at(2) }),
    appointment({ id: IDS.past, startAt: at(-34), status: 'fulfilled', canCancel: false, canReschedule: false, visitSummaryId: IDS.summary, reasonForVisit: 'Annual Physical' }),
  ]
  const summaries: PortalVisitSummary[] = [
    { id: IDS.summary, visitDate: at(-34).slice(0, 10), providerDisplayName: provider.displayName, facilityName: facility.name, releaseStatus: 'available', availableAt: at(-33) },
    { id: IDS.heldSummary, visitDate: at(-3).slice(0, 10), releaseStatus: 'held' },
  ]
  const problems: PortalProblem[] = [
    { id: IDS.problem, releaseStatus: 'available', display: 'Essential hypertension', clinicalStatus: 'active', onsetDate: '2024-03', recordedAt: at(-700) },
    heldProblemLeaks
      ? { id: IDS.heldProblem, releaseStatus: 'held', display: 'Secret diagnosis', clinicalStatus: 'relapse', onsetDate: '2026-09' }
      : { id: IDS.heldProblem, releaseStatus: 'held' },
  ]
  const allergies: PortalAllergy[] = [
    { id: IDS.allergy, display: 'Penicillin', clinicalStatus: 'active', criticality: 'high', reactions: [{ manifestations: ['Hives'] }], recordedAt: at(-1500) },
  ]
  const vitals: PortalVital[] = [-120, -34].flatMap((d, i) => [
    { id: id(700 + i * 2), type: 'blood-pressure' as const, systolic: { value: 138 - i * 7, unit: 'mm[Hg]' }, diastolic: { value: 88 - i * 4, unit: 'mm[Hg]' }, effectiveAt: at(d) },
    { id: id(701 + i * 2), type: 'heart-rate' as const, value: { value: 74 - i * 4, unit: '/min' }, effectiveAt: at(d) },
  ])
  const facilities: PortalBookingFacility[] = [{ id: IDS.facility, name: facility.name, timeZone: TZ, address }]
  const types: PortalBookingAppointmentType[] = [{ id: IDS.officeVisit, name: 'Office Visit', durationMinutes: 20, telehealth: false }]
  const providers: PortalBookingProvider[] = [{ id: IDS.provider, displayName: provider.displayName, specialty: 'Internal medicine' }]
  const changeRequests: PortalChangeRequest[] = []
  const profile = (): PortalProfile => ({
    name: { given: ['Ramona', 'Jean'], family: 'Kuhlman' },
    birthDate: BIRTH_DATE,
    mrn: 'SH-000123',
    phones: [{ number: '+12175550123', use: 'mobile' }],
    email: 'ramona980@example.com',
    address: { lines: ['48 Placeholder St'], city: 'Springfield', state: 'IL', postalCode: '62704', country: 'US' },
    emergencyContact: { name: 'Lucas Kuhlman', relationship: 'Spouse', phone: '+12175550177' },
    preferredLanguage: 'en',
    maritalStatus: 'M',
    pendingChangeRequests: changeRequests.filter((r) => r.status === 'pending'),
  })

  function slots(date: string): PortalSlot[] {
    slotReads += 1
    // 15:00 and 15:20 UTC on the asked date: a morning time in Chicago all year.
    return [0, 20].map((m) => ({ startAt: `${date}T15:${String(m).padStart(2, '0')}:00.000Z`, endAt: `${date}T15:${String(m + 20).padStart(2, '0')}:00.000Z`, providerId: IDS.provider }))
  }

  function route(method: string, path: string, q: URLSearchParams, body: Record<string, unknown>): Response {
    if (unauthorized.includes(path)) return problem(401, 'unauthenticated')
    const one = <T extends { id: string }>(items: T[], key: string) => {
      const found = items.find((x) => x.id === key)
      return found ? json(200, found) : problem(404, 'not-found')
    }
    const m = (re: RegExp) => re.exec(path)

    if (method === 'GET' && path === '/portal/auth/session') return signedIn ? json(200, session()) : problem(401, 'unauthenticated')
    if (method === 'POST' && path === '/portal/auth/refresh') return json(200, session())
    if (method === 'POST' && path === '/portal/auth/logout') return empty(204)
    if (method === 'POST' && path === '/portal/enrollments') {
      const code = String(body.invitationCode ?? '').replace(/[\s-]/g, '').toUpperCase()
      return code === INVITATION_CODE.replace(/-/g, '') && body.birthDate === BIRTH_DATE ? empty(204) : problem(422, 'business-rule-violation')
    }

    if (method === 'GET' && path === '/portal/me') return json(200, profile())
    if (method === 'POST' && path === '/portal/me/change-requests') {
      const r: PortalChangeRequest = { id: id(2000 + changeRequests.length), status: 'pending', changes: body.changes as PortalChangeRequest['changes'], submittedAt: new Date().toISOString() }
      changeRequests.push(r)
      return json(201, r)
    }

    if (method === 'GET' && path === '/portal/me/appointments') {
      const when = q.get('when')
      const now = Date.now()
      return list(appointments.filter((a) => (when === 'upcoming' ? Date.parse(a.endAt) >= now && a.status !== 'cancelled' : when === 'past' ? Date.parse(a.endAt) < now || a.status === 'cancelled' : true)))
    }
    if (method === 'POST' && path === '/portal/me/appointments') {
      if (conflictLeft) {
        conflictLeft = false
        return problem(409, 'booking-conflict')
      }
      const a = appointment({ id: id(5000 + appointments.length), startAt: String(body.startAt), reasonForVisit: String(body.reasonForVisit ?? '') })
      appointments.push(a)
      return json(201, a)
    }
    let hit = m(/^\/portal\/me\/appointments\/([^/]+)\/cancel$/)
    if (method === 'POST' && hit) {
      const a = appointments.find((x) => x.id === hit?.[1])
      if (!a) return problem(404, 'not-found')
      Object.assign(a, { status: 'cancelled', canCancel: false, canReschedule: false })
      return json(200, a)
    }
    hit = m(/^\/portal\/me\/appointments\/([^/]+)\/reschedule$/)
    if (method === 'POST' && hit) {
      const old = appointments.find((x) => x.id === hit?.[1])
      if (!old) return problem(404, 'not-found')
      old.status = 'cancelled'
      const a = appointment({ id: id(5000 + appointments.length), startAt: String(body.startAt) })
      appointments.push(a)
      return json(201, a)
    }
    hit = m(/^\/portal\/me\/appointments\/([^/]+)$/)
    if (method === 'GET' && hit) return one(appointments, hit[1] ?? '')

    if (method === 'GET' && path === '/portal/booking/facilities') return list(facilities)
    if (method === 'GET' && path === '/portal/booking/appointment-types') return list(q.get('facilityId') === IDS.facility ? types : [])
    if (method === 'GET' && path === '/portal/booking/providers') return list(q.get('appointmentTypeId') === IDS.officeVisit ? providers : [])
    if (method === 'GET' && path === '/portal/me/slots') return list(slots(q.get('date') ?? ''))

    if (method === 'GET' && path === '/portal/me/visit-summaries') return list(summaries)
    hit = m(/^\/portal\/me\/visit-summaries\/([^/]+)\/download-url$/)
    if (method === 'GET' && hit) {
      const s = summaries.find((x) => x.id === hit?.[1])
      if (!s || s.releaseStatus === 'held') return problem(404, 'not-found')
      return json(200, { url: `https://files.company-domain.invalid/visit-summary/${s.id}?sig=test`, expiresAt: new Date(Date.now() + 300_000).toISOString() })
    }
    hit = m(/^\/portal\/me\/visit-summaries\/([^/]+)$/)
    if (method === 'GET' && hit) return one(summaries, hit[1] ?? '')

    if (method === 'GET' && path === '/portal/me/problems') return list(problems)
    hit = m(/^\/portal\/me\/problems\/([^/]+)$/)
    if (method === 'GET' && hit) return one(problems, hit[1] ?? '')
    if (method === 'GET' && path === '/portal/me/allergies') return list(allergies)
    hit = m(/^\/portal\/me\/allergies\/([^/]+)$/)
    if (method === 'GET' && hit) return one(allergies, hit[1] ?? '')
    if (method === 'GET' && path === '/portal/me/vitals') return list(vitals)

    throw new Error(`unexpected ${method} ${path}`)
  }

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'https://portal.test')
    const path = u.pathname.replace(/^\/api\/v1/, '')
    const method = init?.method ?? 'GET'
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, query: u.searchParams, body, headers: new Headers(init?.headers) })
    return route(method, path, u.searchParams, (body ?? {}) as Record<string, unknown>)
  })
  vi.stubGlobal('fetch', fetchMock)

  return {
    calls,
    /** The calls to one method and path. */
    to: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
    slotReads: () => slotReads,
  }
}

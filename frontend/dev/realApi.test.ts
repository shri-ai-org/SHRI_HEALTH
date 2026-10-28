import { describe, expect, it } from 'vitest'
import { devHeaders, realApiSettings, SessionStub, type RealApiSettings } from './realApi.ts'

const PATIENT = '11111111-1111-4111-8111-111111111111'
const CLINIC_A = '0a000000-0000-4000-8000-00000000000a'

function settings(env: Record<string, string> = {}): RealApiSettings {
  const s = realApiSettings({ SHRI_API: 'real', ...env })
  if (!s) throw new Error('expected real-API settings')
  return s
}

describe('realApiSettings', () => {
  it('keeps the mock unless SHRI_API=real', () => {
    expect(realApiSettings({})).toBeNull()
    expect(realApiSettings({ SHRI_API: 'mock' })).toBeNull()
  })

  it('defaults to the front desk on the local stack, with the session stub on', () => {
    expect(settings()).toEqual({ target: 'https://localhost:8443', devUser: 'fd', devPatient: null, devPatientClinic: CLINIC_A, stubSessions: true })
  })

  it('refuses a dev user or patient ID the API would refuse', () => {
    expect(() => settings({ SHRI_DEV_USER: 'admin' })).toThrow(/SHRI_DEV_USER must be one of/)
    expect(() => settings({ SHRI_DEV_PATIENT: 'Jane Doe' })).toThrow(/SHRI_DEV_PATIENT must be a UUID/)
    expect(() => settings({ SHRI_DEV_PATIENT_CLINIC: '12' })).toThrow(/SHRI_DEV_PATIENT_CLINIC must be a UUID/)
  })

  it('turns the session stub off on request', () => {
    expect(settings({ SHRI_SESSION_STUB: 'off' }).stubSessions).toBe(false)
  })
})

describe('devHeaders', () => {
  const s = settings({ SHRI_DEV_USER: 'ma', SHRI_DEV_PATIENT: PATIENT })

  it('signs staff calls in as the dev user', () => {
    expect(devHeaders('/api/v1/patients/search', s)).toEqual({ 'X-Dev-User': 'ma' })
  })

  it('signs portal calls in as the dev patient, never as staff', () => {
    expect(devHeaders('/api/v1/portal/me/profile', s)).toEqual({ 'X-Dev-Patient': PATIENT, 'X-Dev-Patient-Clinic': CLINIC_A })
  })

  it('sends public portal calls with no sign-in, as in production', () => {
    expect(devHeaders('/api/v1/portal/enrollments', s)).toEqual({})
    expect(devHeaders('/api/v1/portal/practices/abc/pre-registrations', s)).toEqual({})
  })

  it('sends portal calls with no sign-in when no dev patient is set', () => {
    expect(devHeaders('/api/v1/portal/me/profile', settings())).toEqual({})
  })
})

describe('SessionStub', () => {
  function stub(env: Record<string, string> = {}) {
    let now = Date.parse('2030-01-15T14:00:00Z')
    const s = new SessionStub(settings(env), () => now)
    return { s, advance: (ms: number) => (now += ms) }
  }

  it('answers the staff session for the dev user, in the contract shape', () => {
    const { s } = stub({ SHRI_DEV_USER: 'md' })
    expect(s.handle('GET', '/api/v1/auth/session')).toEqual({
      status: 200,
      body: {
        user: { id: 'd0000000-0000-4000-8000-000000000004', displayName: 'Dev MD', roles: ['MD'], facilityIds: ['fa000000-0000-4000-8000-00000000000a'] },
        organization: { id: CLINIC_A, name: 'Dev Clinic A' },
        csrfToken: 'dev-csrf-token',
        idleExpiresAt: '2030-01-15T14:15:00.000Z',
        expiresAt: '2030-01-16T02:00:00.000Z',
        build: { version: 'dev', commit: 'unknown' },
      },
    })
  })

  it('leaves every other call to the API', () => {
    const { s } = stub()
    expect(s.handle('GET', '/api/v1/patients/abc')).toBeNull()
    expect(s.handle('GET', '/api/v1/auth/callback?code=x')).toBeNull()
  })

  it('reading the session does not extend it; other calls and refresh do', () => {
    const { s, advance } = stub()
    advance(10 * 60_000)
    s.handle('GET', '/api/v1/auth/session')
    advance(6 * 60_000)
    expect(s.handle('GET', '/api/v1/auth/session')?.status).toBe(401)

    s.handle('GET', '/api/v1/auth/login')
    advance(10 * 60_000)
    s.activity('/api/v1/patients/search')
    advance(10 * 60_000)
    expect(s.handle('POST', '/api/v1/auth/refresh')?.status).toBe(200)
  })

  it('the event stream is not activity', () => {
    const { s, advance } = stub()
    advance(10 * 60_000)
    s.activity('/api/v1/events/stream')
    advance(6 * 60_000)
    expect(s.handle('GET', '/api/v1/auth/session')?.status).toBe(401)
  })

  it('signs out, then signs in again through /auth/login', () => {
    const { s } = stub()
    expect(s.handle('POST', '/api/v1/auth/logout')).toEqual({ status: 204 })
    expect(s.handle('GET', '/api/v1/auth/session')).toMatchObject({ status: 401, body: { code: 'unauthenticated' } })
    expect(s.handle('GET', '/api/v1/auth/login')).toEqual({ status: 302, headers: { Location: '/' } })
    expect(s.handle('GET', '/api/v1/auth/session')?.status).toBe(200)
  })

  it('ends at the 12-hour limit even while active', () => {
    const { s, advance } = stub()
    for (let i = 0; i < 12 * 6; i++) {
      advance(10 * 60_000)
      s.activity('/api/v1/patients/search')
    }
    expect(s.handle('GET', '/api/v1/auth/session')?.status).toBe(401)
  })

  it('answers the portal session only with a dev patient', () => {
    expect(stub().s.handle('GET', '/api/v1/portal/auth/session')?.status).toBe(401)
    expect(stub().s.handle('GET', '/api/v1/portal/auth/login')?.status).toBe(401)

    const { s } = stub({ SHRI_DEV_PATIENT: PATIENT })
    expect(s.handle('GET', '/api/v1/portal/auth/session')).toMatchObject({ status: 200, body: { patient: { displayName: 'Dev Patient' }, csrfToken: 'dev-csrf-token' } })
    expect(s.handle('POST', '/api/v1/portal/auth/logout')?.status).toBe(204)
    expect(s.handle('GET', '/api/v1/portal/auth/login')).toEqual({ status: 302, headers: { Location: '/portal' } })
  })

  it('keeps the staff and portal sessions apart', () => {
    const { s } = stub({ SHRI_DEV_PATIENT: PATIENT })
    s.handle('POST', '/api/v1/portal/auth/logout')
    expect(s.handle('GET', '/api/v1/auth/session')?.status).toBe(200)
  })
})

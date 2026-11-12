import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from './client'
import { FrontOfficeLanding, belongsInClinicianApp, clinicianAppPath } from './landing'
import { SessionProvider, resetAutoSignInForTests } from './session'

const later = new Date(Date.now() + 15 * 60_000).toISOString()

function signedInAs(roles: string[]) {
  const body = {
    user: { id: 'u1', displayName: 'Kaia401 Lindgren118', roles, facilityIds: [] },
    organization: { id: 'o1', name: 'Test Clinic' },
    csrfToken: 'tok',
    idleExpiresAt: later,
    expiresAt: later,
  }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })))
}

let replace: ReturnType<typeof vi.fn>
function at(pathname: string) {
  replace = vi.fn()
  vi.stubGlobal('location', { ...window.location, pathname, replace, assign: vi.fn() })
}

beforeEach(() => {
  setCsrfToken(null)
  window.sessionStorage.clear()
  resetAutoSignInForTests()
})
afterEach(() => vi.unstubAllGlobals())

describe('belongsInClinicianApp', () => {
  it.each([
    [['MD'], true],
    [['APP'], true],
    [['RN'], true],
    [['MD', 'RN'], true],
    [['FD'], false],
    [['MA'], false],
    [['ADM'], false],
    [['BIL'], false],
    [['MD', 'FD'], false],
    [['RN', 'ADM'], false],
    [[], false],
    [['DSP'], false],
  ])('%j → %s', (roles, expected) => {
    expect(belongsInClinicianApp(roles)).toBe(expected)
  })
})

describe('clinicianAppPath', () => {
  it('is the clinician path under the build base, never anything else', () => {
    expect(clinicianAppPath('/')).toBe('/clinician/')
    expect(clinicianAppPath('/dep/')).toBe('/dep/clinician/')
    expect(clinicianAppPath('/dep')).toBe('/dep/clinician/')
  })
})

describe('FrontOfficeLanding', () => {
  it.each(['MD', 'APP', 'RN'])('forwards %s to the doctors’ portal before the front office renders', async (role) => {
    at('/patients/outpatients')
    signedInAs([role])
    render(<SessionProvider><FrontOfficeLanding><p>Front office</p></FrontOfficeLanding></SessionProvider>)
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/clinician/'))
    expect(replace).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Front office')).not.toBeInTheDocument()
  })

  it.each(['FD', 'MA', 'ADM'])('keeps %s on the front office, deep links included', async (role) => {
    at('/patients/outpatients')
    signedInAs([role])
    render(<SessionProvider><FrontOfficeLanding><p>Front office</p></FrontOfficeLanding></SessionProvider>)
    expect(await screen.findByText('Front office')).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it('never loops when the front office is served under the clinician path', async () => {
    at('/clinician/')
    signedInAs(['MD'])
    render(<SessionProvider><FrontOfficeLanding><p>Front office</p></FrontOfficeLanding></SessionProvider>)
    expect(await screen.findByText('Front office')).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })
})

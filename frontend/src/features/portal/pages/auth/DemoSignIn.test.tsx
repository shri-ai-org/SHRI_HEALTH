import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../../api/client'
import type { PortalSession } from '../../../../api/generated/model'
import { axeViolations } from '../../../../test/axe'
import { PortalApiContext, type PortalApi } from '../../api/portalApi'
import { PortalRouter } from '../../router'
import { SignInPage } from './SignInPage'

// The demo sign-in on the portal's Sign in page (D121; signInToPortalForDemo, #434). Synthetic
// number and date only; the API is a stand-in.

const SESSION = { patient: { displayName: 'Maria712' }, csrfToken: 'c'.repeat(64), idleExpiresAt: '2035-01-01T16:15:00Z', expiresAt: '2035-01-01T20:00:00Z' } as PortalSession

const problem = (status: number, code: string) => new ApiError({ type: 'about:blank', title: code, status, code, requestId: 'r' } as never)

function renderPage(api: Partial<PortalApi>, onDemoSignIn = vi.fn()) {
  render(
    <PortalApiContext.Provider value={{ startSignIn: vi.fn(), ...api } as unknown as PortalApi}>
      <PortalRouter>
        <SignInPage onDemoSignIn={onDemoSignIn} />
      </PortalRouter>
    </PortalApiContext.Provider>,
  )
  return { user: userEvent.setup(), onDemoSignIn }
}

async function fill(user: ReturnType<typeof userEvent.setup>, mobile: string, birth: string) {
  if (mobile) await user.type(screen.getByLabelText(/Mobile number/), mobile)
  if (birth) await user.type(screen.getByLabelText(/Date of birth/), birth)
  await user.click(screen.getByRole('button', { name: 'Sign in with my mobile number' }))
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the demo sign-in (D121)', () => {
  it('is not on the page in a build without the demo flag', () => {
    renderPage({})
    expect(screen.queryByRole('heading', { name: 'Demo sign-in' })).toBeNull()
    expect(screen.queryByLabelText(/Mobile number/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('signs a new patient in with the mobile number and date of birth', async () => {
    vi.stubEnv('VITE_FEATURE_DEMO_SIGN_IN', 'on')
    const demoSignIn = vi.fn().mockResolvedValue(SESSION)
    const { user, onDemoSignIn } = renderPage({ demoSignIn })
    expect(screen.getByRole('heading', { name: 'Demo sign-in' })).toBeInTheDocument()
    // The patient realm's sign-in stays for patients who already have an account.
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    await fill(user, '(408) 555-0142', '07/19/1984')
    expect(demoSignIn).toHaveBeenCalledWith({ mobileNumber: '(408) 555-0142', birthDate: '1984-07-19' })
    expect(onDemoSignIn).toHaveBeenCalledWith(SESSION)
  })

  it('asks for both fields before sending anything', async () => {
    vi.stubEnv('VITE_FEATURE_DEMO_SIGN_IN', 'on')
    const demoSignIn = vi.fn()
    const { user } = renderPage({ demoSignIn })
    await fill(user, '555-0142', '')
    expect(demoSignIn).not.toHaveBeenCalled()
    expect(screen.getAllByText('Enter your mobile number, for example (408) 555-0142').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Enter your date of birth as MM/DD/YYYY').length).toBeGreaterThan(0)
  })

  it('gives the one answer for every refusal, and a plain line when rate-limited', async () => {
    vi.stubEnv('VITE_FEATURE_DEMO_SIGN_IN', 'on')
    const demoSignIn = vi.fn().mockRejectedValueOnce(problem(422, 'business-rule-violation')).mockRejectedValueOnce(problem(429, 'rate-limited'))
    const { user, onDemoSignIn } = renderPage({ demoSignIn })
    await fill(user, '(408) 555-0142', '07/19/1984')
    expect((await screen.findAllByText(/We couldn't sign you in with those details/)).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Sign in with my mobile number' }))
    expect(await screen.findByText('Too many attempts. Wait a few minutes, then try again.')).toBeInTheDocument()
    expect(onDemoSignIn).not.toHaveBeenCalled()
  })

  it('has no axe violations', async () => {
    vi.stubEnv('VITE_FEATURE_DEMO_SIGN_IN', 'on')
    const { container } = render(
      <PortalApiContext.Provider value={{ startSignIn: vi.fn(), demoSignIn: vi.fn() } as unknown as PortalApi}>
        <PortalRouter>
          <SignInPage onDemoSignIn={vi.fn()} />
        </PortalRouter>
      </PortalApiContext.Provider>,
    )
    expect(await axeViolations(container)).toEqual([])
  })
})

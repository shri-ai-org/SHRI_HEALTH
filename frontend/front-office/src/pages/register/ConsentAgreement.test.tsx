import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ConsentRequirement } from '../../../../src/api/generated/model'
import { ConsentAgreement } from './RegisterFromPortalPage'

// The one consent checkbox on the Financial Policy page. Synthetic requirements only. Plain matchers:
// the front office's type check has no jest-dom types.
const REQUIRED = [
  { kind: 'treatment', title: 'Consent to treatment', policyVersion: '2026-10', required: true, active: true },
  { kind: 'financial', title: 'Financial responsibility and assignment of benefits', policyVersion: '2026-10', required: true, active: true },
] as ConsentRequirement[]

const props = { agreed: false, onAgree: () => undefined, onRetry: () => undefined }

describe('the consent checkbox', () => {
  it('reads the required consents’ titles, and reports the tick', async () => {
    const onAgree = vi.fn()
    render(<ConsentAgreement {...props} requirements={REQUIRED} readError={null} onAgree={onAgree} />)
    const box = screen.getByRole('checkbox', { name: 'The patient agrees to: consent to treatment; financial responsibility and assignment of benefits' })
    await userEvent.setup().click(box)
    expect(onAgree).toHaveBeenCalledWith(true)
  })

  it('shows why Register is blocked once it was tried unticked', () => {
    render(<ConsentAgreement {...props} requirements={REQUIRED} readError={null} error="The patient must agree to the consents before registering." />)
    expect(screen.getByRole('checkbox').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe('The patient must agree to the consents before registering.')
  })

  it('shows a plain message with Try again, and no checkbox, when the requirements cannot be read', async () => {
    const onRetry = vi.fn()
    render(<ConsentAgreement {...props} requirements={null} readError="Service unavailable" onRetry={onRetry} />)
    expect(screen.getByText(/The consents could not be read, so the patient cannot be registered yet\./)).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('shows no checkbox while the requirements load, or when the practice has none', () => {
    const { rerender } = render(<ConsentAgreement {...props} requirements={null} readError={null} />)
    expect(screen.getByText('Loading the consents…')).toBeTruthy()
    rerender(<ConsentAgreement {...props} requirements={[]} readError={null} />)
    expect(screen.getByText(/no required consents set up/)).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})

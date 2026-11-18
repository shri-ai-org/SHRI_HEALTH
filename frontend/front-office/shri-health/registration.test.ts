import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConsentRequirement } from '../../src/api/generated/model'

const registerPatient = vi.fn()
vi.mock('../../src/api/generated/endpoints/patients/patients', () => ({
  registerPatient: (...args: unknown[]) => registerPatient(...args),
  addRelatedPerson: () => Promise.resolve({ status: 201, data: {} }),
  addCoverage: () => Promise.resolve({ status: 201, data: {} }),
}))

const { consentProblem, consentWording, emptyRegistration, newSubmission, submitRegistration, toConsents, toPatientCreate } = await import('./registration')

// The practice's consent requirements as the demo seed has them. Synthetic only.
const requirement = (kind: ConsentRequirement['kind'], title: string, required = true): ConsentRequirement =>
  ({ id: `00000000-0000-4000-8000-${kind.length.toString().padStart(12, '0')}`, kind, title, policyVersion: '2026-10', required, effectiveDate: '2026-10-01', active: true, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }) as ConsentRequirement

const REQUIRED = [
  requirement('treatment', 'Consent to treatment'),
  requirement('privacy-notice', 'Notice of privacy practices'),
  requirement('financial', 'Financial responsibility and assignment of benefits'),
]

const form = (consent: boolean) => {
  const f = emptyRegistration()
  f.basicInfo = { ...f.basicInfo, firstName: 'Avery401', lastName: 'Example118', date: '1990-04-12', phoneNo: '(555) 010-0101', address: '1 Sample Way', city: 'Springfield', state: 'CA', zip: '90001' }
  return { ...f, consent }
}

describe('consents at registration', () => {
  beforeEach(() => registerPatient.mockReset())

  it('words the checkbox from the required requirements’ own titles', () => {
    expect(consentWording(REQUIRED)).toBe(
      'The patient agrees to: consent to treatment; notice of privacy practices; financial responsibility and assignment of benefits',
    )
  })

  it('sends one permitted, electronic consent per required requirement at its policy version', () => {
    const body = toPatientCreate(form(true), undefined, toConsents(REQUIRED, '2026-11-18T17:00:00.000Z'))
    expect(body.consents).toEqual(
      ['treatment', 'privacy-notice', 'financial'].map((kind) => ({ kind, decision: 'permit', signatureMethod: 'electronic', signedAt: '2026-11-18T17:00:00.000Z', policyVersion: '2026-10' })),
    )
    expect(body.consents?.some((consent) => 'grantorRelatedPersonId' in consent)).toBe(false)
  })

  it('sends no consents when the box is not ticked', () => {
    expect(toPatientCreate(form(false), undefined, toConsents(REQUIRED, '2026-11-18T17:00:00.000Z'))).not.toHaveProperty('consents')
  })

  it('blocks Register until the box is ticked, and while the requirements are unread or missing', () => {
    expect(consentProblem(REQUIRED, null, false)).toBe('The patient must agree to the consents before registering.')
    expect(consentProblem(REQUIRED, null, true)).toBeUndefined()
    expect(consentProblem(null, null, true)).toMatch(/could not be read/)
    expect(consentProblem(null, 'Service unavailable', true)).toMatch(/could not be read/)
    expect(consentProblem([], null, true)).toMatch(/could not be read/)
  })

  it('keeps the same signing time on a retry, so the same Idempotency-Key carries the same body', async () => {
    registerPatient.mockResolvedValueOnce({ status: 503, data: {} }).mockResolvedValueOnce({ status: 201, data: { id: 'p1', mrn: 'M1' } })
    const first = await submitRegistration(form(true), newSubmission(), undefined, REQUIRED)
    expect(first.kind).toBe('failed')
    await submitRegistration(form(true), first.submission, undefined, REQUIRED)
    const [[bodyA, headersA], [bodyB, headersB]] = registerPatient.mock.calls
    expect(bodyB).toEqual(bodyA)
    expect(headersB).toEqual(headersA)
    expect(bodyA.consents).toHaveLength(3)
  })
})

import { describe, expect, it, vi } from 'vitest'

import type { ConsentRequirement } from '../../src/api/generated/model'

// Which consent requirements registration covers (loadConsentRequirements): only the practice's
// active, required ones. The optional ones (telehealth, recording) and retired versions are never
// sent with the patient. Synthetic requirements only.
const requirement = (kind: ConsentRequirement['kind'], title: string, required: boolean, active = true, policyVersion = '2026-10'): ConsentRequirement =>
  ({ id: `${kind}-${policyVersion}`, kind, title, policyVersion, required, effectiveDate: '2026-10-01', active, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }) as ConsentRequirement

const ALL = [
  requirement('ambient-recording', 'Recording of the visit for note drafting', false),
  requirement('financial', 'Financial responsibility and assignment of benefits', true),
  requirement('privacy-notice', 'Notice of privacy practices', true, false, '2026-01'),
  requirement('privacy-notice', 'Notice of privacy practices', true),
  requirement('telehealth', 'Telehealth consent', false),
  requirement('treatment', 'Consent to treatment', true),
]

const registerPatient = vi.fn()
vi.mock('../../src/api/generated/endpoints/practice-setup/practice-setup', () => ({
  listConsentRequirements: () => Promise.resolve({ status: 200, data: { items: ALL } }),
  listPayers: () => Promise.resolve({ status: 200, data: { items: [] } }),
}))
vi.mock('../../src/api/generated/endpoints/patients/patients', () => ({
  registerPatient: (...args: unknown[]) => registerPatient(...args),
  addRelatedPerson: () => Promise.resolve({ status: 201, data: {} }),
  addCoverage: () => Promise.resolve({ status: 201, data: {} }),
}))

const { emptyRegistration, loadConsentRequirements, newSubmission, submitRegistration } = await import('./registration')

describe('the consent requirements registration covers', () => {
  it('keeps only the active, required requirements', async () => {
    const kept = await loadConsentRequirements()
    expect(kept.map((r) => `${r.kind}@${r.policyVersion}`)).toEqual(['financial@2026-10', 'privacy-notice@2026-10', 'treatment@2026-10'])
  })

  it('never sends the optional ones (telehealth, recording) with the patient', async () => {
    registerPatient.mockResolvedValueOnce({ status: 201, data: { id: 'p1', mrn: 'M1' } })
    const form = { ...emptyRegistration(), consent: true }
    form.basicInfo = { ...form.basicInfo, firstName: 'Avery401', lastName: 'Example118', date: '1990-04-12', phoneNo: '(408) 555-0101', address: '1 Sample Way', city: 'San Jose', state: 'CA', zip: '95112' }
    await submitRegistration(form, newSubmission(), undefined, await loadConsentRequirements())
    const sent = (registerPatient.mock.calls[0]?.[0] as { consents: { kind: string }[] }).consents.map((c) => c.kind)
    expect(sent).toEqual(['financial', 'privacy-notice', 'treatment'])
    expect(sent).not.toContain('telehealth')
    expect(sent).not.toContain('ambient-recording')
  })
})

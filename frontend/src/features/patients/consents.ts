import { listConsentRequirements } from '../../api/generated/endpoints/practice-setup/practice-setup'
import type { ConsentCreate, ConsentRequirement } from '../../api/generated/model'

// The consents the patient agrees to at registration (D120), as the front office's register
// wizard does (front-office/shri-health/registration.ts). The API keeps consents optional; this
// page asks for the practice's required ones before it registers.

/** The practice's active, required consent requirements. Throws when they can't be read, so Register is blocked rather than guessed. */
export async function loadRequiredConsents(): Promise<ConsentRequirement[]> {
  const res = await listConsentRequirements({ limit: 100 })
  if (res.status !== 200) throw new Error('Consent requirements could not be read')
  return res.data.items.filter((requirement) => requirement.active && requirement.required)
}

/** The checkbox's wording, built from the requirements' own titles (never hard-coded consents). */
export function consentWording(requirements: ConsentRequirement[]): string {
  const titles = requirements.map((requirement) => requirement.title.charAt(0).toLowerCase() + requirement.title.slice(1))
  return `The patient agrees to: ${titles.join('; ')}`
}

/** Why Register is blocked on the consents, or undefined when it may go ahead. */
export function consentProblem(requirements: ConsentRequirement[] | null, readError: boolean, agreed: boolean): string | undefined {
  if (readError || !requirements || requirements.length === 0) return 'The consents could not be read, so the patient cannot be registered yet.'
  return agreed ? undefined : 'The patient must agree to the consents before registering.'
}

/** One permitted, electronically signed consent per required requirement, at its policy version. */
export function toConsents(requirements: ConsentRequirement[], signedAt: string): ConsentCreate[] {
  return requirements.map((requirement) => ({
    kind: requirement.kind,
    decision: 'permit',
    signatureMethod: 'electronic',
    signedAt,
    policyVersion: requirement.policyVersion,
  }))
}

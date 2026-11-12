// SHRI_HEALTH data layer: break-glass for a restricted chart (D37, SECURITY_MODEL §5.2). A read the
// server refuses with `403 break-glass-required` is shown as the portal's own sealed card
// (src/shri/overlays/QuickPanel.tsx `SealedBody`, from src/shri/app/RouteBoundary.tsx); "Record and
// open" asks POST /patients/{id}/break-glass, then the screen reads again.
// Field mapping, BreakGlassRequest ⇐ the card: reasonCode ⇐ `other` (the card asks in the user's
// own words, not a picklist), reasonText ⇐ what they wrote.
import { useSession } from '@/store/session'

import { ApiError, newIdempotencyKey } from '../../src/api/client'
import { breakGlass } from '../../src/api/generated/endpoints/platform/platform'

import { forgetAll } from './resource'

/** The restricted patient a refusal names, or null when the error isn't `break-glass-required`. */
export function breakGlassPatientOf(error: unknown, path: string): string | null {
  if (!(error instanceof ApiError) || error.problem.code !== 'break-glass-required') return null
  // The screen's address names the patient (/patient/{id}/…) or, for a visit, the problem's instance does.
  const fromPath = /\/patient\/([0-9a-f-]{36})/i.exec(path)?.[1]
  const instance = (error.problem as { instance?: string }).instance ?? ''
  const fromInstance = /\/patients\/([0-9a-f-]{36})/i.exec(instance)?.[1]
  return fromPath ?? fromInstance ?? null
}

/** Records the break-glass on the server, then forgets what the screens read, so they read again. */
export async function breakGlassOnServer(patientId: string, reason: string): Promise<void> {
  const res = await breakGlass(patientId, { reasonCode: 'other', reasonText: reason }, { 'Idempotency-Key': newIdempotencyKey() })
  if (res.status !== 200) throw new Error('Break-glass was not recorded')
  // The banner's own notice ("Break-glass access — logged and reviewed within 24 hours").
  useSession.getState().grantBreakGlass(patientId, reason)
  forgetAll()
}

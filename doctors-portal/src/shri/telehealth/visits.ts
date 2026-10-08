// Telehealth's video visits are the shared teleconsults (TELECONSULT_QUEUE) — the
// same patients, times and reasons the Dashboard, the OPD queue and Patients Today
// show — and nothing of Telehealth's own, so every screen agrees on who is seen by
// video today.
//
// Beside them, each patient's answer to “May we record this visit?”, given in the
// patient portal before the call — never asked by the doctor. Demo answers until
// the portal is connected.

import { TELECONSULT_QUEUE, type TeleRow } from '@/data/clinical'

const PORTAL_CONSENT: Record<string, 'given' | 'declined'> = {
  // Arjun Nair agreed. Fatima Bi, on a phone call only, has not answered yet.
  'SD-P-10': 'given',
}
export const portalConsent = (patientId: string): 'given' | 'declined' | undefined => PORTAL_CONSENT[patientId]

/** Every video visit of the day, in appointment order. */
export const VISITS: TeleRow[] = [...TELECONSULT_QUEUE].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())

export const visitFor = (patientId: string) => VISITS.find((v) => v.patientId === patientId)

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
export const visitById = (visitId: string) => VISITS.find((v) => v.id === visitId)

/**
 * Each booked visit's video room, there before the doctor starts — so the patient
 * can be in it, waiting. For now it is the visit and the demonstration's code
 * (demoCode.ts): the doctor's page passes its own code, the patient demo page the
 * code typed in, so every person and every reload has rooms of its own. The
 * backend will issue each visit a private room instead.
 */
export const roomOfVisit = (visitId: string, code: string): string => `ShriHealth-${visitId.replace(/[^A-Za-z0-9]/g, '')}-${code}`

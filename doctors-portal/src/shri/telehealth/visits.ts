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
 * Each booked visit's own video room, made with the booking — so the patient can
 * be in it, waiting, before the doctor starts. The backend will issue these, each
 * private to its visit; until then they are fixed here, the same for the doctor's
 * page and the patient's.
 */
const ROOM_KEY: Record<string, string> = {
  'E-118430': 'q7KfTz2LmW9x',
  'E-118452': 'Hn4vRb8YpC3s',
}
export const roomOfVisit = (visitId: string): string | undefined =>
  ROOM_KEY[visitId] ? `ShriHealth-${visitId.replace(/[^A-Za-z0-9]/g, '')}-${ROOM_KEY[visitId]}` : undefined

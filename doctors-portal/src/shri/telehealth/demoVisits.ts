// Telehealth's own demo day, on top of the shared clinic data: the two teleconsults
// the rest of the build knows (TELECONSULT_QUEUE — My Day counts them, so they stay
// as they are) and four more video visits that live only here, so the list reads
// like a real morning — one already finished, the rest booked through the day.
//
// The finished one carries its conversation, so the Finished visits list and the
// after-call page show what a done visit looks like. It is demo data: marked so,
// and never sent to the transcript store on the server.

import { TELECONSULT_QUEUE, type TeleRow } from '@/data/clinical'
import { minutesAgo, minutesAhead } from '@/data/format'

import type { TeleSegment } from './teleTypes'

export const EXTRA_VISITS: TeleRow[] = [
  { id: 'TV-0801', patientId: 'SD-P-01', scheduledAt: minutesAgo(40), reason: 'Thyroid blood test results', videoReady: true, rankReason: '' },
  { id: 'TV-1215', patientId: 'SD-P-11', scheduledAt: minutesAhead(215), reason: 'Three-week check after head surgery', videoReady: true, rankReason: '' },
  { id: 'TV-1400', patientId: 'SD-P-15', scheduledAt: minutesAhead(320), reason: 'Migraine follow-up', videoReady: true, rankReason: '' },
  { id: 'TV-1530', patientId: 'SD-P-04', scheduledAt: minutesAhead(410), reason: 'Pregnancy check-in, 32 weeks', videoReady: false, rankReason: '' },
]

/**
 * Each patient's answer to “May we record this visit?”, given in the patient
 * portal before the call — never asked by the doctor. Demo answers until the
 * portal is connected: four agreed, Lakshmi declined, Sunita has not answered.
 */
const PORTAL_CONSENT: Record<string, 'given' | 'declined'> = {
  'SD-P-01': 'given',
  'SD-P-09': 'given',
  'SD-P-10': 'given',
  'SD-P-11': 'given',
  'SD-P-15': 'declined',
}
export const portalConsent = (patientId: string): 'given' | 'declined' | undefined => PORTAL_CONSENT[patientId]

/** Every video visit of the day, in appointment order. */
export const VISITS: TeleRow[] = [...TELECONSULT_QUEUE, ...EXTRA_VISITS].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())

export const visitFor = (patientId: string) => VISITS.find((v) => v.patientId === patientId)

/* ------------------------------------------------------------ the visit already finished this morning */

export const DEMO_SID = 'TC-demo-SD-P-01'
const t0 = minutesAgo(40).getTime()
const line = (n: number, speaker: 'doctor' | 'patient', at: number, text: string): TeleSegment => ({
  id: `demo${n}`,
  speaker,
  text,
  startMs: t0 + at * 1000,
  endMs: t0 + at * 1000 + 4000,
  source: 'shri-asr',
})

export const DEMO_SESSION = {
  id: DEMO_SID,
  patientId: 'SD-P-01',
  consent: 'given' as const,
  startedAt: t0,
  endedAt: t0 + 6 * 60_000 + 20_000,
  demo: true,
  segments: [
    line(1, 'doctor', 8, 'Good morning Meera. I have your thyroid report here.'),
    line(2, 'patient', 15, 'Good morning doctor. Is it normal now?'),
    line(3, 'doctor', 22, 'Your TSH has come down to 3.1, which is in the normal range. The tablet is working.'),
    line(4, 'patient', 34, 'That is good. I still feel a little tired in the evenings.'),
    line(5, 'doctor', 41, 'That can take a few more weeks. Keep taking 50 micrograms every morning, before food.'),
    line(6, 'patient', 52, 'Should I stop it after that?'),
    line(7, 'doctor', 58, 'No, please continue. We will repeat the blood test in three months.'),
    line(8, 'patient', 66, 'Okay doctor, thank you.'),
  ],
  unsynced: [],
  metaDirty: false,
  rev: 0,
}

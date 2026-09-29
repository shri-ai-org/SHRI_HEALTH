// ported from src/screens/m08/S0807.tsx:30-58 (AI-211's three pre-scored
// scales, word for word) and 101-104 (CMP-NABH-01's 24-hour clock).
//
// The scales — "Acute infection", VTE prophylaxis "already prescribed, renally
// adjusted" — and the admission note carried forward are R. Lakshmanan's. The
// old screen showed them, and carried his note into, every patient's
// assessment. Here they are his; anyone else is scored on the manual scales,
// the fallback and the authority, and has nothing to carry forward that is not
// theirs.

import { NOTE_DRAFT_SD_P_03, type Encounter } from '@/data/clinical'
import { NOW } from '@/data/format'

export interface RiskScale {
  key: 'falls' | 'pressure' | 'vte'
  name: string
  score?: number
  band?: 'High' | 'Moderate'
  drivers: string[]
  action?: string
  confidence?: number
}

const SCALE_NAMES: Record<RiskScale['key'], string> = {
  falls: 'Falls risk — Morse',
  pressure: 'Pressure ulcer — Braden',
  vte: 'VTE risk — Padua',
}

const PRESCORED: Record<string, RiskScale[]> = {
  'SD-P-03': [
    {
      key: 'falls',
      name: SCALE_NAMES.falls,
      score: 55,
      band: 'High',
      drivers: ['History of falling', 'Intravenous access in situ', 'Weak gait'],
      action: 'Bed in the low position, call bell within reach, hourly rounding.',
      confidence: 0.84,
    },
    {
      key: 'pressure',
      name: SCALE_NAMES.pressure,
      score: 14,
      band: 'Moderate',
      drivers: ['Reduced mobility', 'Poor oral intake', 'Moisture from diaphoresis'],
      action: 'Two-hourly repositioning, pressure-redistributing mattress, skin inspection each shift.',
      confidence: 0.79,
    },
    {
      key: 'vte',
      name: SCALE_NAMES.vte,
      score: 5,
      band: 'High',
      drivers: ['Acute infection', 'Reduced mobility > 3 days', 'Age over 70 — not met'],
      action: 'Pharmacological prophylaxis unless contraindicated. Already prescribed, renally adjusted.',
      confidence: 0.88,
    },
  ],
}

/** The three scales for this patient: AI-211's pre-scores where they were drawn from the patient's record, otherwise the manual scales alone. */
export function scalesFor(patientId: string): RiskScale[] {
  return PRESCORED[patientId] ?? (Object.keys(SCALE_NAMES) as RiskScale['key'][]).map((key) => ({ key, name: SCALE_NAMES[key], drivers: [] }))
}

/** The admission note a history can be carried forward from, where the record holds one. */
const ADMISSION_NOTES: Record<string, string> = { 'SD-P-03': NOTE_DRAFT_SD_P_03[0].draft }

export function admissionNoteFor(patientId: string): string | undefined {
  return ADMISSION_NOTES[patientId]
}

/** CMP-NABH-01 — the initial assessment is due within 24 hours of admission. */
export function nabhClock(enc: Encounter): { hoursSince: number; overdue: boolean; remaining: number } {
  const hoursSince = (NOW.getTime() - enc.startedAt.getTime()) / 3_600_000
  return { hoursSince, overdue: hoursSince > 24, remaining: Math.max(0, 24 - hoursSince) }
}

export const NUTRITION = ['Not at risk', 'At risk', 'High risk — dietitian referral']
export const FUNCTION = ['Independent', 'Needs assistance', 'Fully dependent']

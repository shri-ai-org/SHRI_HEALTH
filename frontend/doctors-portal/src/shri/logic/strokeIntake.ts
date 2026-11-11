// ported from src/screens/m18/S1805.tsx:34-53, 189-217 — the activation
// intake's triage note, what AI-112 extracts from it, and the choices the
// form offers.
//
// The note and its extractions are the index case's (0141's: "No warfarin").
// The old screen offered them on every case — 0142, who is on warfarin,
// included. Here they belong to their case (`triageFor`); another case has no
// note on file and its six fields are typed.

import type { ConfidenceBand } from '@/atlas/confidence'
import { ACTIVE_CASE, type StrokeCase } from '@/data/stroke'

/** The triage note AI-112 extracts from, so nothing is typed twice. */
export const TRIAGE_TEXT = `47M brought by wife. Was normal at 0120 when they went to bed. Wife woke at 0200 to find him unable to speak properly with the right arm hanging. BP 196/104 on arrival, CBG 7.2, afebrile. No warfarin. She thinks he takes something for his heart but is not sure what.`

export interface Extraction {
  key: string
  label: string
  value: string
  confidence: number
  band: ConfidenceBand
}

export const EXTRACTED: Extraction[] = [
  { key: 'lkw', label: 'Last known well', value: '01:20', confidence: 0.92, band: 'HIGH' },
  { key: 'deficit', label: 'Deficit', value: 'Right arm weakness with dysarthria', confidence: 0.88, band: 'HIGH' },
  { key: 'bp', label: 'Blood pressure', value: '196/104', confidence: 0.96, band: 'HIGH' },
  { key: 'glucose', label: 'Capillary glucose', value: '7.2 mmol/L', confidence: 0.94, band: 'HIGH' },
  { key: 'anticoag', label: 'Anticoagulation', value: 'Uncertain — "something for his heart"', confidence: 0.41, band: 'LOW' },
]

/** The triage note and its extractions, for the case they were written for. */
export function triageFor(c: StrokeCase): { text: string; extracted: Extraction[] } | undefined {
  return c.id === ACTIVE_CASE.id ? { text: TRIAGE_TEXT, extracted: EXTRACTED } : undefined
}

export const EXCLUSIONS = ['Recent major surgery', 'Prior intracranial haemorrhage', 'Known bleeding disorder', 'Recent stroke within 3 months']
export const EXCLUSION_ANSWERS = ['No', 'Yes', 'Unknown']

export const MRS = [
  '0 — no symptoms',
  '1 — no significant disability',
  '2 — slight disability, independent',
  '3 — moderate disability, walks unaided',
  '4 — moderately severe, needs assistance',
  '5 — severe disability, bedridden',
]

export const LIVES = ['At home, independently', 'At home, with family support', 'In residential care']

/**
 * The exclusions line. The old one always read "None recorded", whatever the
 * four answers were; this says what is recorded.
 */
export function exclusionsLine(answers: Record<string, string>): string {
  const marked = EXCLUSIONS.filter((x) => (answers[x] ?? 'No') !== 'No').map((x) => `${x}: ${answers[x]}`)
  return marked.length === 0 ? 'None recorded · a no is as useful as a yes' : marked.join(' · ')
}

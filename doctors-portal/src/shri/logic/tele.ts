/**
 * Ported from `src/screens/m27/Telehealth.tsx` — who is on a teleconsult and
 * the tele-prescribing category gate (CMP-DRUG-06, AI-310).
 *
 * The gate is HARD-CODED and never AI-decided: "the prohibited list is never
 * off." A teleconsult can prescribe less than a face-to-face consultation can,
 * and the category is tied to the consultation mode by the Telemedicine
 * Practice Guidelines 2020 — the law rather than a policy choice.
 */

import { encounterForPatient, maybeEncounter, type Encounter } from '@/data/clinical'
import { patient, patientByAnyId, type Patient } from '@/data/kit'

import type { Tone } from '../mocks/types'

export interface TeleParty {
  patient: Patient
  /** The visit the note and the prescription are written against, where one exists. */
  encounter?: Encounter
}

/**
 * The session is keyed by whoever sent you here: a teleconsult encounter from
 * the queue, or a patient (SD id or UHID) from the Connect button on their
 * record. An unknown id says so instead of silently showing someone else.
 */
export function teleParty(id: string | undefined): TeleParty | undefined {
  const enc = maybeEncounter(id)
  if (enc) return { patient: patient(enc.patientId), encounter: enc }
  const p = patientByAnyId(id)
  return p ? { patient: p, encounter: encounterForPatient(p.id) } : undefined
}

export type TeleMode = 'video' | 'telephone'
export type Category = 'O' | 'A' | 'B' | 'Prohibited'

export const TELE_FORMULARY: { drug: string; category: Category; why: string }[] = [
  { drug: 'Paracetamol 1g IV', category: 'O', why: 'Over-the-counter. Prescribable on any consultation mode.' },
  { drug: 'Atorvastatin 40mg', category: 'B', why: 'Add-on to an existing prescription for the same condition only.' },
  { drug: 'Metformin 500mg', category: 'B', why: 'Add-on for an established condition already under management.' },
  { drug: 'Co-amoxiclav 1.2g IV', category: 'A', why: 'Permitted on a first video teleconsult, or a re-consult for the same condition.' },
  { drug: 'Clopidogrel 75mg', category: 'B', why: 'Add-on only; not a first prescription by telemedicine.' },
  { drug: 'Tenecteplase', category: 'Prohibited', why: 'Never by telemedicine. Parenteral thrombolytic.' },
]

export const CATEGORIES: { c: Category; t: string }[] = [
  { c: 'O', t: 'Over-the-counter. Any consultation mode.' },
  { c: 'A', t: 'First video teleconsult, or a re-consult for the same condition.' },
  { c: 'B', t: 'Add-on to an existing prescription for the same condition only.' },
  { c: 'Prohibited', t: 'Never by telemedicine. Includes Schedule X and narcotics.' },
]

/** The old tones (normal · brand · caution · critical) in this build's words. */
export const CATEGORY_TONE: Record<Category, Tone> = { O: 'norm', A: 'pend', B: 'warn', Prohibited: 'crit' }

/** The gate. Never AI-decided; never off. `null` means the drug may be prescribed on this mode. */
export function blockedReason(drug: string, mode: TeleMode): string | null {
  const entry = TELE_FORMULARY.find((f) => f.drug === drug)
  if (!entry) return null
  if (entry.category === 'Prohibited') return 'On the prohibited list. This cannot be prescribed by telemedicine under any circumstances.'
  if (mode === 'telephone' && entry.category === 'A')
    return 'List A requires a video teleconsult. On a telephone teleconsult only List O and List B add-ons are permitted.'
  return null
}

// ported from src/screens/shared/NoteAuthoring.tsx:70-74 (`encounterLabel`):
// "OP number 26-27/118402" — the number staff quote, with its kind said once.

import { ENCOUNTERS, type Encounter } from '@/data/clinical'

export function encounterLabel(enc: Encounter): string {
  const [kind, ...rest] = enc.encounterNo.split('/')
  return `${kind} number ${rest.join('/')}`
}

/** The encounter at an address, or none — an unknown id says so rather than throwing (`encounter()` throws). */
export function maybeEncounter(id: string | undefined): Encounter | undefined {
  return id ? ENCOUNTERS.find((e) => e.id === id) : undefined
}

import type { CoverageCreateRelationshipToSubscriber } from '../../../api/generated/model'

/**
 * The patient's relationship to the subscriber, in front-desk words (FHIR subscriber-relationship
 * codes). Keyed by the contract's enum, so a new or renamed code fails the type check.
 */
export const RELATIONSHIP: Record<CoverageCreateRelationshipToSubscriber, string> = {
  self: 'Self',
  spouse: 'Spouse',
  child: 'Child',
  parent: 'Parent',
  common: 'Common-law spouse',
  other: 'Other',
  injured: 'Injured party',
}

/** The contract allows priorities 1–9 among a patient's active coverages. */
export const PRIORITIES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

const NAMED = ['Primary', 'Secondary', 'Tertiary']

/** "Primary", "Secondary", "Tertiary", then "4th" … "9th". */
export function priorityLabel(order: number): string {
  return NAMED[order - 1] ?? `${order}th`
}

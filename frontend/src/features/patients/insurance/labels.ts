/** The patient's relationship to the subscriber, in front-desk words (FHIR subscriber-relationship codes). */
export const RELATIONSHIP: Record<string, string> = {
  self: 'Self',
  spouse: 'Spouse',
  child: 'Child',
  parent: 'Parent',
  common: 'Common-law spouse',
  other: 'Other',
  injured: 'Injured party',
}

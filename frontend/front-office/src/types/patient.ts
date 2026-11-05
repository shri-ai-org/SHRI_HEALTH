// Patient domain model — derived from src/domain/seedData.js's own model
// comment and every shape actually produced by actions.js/selectors.js.

export type Sex = 'Male' | 'Female' | 'Other'

export interface Patient {
  patientId: string
  uhid: string
  name: string
  nameNative: string | null
  age: number | null
  sex: Sex
  mobile: string
  email: string | null
  address: string | null
  abhaId: string | null
  registrationStatus: 'Registered'
  /** Known transliterated spellings, used by search only. Not every patient has one. */
  aliases?: string[]
  createdAt: number
}

/** actions.registerPatient's input shape. */
export interface RegisterPatientInput {
  name: string
  age: number | string
  sex: Sex | ''
  mobile: string
  abhaId?: string
  address?: string
  /** An age of 100 or more has been confirmed with the patient. */
  ageConfirmed?: boolean
}

/** actions.updatePatientDemographics's input shape — a partial edit. */
export interface PatientDemographicsInput {
  name?: string
  age?: number | string
  /** An age of 100 or more has been confirmed with the patient. */
  ageConfirmed?: boolean
  sex?: Sex
  mobile?: string
  email?: string | null
  address?: string | null
}

/** One row of domain/selectors.searchPatients. */
export interface PatientSearchMatch {
  patient: Patient
  matchedOn: 'UHID' | 'Name' | 'Name (native script)' | 'Name (known alias)' | 'Mobile' | 'ABHA number' | 'ABHA ID'
  /** How well it matched: 4 exact · 3 starts with · 2 word starts · 1 contains. */
  tier: number
}

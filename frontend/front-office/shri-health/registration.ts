// Registration on the SHRI_HEALTH API, for the register screen converted from the Angular patient
// portal's registration wizard (patientportal_frontend, registration.component; Minalini's exception
// of 2026-11-03 to "connect, never create").
//
// The form keeps the Angular form groups and formControlNames (basicInfo, choicesForm, AddInfo, …),
// so the two can be compared name by name. Stage 1 sends Demographics, Emergency Contact, Choices
// (SMS), Responsible Party and Insurance Details; everything else stays on the screen with a TODO
// (frontend/docs/SCREEN_PORT.md, "Registration from the patient portal").
//
// Field mapping, Angular ⇒ contract:
//   basicInfo.firstName, middleName, lastName ⇒ name.given[first, middle], name.family
//   basicInfo.date                             ⇒ birthDate (required, D44)
//   basicInfo.phoneNo + choicesForm.AllowSMS   ⇒ phones[0] (US number as E.164 +1…, textMessages)
//   basicInfo.ssn                              ⇒ never (no SSN, D27, D43)
//   basicInfo.address, city, state, zip        ⇒ address (lines, city, state, postalCode); country is US
//   basicInfo.maritalStatus, gender, email     ⇒ maritalStatus (v3 code), gender, emails[0]
//   choicesForm.Language                       ⇒ preferredLanguage (BCP 47)
//   choicesForm.provider                       ⇒ generalPractitionerId once #225 merges (left out until then; it would be refused)
//   basicInfo.relation*                        ⇒ addRelatedPerson: v2-0131 C emergency contact + the relation
//   choicesForm.ResponsibleParty               ⇒ "Same as Emergency Contact" adds v3 RoleCode GUAR to that person
//   choicesForm.insuranceCompany, policyNumber,
//     groupNumber, planName, relationship      ⇒ addCoverage (payerId, memberId, groupNumber, planName,
//                                                relationshipToSubscriber), order 1
//   Not sent (no place in the contract yet): AllowPatientPortal, AllowEmail, the insurance
//   City/State/Country/Zip, Add Insurance, ResponsibleParty "Other".
import {
  addCoverage as apiAddCoverage,
  addRelatedPerson as apiAddRelatedPerson,
  registerPatient as apiRegisterPatient,
} from '../../src/api/generated/endpoints/patients/patients'
import { listPayers as apiListPayers } from '../../src/api/generated/endpoints/practice-setup/practice-setup'
import { listBookableProviders as apiListBookableProviders } from '../../src/api/generated/endpoints/scheduling/scheduling'
import type {
  CodedValue,
  CoverageCreate,
  CoverageCreateRelationshipToSubscriber,
  PatientCreate,
  PatientCreateMaritalStatus,
  RelatedPersonCreate,
} from '../../src/api/generated/model'
import { ApiError, newIdempotencyKey } from './client'

// ---- The form: the Angular form groups, control for control ---------------------------------

export interface BasicInfo {
  firstName: string
  middleName: string
  lastName: string
  date: string
  phoneNo: string
  address: string
  city: string
  state: string
  country: string
  zip: string
  maritalStatus: string
  gender: string
  email: string
  relationFirstname: string
  relationLastname: string
  relationPhoneno: string
  relation: string
  relationEmail: string
}

export interface ChoicesForm {
  provider: string
  AllowPatientPortal: string
  AllowSMS: string
  AllowEmail: string
  Language: string
  ResponsibleParty: string
  payMethod: string
  insuranceCompany: string
  planName: string
  policyNumber: string
  groupNumber: string
  City: string
  State: string
  Country: string
  Zip: string
  relationship: string
  newInsuranceCompany: string
  newInsuranceCity: string
  newInsuranceState: string
  newInsuranceCountry: string
  newInsuranceZip: string
  newInsurancePlanName: string
  newInsurancePolicyNumber: string
  newInsuranceGroupNumber: string
}

export interface AddInfo {
  pharmacyName: string
  City: string
  State: string
  Country: string
  Zip: string
  newPharmacyName: string
  newPharmacyCity: string
  newPharmacyState: string
  newPharmacyCountry: string
  newPharmacyZip: string
}

export interface MedicationForm {
  medication: string
  medicationInfo: string
  allergies: string
  allergiesInfo: string
}

export const FAMILY_DISEASES = [
  { key: 'selectedAneamia', label: 'Aneamia' },
  { key: 'selectedAsthma', label: 'Asthma/Allergies' },
  { key: 'selectedBleeding', label: 'Bleeding/Clotting' },
  { key: 'selectedCancer', label: 'Cancer' },
  { key: 'selectedDiabetes', label: 'Diabetes/Sugar' },
  { key: 'selectedEpilepsy', label: 'Epilepsy' },
  { key: 'selectedheartDisease', label: 'Heart Disease' },
  { key: 'selectedskinDisease', label: 'Skin Disease' },
  { key: 'selectedkidneyDisease', label: 'Kidney Disease' },
] as const
export type FamilyDiseaseKey = (typeof FAMILY_DISEASES)[number]['key']

export interface FamilyHistoryForm extends Record<FamilyDiseaseKey, string[]> {
  familyHistoryInfo: string
}

export interface SocialHistoryForm {
  selectedtobaccoHistory: string[]
  selectedalcoholHistory: string[]
  selectedDrugAbuse: string[]
  selectedCardioVascular: string[]
  socialMedicalHistoryInfo: string
}

export const SURGERIES_GENERAL = [
  { key: 'Angioplasty', label: 'Angioplasty' },
  { key: 'Appendectomy', label: 'Appendectomy' },
  { key: 'Arthroscopy', label: 'Arthroscopy Knee' },
  { key: 'BackSurgery', label: 'Back Surgery' },
  { key: 'CABG', label: 'CABG(Heart Bypass)' },
  { key: 'CarpalTunnelRelease', label: 'Carpal Tunnel Release' },
  { key: 'Colectomy', label: 'Colectomy' },
  { key: 'GastericBypass', label: 'Gastric Bypass' },
  { key: 'HerniaRepair', label: 'Hernia Repair' },
  { key: 'LiverBiopsy', label: 'Liver Biopsy' },
] as const
export const SURGERIES_MALE = [
  { key: 'ProstateBiopsy', label: 'Prostate Biopsy' },
  { key: 'turp', label: 'TURP' },
  { key: 'Vasectomy', label: 'Vasectomy' },
] as const
export const SURGERIES_FEMALE = [
  { key: 'AugmentationMammoplasty', label: 'Augmentation Mammoplasty' },
  { key: 'BreastBiopsy', label: 'Breast Biopsy' },
  { key: 'Mastectomy', label: 'Mastectomy' },
  { key: 'Myomectomy', label: 'Myomectomy' },
  { key: 'VeginalHysterectomy', label: 'Vaginal Hysterectomy' },
] as const
export type SurgeryKey = (typeof SURGERIES_GENERAL | typeof SURGERIES_MALE | typeof SURGERIES_FEMALE)[number]['key']

export type SurgicalHistory = Record<SurgeryKey, string> & { IfOthers: string }

export interface Hospitalization {
  PastVisit1: string
  PastVisit2: string
  PastVisit3: string
  Notes1: string
  Notes2: string
  Notes3: string
}

export interface RegistrationForm {
  basicInfo: BasicInfo
  choicesForm: ChoicesForm
  AddInfo: AddInfo
  medicationForm: MedicationForm
  medicalHistoryForm: { selectedMedicalHistory: string[] }
  familyHistoryForm: FamilyHistoryForm
  socialHistoryForm: SocialHistoryForm
  SurgicalHistory: SurgicalHistory
  Hospitalization: Hospitalization
  /** The Financial Policy's "I agree" checkbox (no formControlName in Angular). */
  consent: boolean
}

function blank<K extends string>(keys: readonly K[]): Record<K, string> {
  return Object.fromEntries(keys.map((key) => [key, ''])) as Record<K, string>
}

export function emptyRegistration(): RegistrationForm {
  return {
    basicInfo: blank([
      'firstName', 'middleName', 'lastName', 'date', 'phoneNo', 'address', 'city', 'state', 'country', 'zip', 'maritalStatus',
      'gender', 'email', 'relationFirstname', 'relationLastname', 'relationPhoneno', 'relation', 'relationEmail',
    ]),
    choicesForm: blank([
      'provider', 'AllowPatientPortal', 'AllowSMS', 'AllowEmail', 'Language', 'ResponsibleParty', 'payMethod', 'insuranceCompany',
      'planName', 'policyNumber', 'groupNumber', 'City', 'State', 'Country', 'Zip', 'relationship', 'newInsuranceCompany',
      'newInsuranceCity', 'newInsuranceState', 'newInsuranceCountry', 'newInsuranceZip', 'newInsurancePlanName',
      'newInsurancePolicyNumber', 'newInsuranceGroupNumber',
    ]),
    AddInfo: blank([
      'pharmacyName', 'City', 'State', 'Country', 'Zip', 'newPharmacyName', 'newPharmacyCity', 'newPharmacyState', 'newPharmacyCountry',
      'newPharmacyZip',
    ]),
    medicationForm: blank(['medication', 'medicationInfo', 'allergies', 'allergiesInfo']),
    medicalHistoryForm: { selectedMedicalHistory: [] },
    familyHistoryForm: {
      ...(Object.fromEntries(FAMILY_DISEASES.map(({ key }) => [key, []])) as unknown as Record<FamilyDiseaseKey, string[]>),
      familyHistoryInfo: '',
    },
    socialHistoryForm: {
      selectedtobaccoHistory: [],
      selectedalcoholHistory: [],
      selectedDrugAbuse: [],
      selectedCardioVascular: [],
      socialMedicalHistoryInfo: '',
    },
    SurgicalHistory: {
      ...blank([...SURGERIES_GENERAL, ...SURGERIES_MALE, ...SURGERIES_FEMALE].map(({ key }) => key)),
      IfOthers: '',
    },
    Hospitalization: blank(['PastVisit1', 'PastVisit2', 'PastVisit3', 'Notes1', 'Notes2', 'Notes3']),
    consent: false,
  }
}

// ---- Option lists (the Angular app loaded these from its own API) ------------------------------

export interface Option {
  value: string
  label: string
}

export const US_STATES: Option[] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'],
  ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
  ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
  ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
].map(([value, label]) => ({ value, label }))

/** The contract's address is U.S. only (`country: US`). */
export const COUNTRIES: Option[] = [{ value: 'US', label: 'United States' }]

export const MARITAL_STATUSES = ['Married', 'Single', 'Divorced', 'Widowed', 'Separated', 'Domestic Partner'] as const
const MARITAL_CODE: Record<string, PatientCreateMaritalStatus> = {
  Married: 'M',
  Single: 'S',
  Divorced: 'D',
  Widowed: 'W',
  Separated: 'L',
  'Domestic Partner': 'T',
}

const V2_0131 = 'http://terminology.hl7.org/CodeSystem/v2-0131'
const V3_ROLE_CODE = 'http://terminology.hl7.org/CodeSystem/v3-RoleCode'

/** The emergency contact's relation (Angular: "Select Guardian Relationship"). */
export const GUARDIAN_RELATIONS: (Option & { coding: CodedValue })[] = [
  { value: 'SPS', label: 'Spouse', coding: { system: V3_ROLE_CODE, code: 'SPS', display: 'spouse' } },
  { value: 'DOMPART', label: 'Domestic partner', coding: { system: V3_ROLE_CODE, code: 'DOMPART', display: 'domestic partner' } },
  { value: 'PRN', label: 'Parent', coding: { system: V3_ROLE_CODE, code: 'PRN', display: 'parent' } },
  { value: 'CHILD', label: 'Child', coding: { system: V3_ROLE_CODE, code: 'CHILD', display: 'child' } },
  { value: 'SIB', label: 'Sibling', coding: { system: V3_ROLE_CODE, code: 'SIB', display: 'sibling' } },
  { value: 'FRND', label: 'Friend', coding: { system: V3_ROLE_CODE, code: 'FRND', display: 'unrelated friend' } },
  { value: 'GUARD', label: 'Guardian', coding: { system: V3_ROLE_CODE, code: 'GUARD', display: 'guardian' } },
  { value: 'O', label: 'Other', coding: { system: V2_0131, code: 'O', display: 'Other' } },
]

/** The insured's relationship to the subscriber: the contract's own list. */
export const SUBSCRIBER_RELATIONSHIPS: { value: CoverageCreateRelationshipToSubscriber; label: string }[] = [
  { value: 'self', label: 'Self' },
  { value: 'spouse', label: 'Spouse' },
  { value: 'child', label: 'Child' },
  { value: 'parent', label: 'Parent' },
  { value: 'common', label: 'Common-law spouse' },
  { value: 'other', label: 'Other' },
  { value: 'injured', label: 'Injured party' },
]

/** Preferred language as a BCP 47 tag. */
export const LANGUAGES: Option[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'zh', label: 'Chinese' },
  { value: 'vi', label: 'Vietnamese' },
  { value: 'tl', label: 'Tagalog' },
  { value: 'ar', label: 'Arabic' },
]

export const MEDICAL_HISTORIES = [
  'Head', 'Genito-Urinary', 'Ears', 'Endocrine', 'Nose/Sinuses', 'Heme/Onc', 'Mouth/Throat/Teeth', 'Infections', 'CardioVascular',
  'Musco-Skeletal', 'Respiratory', 'skin', 'Gastro-Intestinal', 'Neurological', 'Psychiatric',
]
export const FAMILY_MEMBERS = ['Father', 'Mother', 'Children', 'Others']
export const TOBACCO = [
  'Current Everyday Smoker', 'Current Someday Smoker', 'Former Smoker', 'Heavy Tobacco Smoker', 'Light Tobacco Smoker', 'Never Smoke',
  'Unknown if Ever Smoked',
]
export const ALCOHOL: Option[] = [
  { value: 'Do not Drink', label: 'Do Not Drink' },
  { value: 'Drink Daily', label: 'Drink Daily' },
  { value: 'Frequently Drink', label: 'Frequently Drink' },
  { value: 'HX of Alcohol', label: 'HX of Alcohol' },
  { value: 'Occasional Drink', label: 'Occasional Drink' },
]
export const DRUG_ABUSE = ['IVDU', 'Illicit Drug Use', 'No Illicit Drug Use']
export const CARDIOVASCULAR = ['Eat Healthy Meals', 'Regular Exercise', 'Take Daily Aspirin']

// TODO(stage 2): the contract has no pharmacy directory read for the desk yet (SCREEN_PORT gap 12/31);
// these are mock names so the Preferred Pharmacies select works as it did.
export const MOCK_PHARMACIES: Option[] = [
  { value: 'mock-1', label: 'Maple Street Pharmacy (mock)' },
  { value: 'mock-2', label: 'Riverside Drug (mock)' },
]

/** Payers for the Insurance Company select (`GET /payers`, active, first page of 100). */
export async function loadPayers(): Promise<Option[]> {
  const res = await apiListPayers({ active: true, limit: 100 })
  return res.status === 200 ? res.data.items.map((payer) => ({ value: payer.id, label: payer.name })) : []
}

/**
 * Providers for the Provider select: `GET /booking/providers` (D49), which the front desk can read
 * (Vimal on #85, 2026-11-03). TODO(#225): send the choice as `generalPractitionerId` once #225 merges; left out until then.
 * The contract has it (#212), but the patients backend doesn't yet and refuses unknown fields (422).
 */
export async function loadProviders(): Promise<Option[]> {
  const res = await apiListBookableProviders({ limit: 100 })
  return res.status === 200 ? res.data.items.map((provider) => ({ value: provider.id, label: provider.displayName })) : []
}

// ---- Validation: the Angular rules, changed to the U.S. contract (SCREEN_PORT.md) --------------

/** Letters (any script, with accents), spaces, hyphens and apostrophes; at least one letter first. */
const NAME = /^\p{L}[\p{L}\p{M} '’-]*$/u
const ADDRESS = /^(?=.*[a-zA-Z])[\w\s,.#'/-]+$/
const CITY = /^\p{L}[\p{L}\p{M} .'’-]*$/u
const ZIP = /^\d{5}(?:-\d{4})?$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const NOTES = /^(?!.*\s\s)[\w\d!@#$%^&*(),.?":{}|<>_-][\w\s\d!@#$%^&*(),.?":{}|<>_-]*[\w\d!@#$%^&*(),.?":{}|<>_-]$/

/** The 10 digits of a U.S. number as typed ("(617) 555-0123", "617.555.0123", "+1 617…"). */
export function usPhoneDigits(input: string): string {
  const digits = input.replace(/\D/g, '')
  return (digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits).slice(0, 10)
}

/** Shown as (617) 555-0123, built up while typing. */
export function formatUsPhone(input: string): string {
  const d = usPhoneDigits(input)
  if (d.length === 0) return ''
  if (d.length < 4) return `(${d}`
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

/** A North American number: area code and exchange each start 2–9. */
export function isUsPhone(input: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(usPhoneDigits(input))
}

/** Sent as E.164 (+1…). */
export function toE164(input: string): string {
  return `+1${usPhoneDigits(input)}`
}

/** Today in the browser's zone, as yyyy-mm-dd (the date input's own form). */
export function todayIso(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

type Errors<T> = Partial<Record<keyof T, string>>

function name(value: string, required: boolean, missing: string, invalid: string): string | undefined {
  const v = value.trim()
  if (!v) return required ? missing : undefined
  return v.length > 100 || !NAME.test(v) ? invalid : undefined
}

function pattern(value: string, re: RegExp, invalid: string, max?: number): string | undefined {
  const v = value.trim()
  if (!v) return undefined
  return (max && v.length > max) || !re.test(v) ? invalid : undefined
}

function needed(value: string, missing: string): string | undefined {
  return value.trim() ? undefined : missing
}

export function basicInfoErrors(f: BasicInfo, today: string = todayIso()): Errors<BasicInfo> {
  return {
    firstName: name(f.firstName, true, 'Username required', 'Invalid Username'),
    middleName: name(f.middleName, false, '', 'Invalid Middlename'),
    lastName: name(f.lastName, true, 'Lastname required', 'Invalid Lastname'),
    date: !f.date ? 'Date Required' : f.date > today ? 'Invalid Date' : undefined,
    phoneNo: !f.phoneNo.trim() ? 'Phoneno required' : isUsPhone(f.phoneNo) ? undefined : 'Invalid phoneno',
    address: needed(f.address, 'Address required') ?? pattern(f.address, ADDRESS, 'Invalid Address', 100),
    city: needed(f.city, 'City required') ?? pattern(f.city, CITY, 'Invalid City', 60),
    state: needed(f.state, 'State required'),
    country: needed(f.country, 'Country required'),
    zip: needed(f.zip, 'Zip required') ?? pattern(f.zip, ZIP, 'Invalid Zip'),
    maritalStatus: undefined,
    gender: needed(f.gender, 'Gender required'),
    email: pattern(f.email, EMAIL, 'Invalid Email', 254),
    relationFirstname: name(f.relationFirstname, true, 'FirstName required', 'Invalid FirstName'),
    relationLastname: name(f.relationLastname, true, 'LastName required', 'Invalid LastName'),
    relationPhoneno: !f.relationPhoneno.trim() ? 'Phoneno required' : isUsPhone(f.relationPhoneno) ? undefined : 'Invalid phoneno',
    relation: needed(f.relation, 'Relation required'),
    relationEmail: pattern(f.relationEmail, EMAIL, 'Invalid Email', 254),
  }
}

export function choicesErrors(f: ChoicesForm): Errors<ChoicesForm> {
  return {
    planName: f.planName.trim().length > 200 ? 'Invalid Plan Name' : undefined,
    policyNumber: f.policyNumber.trim().length > 200 ? 'Invalid Policy Number' : undefined,
    groupNumber: f.groupNumber.trim().length > 80 ? 'Invalid Group Number' : undefined,
    City: pattern(f.City, CITY, 'Invalid City', 60),
    Zip: pattern(f.Zip, ZIP, 'Invalid Zip'),
    newInsuranceCompany: f.newInsuranceCompany.trim().length > 200 ? 'Invalid InsuranceCompany Name' : undefined,
    newInsuranceCity: pattern(f.newInsuranceCity, CITY, 'Invalid Insurance City', 60),
    newInsuranceZip: pattern(f.newInsuranceZip, ZIP, 'Invalid Insurance ZIP'),
    newInsurancePlanName: f.newInsurancePlanName.trim().length > 200 ? 'Invalid Insurance Plan Name' : undefined,
    newInsurancePolicyNumber: f.newInsurancePolicyNumber.trim().length > 200 ? 'Invalid Insurance Policy Number' : undefined,
    newInsuranceGroupNumber: f.newInsuranceGroupNumber.trim().length > 80 ? 'Invalid Insurance Group Number' : undefined,
  }
}

export function addInfoErrors(f: AddInfo): Errors<AddInfo> {
  return {
    City: pattern(f.City, CITY, 'Invalid City', 60),
    Zip: pattern(f.Zip, ZIP, 'Invalid Zip'),
    newPharmacyName: f.newPharmacyName.trim().length > 200 ? 'Invalid Pharmacy Name' : undefined,
    newPharmacyCity: pattern(f.newPharmacyCity, CITY, 'Invalid City', 60),
    newPharmacyZip: pattern(f.newPharmacyZip, ZIP, 'Invalid Zip'),
  }
}

/** The Angular notes rule (2–100 characters, no double spaces), unchanged. */
export function notesError(value: string, invalid: string): string | undefined {
  const v = value
  if (!v) return undefined
  return v.length < 2 || v.length > 100 || !NOTES.test(v) ? invalid : undefined
}

export function hasErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some(Boolean)
}

// ---- To the contract ---------------------------------------------------------------------------

/** `overrideReason`: the desk registers despite a `409 possible-duplicate`, with its reason (recorded). */
export function toPatientCreate(form: RegistrationForm, overrideReason?: string): PatientCreate {
  const b = form.basicInfo
  const c = form.choicesForm
  const given = [b.firstName.trim(), b.middleName.trim()].filter(Boolean)
  return {
    name: { given, family: b.lastName.trim() },
    birthDate: b.date,
    gender: b.gender === 'Male' ? 'male' : b.gender === 'Female' ? 'female' : undefined,
    maritalStatus: MARITAL_CODE[b.maritalStatus],
    ...(c.Language ? { preferredLanguage: c.Language } : {}),
    phones: [{ number: toE164(b.phoneNo), use: 'mobile', textMessages: c.AllowSMS === 'Yes' }],
    ...(b.email.trim() ? { emails: [{ address: b.email.trim(), use: 'home' }] } : {}),
    address: { lines: [b.address.trim()], city: b.city.trim(), state: b.state, postalCode: b.zip.trim(), country: 'US' },
    ...(overrideReason?.trim() ? { duplicateCheck: 'override', duplicateOverrideReason: overrideReason.trim() } : {}),
  }
}

export function toEmergencyContact(form: RegistrationForm): RelatedPersonCreate {
  const b = form.basicInfo
  const relation = GUARDIAN_RELATIONS.find((option) => option.value === b.relation)
  const relationships: CodedValue[] = [{ system: V2_0131, code: 'C', display: 'Emergency Contact' }]
  if (relation) relationships.push(relation.coding)
  if (form.choicesForm.ResponsibleParty === 'Same as Emergency Contact') {
    relationships.push({ system: V3_ROLE_CODE, code: 'GUAR', display: 'guarantor' })
  }
  return {
    name: { given: [b.relationFirstname.trim()], family: b.relationLastname.trim() },
    relationships,
    phones: [{ number: toE164(b.relationPhoneno), use: 'mobile' }],
    ...(b.relationEmail.trim() ? { emails: [{ address: b.relationEmail.trim() }] } : {}),
  }
}

/** A coverage only when the Insurance Details name a company, a policy number and a relationship. */
export function toCoverage(form: RegistrationForm): CoverageCreate | null {
  const c = form.choicesForm
  if (!c.insuranceCompany || !c.policyNumber.trim() || !c.relationship) return null
  return {
    order: 1,
    payerId: c.insuranceCompany,
    memberId: c.policyNumber.trim(),
    ...(c.groupNumber.trim() ? { groupNumber: c.groupNumber.trim() } : {}),
    ...(c.planName.trim() ? { planName: c.planName.trim() } : {}),
    relationshipToSubscriber: c.relationship as CoverageCreateRelationshipToSubscriber,
  }
}

// ---- Submitting: three creates, each with its own Idempotency-Key -------------------------------

/**
 * Where a registration stands. The contract has no single "register with contacts and coverage"
 * request, so the patient, the emergency contact and the coverage are three creates; each keeps its
 * Idempotency-Key, so "Try again" repeats only what failed, never a step that already succeeded.
 */
export interface Submission {
  keys: { patient: string; contact: string; coverage: string }
  patientId?: string
  mrn?: string
  contactDone: boolean
  coverageDone: boolean
}

export function newSubmission(): Submission {
  return {
    keys: { patient: newIdempotencyKey(), contact: newIdempotencyKey(), coverage: newIdempotencyKey() },
    contactDone: false,
    coverageDone: false,
  }
}

export type SubmitResult =
  | { kind: 'done'; submission: Submission }
  | { kind: 'duplicate'; candidateIds: string[]; submission: Submission }
  | { kind: 'failed'; step: 'patient' | 'contact' | 'coverage'; error: unknown; submission: Submission }

export async function submitRegistration(form: RegistrationForm, current: Submission, overrideReason?: string): Promise<SubmitResult> {
  const submission = { ...current }
  if (!submission.patientId) {
    try {
      const res = await apiRegisterPatient(toPatientCreate(form, overrideReason), { 'Idempotency-Key': submission.keys.patient })
      if (res.status !== 201) throw new Error('Registration did not complete')
      submission.patientId = res.data.id
      submission.mrn = res.data.mrn
    } catch (error) {
      if (error instanceof ApiError && error.problem.code === 'possible-duplicate') {
        // A new key for the next attempt: the body will differ once the desk decides.
        return { kind: 'duplicate', candidateIds: candidateIdsOf(error.problem), submission: { ...submission, keys: { ...submission.keys, patient: newIdempotencyKey() } } }
      }
      return { kind: 'failed', step: 'patient', error, submission }
    }
  }
  const patientId = submission.patientId
  if (!submission.contactDone) {
    try {
      await apiAddRelatedPerson(patientId, toEmergencyContact(form), { 'Idempotency-Key': submission.keys.contact })
      submission.contactDone = true
    } catch (error) {
      return { kind: 'failed', step: 'contact', error, submission }
    }
  }
  const coverage = toCoverage(form)
  if (coverage && !submission.coverageDone) {
    try {
      await apiAddCoverage(patientId, coverage, { 'Idempotency-Key': submission.keys.coverage })
      submission.coverageDone = true
    } catch (error) {
      return { kind: 'failed', step: 'coverage', error, submission }
    }
  }
  return { kind: 'done', submission }
}

/** The patients a `409 possible-duplicate` names (opaque IDs only). */
function candidateIdsOf(problem: object): string[] {
  const ids = (problem as { candidateIds?: unknown }).candidateIds
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

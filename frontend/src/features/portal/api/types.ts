/**
 * Data for the portal screens not in the contract yet (B8b and P1, D88), served by the in-memory
 * mock and shaped as the contract will be (API_STANDARDS: camelCase, instants in UTC ending in
 * `At`, dates ending in `Date`, Money as decimal strings, lists as `{ items, nextCursor }`). The
 * B8a screens use the generated types in src/api/generated/; these give way to them batch by batch.
 * Demographics, HealthIssue, Allergy and Vital remain only for the mock's health report (B8b exports).
 */
import type { Money, Quantity } from '../../../design-system'

export interface Page<T> {
  items: T[]
  nextCursor?: string
}

export interface Ref {
  id: string
  displayName: string
}

export interface Provider extends Ref {
  facilityIds: string[]
}

/** Demographics and Profile Information (old portal: Personal, Employer, Emergency Contact). */
export interface Demographics {
  firstName: string
  middleName: string
  lastName: string
  address: string
  city: string
  state: string
  postalCode: string
  country: string
  email: string
  mobilePhone: string
  homePhone: string
  maritalStatus: string
  race: string
  language: string
  ethnicity: string
  employer: { name: string; address: string; city: string; state: string; postalCode: string; country: string }
  emergencyContact: { name: string; relationship: string; phone: string }
}

/** Reference lists for the demographics and registration dropdowns. */
export interface ReferenceLists {
  maritalStatuses: string[]
  races: string[]
  ethnicities: string[]
  languages: string[]
  relationships: string[]
  countries: string[]
  insuranceCompanies: string[]
  insuranceRelationships: string[]
  pharmacies: Pharmacy[]
  providers: Ref[]
}

export interface Message {
  id: string
  folder: 'inbox' | 'sent' | 'trash'
  subject: MessageSubject
  from: Ref
  to: Ref
  sentAt: string
  read: boolean
  /** Plain text; the portal never renders message HTML. */
  body: string
}

/** The old portal's subject list. */
export const MESSAGE_SUBJECTS = ['Non Urgent Medical Question', 'Pharmacy/Prescription', 'Insurance', 'Bill Payment', 'Referral', 'Office Visit'] as const
export type MessageSubject = (typeof MESSAGE_SUBJECTS)[number]

export interface MessageCreate {
  recipientId: string
  subject: MessageSubject
  body: string
}

export type ResultFlag = 'normal' | 'high' | 'low' | 'critical-high' | 'critical-low' | 'abnormal'

export interface ResultComponent {
  name: string
  value: string
  unit?: string
  referenceRange?: string
  flag: ResultFlag
}

export interface LabResult {
  id: string
  name: string
  code: string
  orderedAt: string
  collectedAt: string
  resultedAt: string
  orderedBy: Ref
  lab: { name: string; address: string; director: string; phone: string }
  status: 'final' | 'preliminary' | 'corrected'
  components: ResultComponent[]
}

/** Old portal occurrence codes, shown as words. */
export type Occurrence = 'unknown' | 'first' | 'chronic' | 'acute-on-chronic' | 'early-recurrence' | 'late-recurrence' | 'delayed-recurrence'

export interface HealthIssue {
  id: string
  title: string
  diagnosis: string
  beginDate?: string
  endDate?: string
  occurrence: Occurrence
  referredBy?: string
  notes?: string
}

export interface Allergy {
  id: string
  title: string
  diagnosis?: string
  reaction: string
  beginDate?: string
  endDate?: string
  occurrence: Occurrence
  referredBy?: string
  notes?: string
}

export interface Immunization {
  id: string
  vaccine: string
  administeredDate: string
  administeredBy: string
  amount?: string
  route?: string
  site?: string
  expirationDate?: string
  manufacturer?: string
  completionStatus: 'completed' | 'partially-administered' | 'not-administered'
  notes?: string
}

export interface Vital {
  id: string
  takenAt: string
  systolic?: number
  diastolic?: number
  pulse?: number
  respiration?: number
  weight?: Quantity
  height?: Quantity
  temperature?: Quantity
  bmi?: number
  bmiStatus?: string
  waistCircumference?: Quantity
  headCircumference?: Quantity
  oxygenSaturation?: number
}

export interface Prescription {
  id: string
  drug: string
  provider: Ref
  refillsRemaining: number
  lastRefilledDate?: string
  /** Status of the latest refill request, as the old portal showed it. */
  requestStatus: 'none' | 'requested' | 'approved' | 'denied'
  note?: string
  /** Controlled substances cannot be requested online (EPCS: the provider calls the patient). */
  refillable: boolean
}

export interface RefillRequestCreate {
  prescriptionIds: string[]
  pharmacyId: string
  message: string
}

export interface RefillRequest {
  id: string
  prescriptions: Array<{ id: string; drug: string }>
  pharmacy: Pharmacy
  message: string
  requestedAt: string
}

export interface Pharmacy extends Ref {
  address: string
  phone: string
}

/** One visit's bill, as the old "Pay Bills" table showed it. */
export interface Bill {
  id: string
  practice: { name: string; address: string }
  visitReason: string
  provider: Ref
  serviceDate: string
  charges: Money
  insurancePaid: Money
  patientPaid: Money
  amountDue: Money
  lines: Array<{ date: string; description: string; quantity: number; unitPrice: Money; total: Money }>
  adjustments: Array<{ date: string; description: string; amount: Money }>
}

export interface PaymentCreate {
  billId: string
  amount: Money
  /** One-time token from the processor's hosted fields; card numbers never reach our servers (Q17). */
  paymentToken: string
}

export interface Payment {
  id: string
  amount: Money
  paidAt: string
  confirmationNumber: string
}

export interface PortalDocument {
  id: string
  name: string
  date: string
  source: 'patient' | 'provider'
  contentType: string
  sizeBytes: number
}

/** A practice document template the patient fills in, signs and sends for review. */
export interface DocumentTemplate {
  id: string
  name: string
  createdAt: string
  reviewedAt?: string
  reviewStatus: 'not-sent' | 'waiting-review' | 'accepted' | 'denied'
  denialReason?: string
  signed: boolean
  intro: string
  fields: Array<{ id: string; label: string; kind: 'text' | 'textarea' | 'date' | 'yes-no' }>
  /** The patient's saved answers. */
  values: Record<string, string>
  /** PNG data URL of the signature placed on the document. */
  signature?: string
  closing?: string
}

export interface Signature {
  /** PNG data URL. */
  image: string
  savedAt: string
}

export interface PatientReport {
  generatedAt: string
  patient: { name: string; birthDate: string; sex: string; address: string; phone: string }
  issues: HealthIssue[]
  allergies: Allergy[]
  prescriptions: Prescription[]
  immunizations: Immunization[]
  vitals: Vital | null
}


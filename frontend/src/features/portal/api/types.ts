/**
 * Patient portal data, shaped as the `/portal` contract will be (API_STANDARDS: camelCase,
 * instants in UTC ending in `At`, dates ending in `Date`, Money as decimal strings, lists as
 * `{ items, nextCursor }`). The contract does not exist yet (P1); see NOTE_FOR_VIMAL_PORTAL.md.
 * When it lands, these give way to the generated types in src/api/generated/.
 */
import type { Address, HumanName, Money, Quantity } from '../../../design-system'

export interface Page<T> {
  items: T[]
  nextCursor?: string
}

export interface Ref {
  id: string
  displayName: string
}

export interface Facility extends Ref {
  /** IANA zone; appointment times show in facility time (D40). */
  timeZone: string
  address: Address
  phone: string
}

export interface Provider extends Ref {
  facilityIds: string[]
}

export interface PortalSession {
  name: HumanName
  /** False until an invitation code links this realm account to a chart (D85); only activation is open until then. */
  activated: boolean
  /** Server-issued; the idle warning is timed from these (SECURITY_MODEL §2.1). */
  idleExpiresAt: string
  expiresAt: string
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

/** FHIR Appointment status codes (API_STANDARDS §6.5). */
export type AppointmentStatus = 'booked' | 'arrived' | 'checked-in' | 'fulfilled' | 'cancelled' | 'noshow'

export interface Appointment {
  id: string
  startAt: string
  endAt: string
  status: AppointmentStatus
  category: Ref
  reason: string
  mode: 'in-person' | 'video'
  provider: Ref
  facility: Facility
  reminder: ReminderPreference
  canReschedule: boolean
  canCancel: boolean
  /** Video visits: the room opens 15 minutes before the start. */
  videoRoomOpen: boolean
  instructions?: string
  visitSummaryId?: string
}

export type ReminderPreference = 'text' | 'email' | 'phone'

/** Old portal "Select appointment type". */
export interface AppointmentCategory extends Ref {
  mode: 'in-person' | 'video'
}

export interface Slot {
  startAt: string
  providerId: string
  facilityId: string
}

export interface AppointmentRequest {
  facilityId: string
  categoryId: string
  reason: string
  providerId: string
  startAt: string
  durationMinutes: 15 | 30 | 45 | 60
  reminder: ReminderPreference
}

export interface VisitSummary {
  id: string
  appointmentId: string
  date: string
  provider: Ref
  reasons: string[]
  vitals: Vital | null
  problemsAndAllergies: Array<{ title: string; diagnosis: string }>
  prescriptions: string[]
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

/** Old portal Alerts and Reminders: today's or the next appointment. */
export interface AppointmentAlert {
  appointmentId: string
  startAt: string
  timeZone: string
  today: boolean
}

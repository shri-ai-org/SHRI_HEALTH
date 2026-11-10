// IP Admission — the Front Office's admission-registration slice only (bed
// allocation, admission record, billing/payment link). No clinical IPD
// workflow (nursing, medication, discharge summary) lives here. Patient,
// Doctor/Provider, Bill and Payment are the existing entities, referenced
// by id — this module owns only Bed/Admission/Attendant.


export type Ward = 'General Ward' | 'Private Ward' | 'Semi-Private Ward' | 'ICU' | 'Emergency'

export const WARDS: Ward[] = ['General Ward', 'Private Ward', 'Semi-Private Ward', 'ICU', 'Emergency']

export type RoomType = 'General' | 'Semi-Private' | 'Private' | 'ICU'

export const ROOM_TYPES: RoomType[] = ['General', 'Semi-Private', 'Private', 'ICU']

export type BedStatus = 'Available' | 'Occupied' | 'Reserved' | 'Maintenance'

export interface Bed {
  bedId: string
  bedNumber: string
  roomNumber: string
  ward: Ward
  roomType: RoomType
  status: BedStatus
  /** Set only while status is Occupied/Reserved — the one place a bed
   *  points back at whoever is using it. */
  currentAdmissionId: string | null
}

export type AdmissionType = 'Emergency' | 'Elective' | 'Transfer'

export const ADMISSION_TYPES: AdmissionType[] = ['Emergency', 'Elective', 'Transfer']

export type ReferralSource = 'Walk-in' | 'Outpatient' | 'Emergency' | 'Referral' | 'Transfer'

export const REFERRAL_SOURCES: ReferralSource[] = ['Walk-in', 'Outpatient', 'Emergency', 'Referral', 'Transfer']

export type AttendantRelationship =
  | 'Father'
  | 'Mother'
  | 'Spouse'
  | 'Son'
  | 'Daughter'
  | 'Brother'
  | 'Sister'
  | 'Guardian'
  | 'Other'

export const ATTENDANT_RELATIONSHIPS: AttendantRelationship[] = [
  'Father',
  'Mother',
  'Spouse',
  'Son',
  'Daughter',
  'Brother',
  'Sister',
  'Guardian',
  'Other',
]

export interface Attendant {
  name: string
  relationship: AttendantRelationship
  phone: string
  address: string | null
}

export type PaymentType = 'Self Pay' | 'Insurance' | 'TPA' | 'Corporate'

export const PAYMENT_TYPES: PaymentType[] = ['Self Pay', 'Insurance', 'TPA', 'Corporate']

/** Pending/Bed Reserved exist for completeness (a future scheduled-ahead
 *  admission) but the Front Office's own Admit Patient flow always
 *  completes bed allocation in one step, so it goes straight to Admitted —
 *  see domain/admissionActions.ts. Transferred is declared for the same
 *  reason the plan lists it, not because this version implements transfer. */
export type AdmissionStatus = 'Pending' | 'Bed Reserved' | 'Admitted' | 'Transferred' | 'Discharged' | 'Cancelled'

export type DischargeType = 'Normal Discharge' | 'Discharge Against Medical Advice' | 'Transfer' | 'Death'

export const DISCHARGE_TYPES: DischargeType[] = [
  'Normal Discharge',
  'Discharge Against Medical Advice',
  'Transfer',
  'Death',
]

export interface DischargeDetails {
  dischargeType: DischargeType
  remarks?: string
}

export interface Admission {
  admissionId: string
  admissionNumber: string
  patientId: string
  patientName: string
  doctorId: string
  doctorName: string
  department: string
  admissionType: AdmissionType
  reason: string
  referralSource: ReferralSource
  bedId: string | null
  wardLabel: string | null
  roomNumber: string | null
  bedNumber: string | null
  roomType: RoomType | null
  attendant: Attendant
  paymentType: PaymentType
  insuranceProvider: string | null
  policyNumber: string | null
  /** Set once a bill is raised against the existing Payment/Billing system
   *  — null until "Create Bill" is used. This IS the payment record. */
  paymentId: string | null
  status: AdmissionStatus
  admittedAt: number | null
  dischargedAt: number | null
  /** Recorded by the Discharge workflow; absent on admissions discharged before it existed. */
  dischargeType?: DischargeType | null
  dischargeRemarks?: string | null
  cancelledAt: number | null
  cancelReason: string | null
  createdAt: number
  updatedAt: number
}

export interface CreateAdmissionInput {
  patientId: string
  /** The department comes from this doctor. */
  doctorId: string
  admissionType: AdmissionType
  reason: string
  referralSource: ReferralSource
  bedId: string
  attendant: Attendant
  paymentType: PaymentType
  insuranceProvider?: string | null
  policyNumber?: string | null
}

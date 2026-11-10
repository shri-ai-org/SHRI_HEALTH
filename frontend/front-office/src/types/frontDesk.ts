// Front Desk services — Guest Pass, Enquiry & Estimate, MLC — plus the
// small pieces of state (the registration log) that belong to no single
// screen.

/** Who a guest pass is for. Nobody moves about the hospital without either
 *  a hospital ID or a pass, and every pass is confirmed before it is printed. */
export type GuestPassType = 'Patient visitor' | 'Visiting doctor' | 'Staff / service'

export const GUEST_PASS_TYPES: GuestPassType[] = ['Patient visitor', 'Visiting doctor', 'Staff / service']

export interface GuestPass {
  passId: string
  type: GuestPassType
  /** The person carrying the pass. */
  holderName: string
  holderMobile: string
  /** The ID proof seen at the desk — its kind and only its last four characters. */
  idProof: string
  /** A patient visitor: whose visitor they are. */
  patientId: string | null
  patientName: string | null
  /** A visiting doctor or staff: the doctor or person they are here for. */
  hostName: string | null
  /** Where the pass lets them go — the patient's ward, or a department. */
  ward: string
  /** Their relationship to the patient, or their role. */
  relationship: string
  purpose: string
  /** Who confirmed the visit before the pass was printed. */
  verifiedWith: string
  /** The desk member who printed it. */
  issuedBy: string
  /** After this the pass is overdue for return. */
  validUntil: number
  issuedAt: number
  returnedAt: number | null
  returned: boolean
}

/** actions.issueGuestPass's input — the desk's checks travel with it. */
export interface IssueGuestPassInput {
  type: GuestPassType
  holderName: string
  holderMobile: string
  idType: string
  idLast4: string
  /** Patient visitor: the admitted patient. */
  patientId?: string
  /** Visiting doctor: the hospital doctor they are visiting. */
  hostProviderId?: string
  /** Staff / service: the department or area, and who authorised them. */
  area?: string
  relationship: string
  purpose: string
  /** Who confirmed the visit (patient visitor, staff); a visiting doctor's host confirms it. */
  verifiedWith?: string
  /** The desk confirmed the ID and the visit. */
  confirmed: boolean
  issuedBy: string
}

/** The hospital's own rate card — rates are read, never estimated. */
export interface Tariff {
  code: string
  name: string
  department: string
  rate: number
}

export interface EstimateItem {
  code: string
  name: string
  rate: number
  quantity?: number
}

/** Front Office's own lifecycle — deliberately narrow (no ledger states).
 *  Set by the Payment module once a bill is raised against an estimate;
 *  Enquiry & Estimate itself only ever produces Draft/Saved/Cancelled. */
export type EstimateStatus = 'Draft' | 'Saved' | 'Partially Paid' | 'Paid' | 'Cancelled'

/** An estimate always belongs to exactly one patient — there is no
 *  anonymous/walk-in estimate. */
export interface Estimate {
  estimateId: string
  patientId: string
  patientName: string
  items: EstimateItem[]
  total: number
  payer: string
  status: EstimateStatus
  createdAt: number
  updatedAt: number
}

export interface AddEstimateItemInput {
  patientId: string
  patientName: string
  item: EstimateItem
}

export interface UpdateEstimateItemQuantityInput {
  estimateId: string
  code: string
  quantity: number
}

export interface RemoveEstimateItemInput {
  estimateId: string
  code: string
}

export type MlcCategory = 'Road traffic accident' | 'Assault' | 'Poisoning' | 'Burns' | 'Suicide attempt' | 'Other'
export type MlcBroughtBy = 'Police' | 'Relative' | 'Bystander' | 'Ambulance'

export interface MlcRecord {
  mlcId: string
  patientId: string
  patientName: string
  category: MlcCategory
  broughtBy: string
  policeStation: string
  incidentAt: string | null
  registeredAt: number
  /** Police intimation is captured, never assumed. */
  intimationSent: boolean
  acknowledgedAt: number | null
}

export interface RegisterMlcInput {
  patientId: string
  category: MlcCategory
  broughtBy: MlcBroughtBy | string
  policeStation: string
  incidentAt?: string
}

export interface RegistrationLogEntry {
  patientId: string
  registeredAt: number
}

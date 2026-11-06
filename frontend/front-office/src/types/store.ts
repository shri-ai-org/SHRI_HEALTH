import type { Patient } from './patient'
import type { Provider } from './doctor'
import type { DoctorLeave } from './schedule'
import type { Appointment } from './appointment'
import type { Visit } from './visit'
import type { QueueToken } from './queue'
import type { GuestPass, Estimate, MlcRecord, Tariff, RegistrationLogEntry } from './frontDesk'
import type { ActivityLogEntry } from './activity'
import type { Connectivity } from './connectivity'
import type { Payment } from './payment'
import type { Admission, Bed } from './admission'

/** Per-department token-number counters, keyed by the department prefix
 *  (see domain/actions.js's DEPARTMENT_PREFIX). Unlisted departments fall
 *  back to "GEN", so the index signature keeps this open. */
export interface TokenCounters {
  NEU: number
  CAR: number
  MED: number
  ORT: number
  [prefix: string]: number
}

/** The next sequence number to allocate for each ID family. */
export interface NextIds {
  appointment: number
  visit: number
  token: number
  activity: number
  patient: number
  provider: number
  leave: number
  pass: number
  estimate: number
  mlc: number
  payment: number
  transaction: number
  attempt: number
  admission: number
}

/** How often, and how recently, staff opened a patient's profile — feeds
 *  the search box's "Most opened" list. */
export interface PatientOpenStat {
  count: number
  lastOpenedAt: number
}

/** The single in-memory operational store's whole state shape — the ONE
 *  place Patient, Doctor, Appointment, Visit and Queue state lives (see
 *  domain/store.js). Every screen reads from it via selectors.ts and every
 *  user action changes it via actions.ts. */
export interface AppState {
  today: string
  patients: Patient[]
  providers: Provider[]
  leaves: DoctorLeave[]
  appointments: Appointment[]
  visits: Visit[]
  queueTokens: QueueToken[]
  guestPasses: GuestPass[]
  estimates: Estimate[]
  mlcRecords: MlcRecord[]
  tariffs: Tariff[]
  payments: Payment[]
  beds: Bed[]
  admissions: Admission[]
  registrationLog: RegistrationLogEntry[]
  /** Keyed by patientId. */
  patientOpens: Record<string, PatientOpenStat>
  activityLog: ActivityLogEntry[]
  connectivity: Connectivity
  tokenCounters: TokenCounters
  nextIds: NextIds
}

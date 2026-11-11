import type { Patient } from './patient'
import type { Provider } from './doctor'
import type { Appointment } from './appointment'

export type QueueTokenStatus = 'Waiting' | 'Called' | 'In consultation' | 'Completed' | 'No-show'

export interface QueueToken {
  tokenId: string
  tokenNumber: string
  patientId: string
  visitId: string
  providerId: string
  status: QueueTokenStatus
  createdAt: number
  calledAt: number | null
  startedAt: number | null
  completedAt: number | null
  recalled: boolean
}

/** domain/selectors.getQueueView's enriched row — position and estimated
 *  wait are derived from the doctor's actual pace, never invented. */
export interface QueueTokenRow extends QueueToken {
  patient: Patient | null
  provider: Provider | null
  appointment: Appointment | null
  position: number | null
  estimatedWaitMinutes: number | null
  waitingMinutes: number | null
  calledMinutes: number | null
  consultingMinutes: number | null
}

export interface QueueView {
  all: QueueTokenRow[]
  waiting: QueueTokenRow[]
  called: QueueTokenRow[]
  inConsultation: QueueTokenRow[]
  closed: QueueTokenRow[]
}

export interface CheckInResult {
  visitId: string
  tokenId: string
  tokenNumber: string
}

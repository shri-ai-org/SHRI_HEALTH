import type { Patient } from './patient'
import type { Provider } from './doctor'
import type { Visit } from './visit'
import type { QueueToken } from './queue'

// 'Payment Pending' is what a fresh booking gets now that appointment
// booking always creates a bill in the same step (see
// actions.bookAppointment) — the slot is reserved immediately, but the
// appointment only becomes 'Confirmed' once its linked bill is fully paid
// (actions.collectPayment). 'Scheduled' is kept for pre-existing records
// created before this integration.
export type AppointmentStatus =
  | 'Scheduled'
  | 'Payment Pending'
  | 'Confirmed'
  | 'Checked-in'
  | 'Completed'
  | 'Cancelled'
  | 'No-show'

/** How the consultation happens. A teleconsult follows the same lifecycle
 *  as a visit — checking in means the patient has joined the call. */
export type ConsultMode = 'In person' | 'Teleconsult'

/** Who could not keep a booking. It decides the money: a doctor's absence
 *  is refunded, a patient's cancellation keeps the fee. */
export type UnavailableParty = 'Patient' | 'Doctor'

/** Where a booking sits — a reschedule moves it from one to another. */
export interface BookingPlace {
  providerId: string
  date: string
  slot: string
  mode: ConsultMode
}

/** One move of a booking, kept so its history reads back in order. */
export interface RescheduleEntry {
  at: number
  from: BookingPlace
  to: BookingPlace
  by: UnavailableParty
  note: string | null
  /** The fee-difference bill, when the patient moved to a dearer doctor. */
  differencePaymentId: string | null
}

export interface Appointment {
  appointmentId: string
  patientId: string
  providerId: string
  department: string
  date: string
  slot: string
  status: AppointmentStatus
  visitId: string | null
  /** Optional free-text note from the front desk — never a clinical field. */
  reason: string | null
  mode: ConsultMode
  createdAt: number
  /** Set together when the booking is cancelled. */
  cancelledAt: number | null
  cancelledBy: UnavailableParty | null
  cancelReason: string | null
  /** Every move, oldest first; the last `to` is where the booking is now. */
  reschedules: RescheduleEntry[]
}

export interface AppointmentWithSlot extends Appointment {
  slotTimestamp: number
}

/** domain/selectors.getAppointmentsForDate's enriched row. */
export interface AppointmentRow extends AppointmentWithSlot {
  patient: Patient | null
  provider: Provider | null
  visit: Visit | null
  token: QueueToken | null
}

/** domain/selectors.getAppointmentsForPatient's enriched row. */
export interface PatientAppointmentRow extends AppointmentWithSlot {
  provider: Provider | null
}

/** actions.bookAppointment's input shape. */
export interface BookAppointmentInput {
  patientId: string
  providerId: string
  department: string
  slot: string
  date?: string
  reason?: string
  mode?: ConsultMode
}

export type SlotStatus = 'available' | 'booked' | 'past' | 'break'

/** domain/selectors.getSlotBoard's per-slot entry — every slot is shown,
 *  never hidden, so a booked slot is information, not something to filter out. */
export interface SlotBoardEntry {
  slot: string
  timestamp: number
  status: SlotStatus
  appointment: Appointment | null
}

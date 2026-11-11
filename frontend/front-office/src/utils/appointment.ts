import type { AppointmentStatus, ConsultMode } from '../types/appointment'
import type { DoctorStatus, Provider } from '../types/doctor'

/**
 * What an appointment's status reads as on screen. Kept separate from the
 * generic Badge/tone mapping because the same words ('Completed',
 * 'Cancelled', 'No-show') also belong to queue tokens, payments and
 * admissions.
 *
 * 'Scheduled' is a pre-existing-record status: booking now always raises a
 * bill in the same step, so it reads the same as 'Payment Pending'.
 */
const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  Scheduled: 'Payment pending',
  'Payment Pending': 'Payment pending',
  Confirmed: 'Confirmed',
  'Checked-in': 'Checked in',
  Completed: 'Completed',
  Cancelled: 'Cancelled',
  'No-show': 'No-show',
}

export function appointmentStatusLabel(status: AppointmentStatus): string {
  return APPOINTMENT_STATUS_LABEL[status]
}

/** Front Office wording for a doctor's derived status — display only, the
 *  underlying DoctorStatus (and its logic in domain/selectors.ts) is unchanged. */
export function doctorStatusLabel(status: DoctorStatus): string {
  return status === 'In consultation' ? 'With patient' : status
}

/** How a doctor sees patients — in person, by teleconsult, or either. */
export function modesFor(provider: Pick<Provider, 'consultationType'>): ConsultMode[] {
  switch (provider.consultationType) {
    case 'Teleconsult only':
      return ['Teleconsult']
    case 'Outpatient + Teleconsult':
      return ['In person', 'Teleconsult']
    default:
      return ['In person']
  }
}

/** How long after the booked time a patient who hasn't come can be marked
 *  a no-show — not before, so a patient running a little late isn't. */
export const NO_SHOW_GRACE_MINUTES = 10

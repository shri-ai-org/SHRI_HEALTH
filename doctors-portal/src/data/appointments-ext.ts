/**
 * Appointments added to the sample record after the old kit, in its style —
 * the old file (`record.ts`) stays as it was. Each is booked with Dr. Ananya
 * Iyer into one of her own session templates (`schedule.ts`), for a reason
 * the patient's record already gives:
 *   • Sunita Devi (SD-P-04), gestational diabetes at 32 weeks — the weekly
 *     glucose review, in Tuesday's endocrine follow-up session;
 *   • Selvi Murugan (SD-P-11), three weeks after a drained subdural — the
 *     review of her 28-Sep sodium recheck, in Thursday's follow-up session.
 * Nothing invented beyond the booking itself (§8.6).
 */

import type { Appointment } from './record'

function on(month: number, day: number, h = 10, m = 0, year = 2026): Date {
  return new Date(year, month - 1, day, h, m)
}

export const APPOINTMENTS_EXT: Appointment[] = [
  {
    id: 'AP-0404',
    patientId: 'SD-P-04',
    at: on(9, 22, 14, 30),
    kind: 'Follow-up',
    status: 'Booked',
    clinic: 'Endocrine OPD',
    with: 'Dr. Ananya Iyer',
    purpose: 'Weekly glucose review — gestational diabetes',
    prepare: ['Bring the home glucose readings (fasting and 1 hour after meals)'],
    location: 'Room 4, OPD block',
  },
  {
    id: 'AP-1105',
    patientId: 'SD-P-11',
    at: on(10, 1, 8, 30),
    kind: 'Follow-up',
    status: 'Booked',
    clinic: 'General Medicine OPD',
    with: 'Dr. Ananya Iyer',
    purpose: 'Sodium recheck result and anticoagulation plan',
    location: 'Room 4, OPD block',
  },
]

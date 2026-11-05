import type { ScheduleConfig, ScheduleConfigInput, DoctorSchedule } from './schedule'

export type Gender = 'Male' | 'Female' | 'Other'
export type ProviderStatus = 'Active' | 'Inactive'
export type ConsultationType = 'Outpatient' | 'Outpatient + Teleconsult' | 'Teleconsult only'
export type DoctorRole = 'Consultant' | 'Senior Consultant' | 'Associate Consultant' | 'Visiting Consultant' | 'Registrar'

/** The Doctor Management hospital profile — identity, department, schedule
 *  config and account status only. Deliberately no clinical capability. */
export interface Provider {
  providerId: string
  name: string
  gender: Gender
  dateOfBirth: string | null
  mobile: string
  email: string | null
  photoUrl?: string | null
  department: string
  specialty: string
  qualification: string | null
  registrationNumber: string
  experienceYears: number
  employeeId: string
  consultationType: ConsultationType
  consultationFee: number
  room: string | null
  loginEmail: string | null
  role: DoctorRole
  status: ProviderStatus
  schedule: ScheduleConfig
  createdAt: number
}

/** actions.registerDoctor's input shape. */
export interface RegisterDoctorInput {
  name: string
  gender?: Gender
  dateOfBirth?: string | null
  mobile: string
  email?: string | null
  photoUrl?: string | null
  department: string
  specialty: string
  qualification?: string | null
  registrationNumber: string
  experienceYears?: number | string
  employeeId?: string
  consultationType?: ConsultationType
  consultationFee?: number | string
  room?: string | null
  loginEmail?: string | null
  role?: DoctorRole
  status?: ProviderStatus
  schedule: ScheduleConfigInput
}

/** actions.updateDoctor's partial-edit shape. */
export type DoctorChanges = Partial<Omit<Provider, 'providerId' | 'createdAt'>>

/** Every operational status the front desk can see a doctor in — derived,
 *  never stored (domain/selectors.getDoctorStatus). */
export type DoctorStatus =
  | 'Inactive'
  | 'Not scheduled'
  | 'On leave'
  | 'On break'
  | 'In consultation'
  | 'Running late'
  | 'Fully booked'
  | 'Available'

/** domain/selectors.getDoctorRows's return shape — a provider plus every
 *  derived figure the directory/availability screens read. */
export interface DoctorRow {
  provider: Provider
  status: DoctorStatus
  schedule: DoctorSchedule | null
  nextSlot: string | null
  openSlotCount: number
  todaysAppointmentCount: number
  delayMinutes: number
}

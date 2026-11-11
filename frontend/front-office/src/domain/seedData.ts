// ============================================================================
// DEVELOPMENT SEED DATA — NOT A BACKEND.
//
// This repository has no backend, no API, no database and no real-time
// service (verified: no fetch/axios/websocket usage, no .env, no server or
// api directory). Nothing here is "live" data and the UI says so.
//
// Timestamps and working hours are generated RELATIVE TO APP START, so
// past/upcoming appointments, "running late" and "waiting N min" are real
// clock comparisons whatever time of day the app is opened.
//
// Replacing this with a real backend = delete this file and populate
// store.ts's initial state from an API response. selectors.ts and
// actions.ts are written against the state shape (src/types), not against
// this file.
//
// The full domain model is defined in src/types/ — one file per model,
// derived from exactly the shapes built below and consumed by
// selectors.ts/actions.ts.
// ============================================================================
import { dayStartTimestamp, formatTime, roundDownToStep, slotLabel, slotToTimestamp, todayKey } from './time'
import type { AppState, TokenCounters } from '../types/store'
import type { Patient } from '../types/patient'
import type { Provider } from '../types/doctor'
import type { DoctorLeave } from '../types/schedule'
import type { Appointment, AppointmentStatus, ConsultMode, RescheduleEntry, UnavailableParty } from '../types/appointment'
import type { Visit } from '../types/visit'
import type { QueueToken, QueueTokenStatus } from '../types/queue'
import type { ActivityLogEntry } from '../types/activity'
import type { Estimate, GuestPass, MlcRecord, RegistrationLogEntry, Tariff } from '../types/frontDesk'
import type { Payment, PaymentItem, PaymentMethod } from '../types/payment'
import type { Admission } from '../types/admission'
import { createAdmissionSeed } from './admissionSeedData'
import type { StaySeed } from './admissionSeedData'
import { PATIENT_HISTORY, contactFor } from './seedPatientHistory'
import { admissionBillItems, formatRupees, stayDays, sumItems } from '../utils/billing'
import { NO_SHOW_GRACE_MINUTES } from '../utils/appointment'

export { todayKey }

const MINUTE = 60000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

/** One booking: the appointment and the bill it was paid with. */
interface BookingSeed {
  patientId: string
  providerId: string
  status: AppointmentStatus
  method: PaymentMethod
  /** Days from today — negative for history, positive for a booking ahead. */
  day?: number
  /** Today: the slot relative to the doctor's next one (negative = already past). */
  offset?: number
  /** Another day: which of the doctor's slots. */
  slotIndex?: number
  /** A fixed slot label. */
  slot?: string
  /** A visit meant to be over by now, on a morning too young for it, is
   *  booked on this day (from today) instead. */
  fallbackDay?: number
  bookedAt?: number
  /** Today, checked in and still here: when the patient arrived. */
  arrivedAt?: number
  tokenStatus?: QueueTokenStatus
  reason?: string
  /** A teleconsult instead of the usual in-person visit. */
  mode?: ConsultMode
  /** Paid, then cancelled: refunded when the doctor could not see the
   *  patient, the fee kept when the patient cancelled. */
  cancel?: { by: UnavailableParty; reason: string; at: number }
  /** Booked first with another day (or doctor) and moved here. A patient's
   *  move to a dearer doctor paid the difference; a doctor's didn't. */
  moved?: { fromProviderId?: string; fromDay: number; fromSlotIndex: number; by: UnavailableParty; note: string; at: number }
}

interface SeedCollection {
  amount: number
  method: PaymentMethod
  at: number
}

interface SeedBill {
  patientId: string
  items: PaymentItem[]
  createdAt: number
  appointmentId?: string | null
  admissionId?: string | null
  estimateId?: string | null
  collections?: SeedCollection[]
  failed?: { amount: number; method: PaymentMethod; reason: string; at: number }[]
  refund?: { reason: string; at: number }
  cancelled?: { reason: string; at: number }
}

/** A visit waiting to be numbered — visits, tokens and token numbers are
 *  given out in arrival order once the whole day is known. */
interface EncounterSeed {
  patientId: string
  providerId: string
  appointment: Appointment | null
  arrival: number
  /** Today's encounters are in the queue; earlier days only leave a visit. */
  tokenStatus: QueueTokenStatus | null
  closedAt: number | null
}

export function createSeedState(): AppState {
  const now = Date.now()
  const today = todayKey()
  const dayStart = dayStartTimestamp(today)
  const minutesAgo = (m: number) => now - m * MINUTE
  const hoursAgo = (h: number) => now - h * HOUR
  const daysAgo = (d: number) => now - d * DAY
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
  /** The date `days` from today (negative = past). */
  const dateFromToday = (days: number) => todayKey(new Date(dayStart + days * DAY + 12 * HOUR))
  const localDateTime = (timestamp: number) => `${todayKey(new Date(timestamp))}T${slotLabel(timestamp)}`

  // Working hours are generated around "now" so the board always looks like
  // a shift in progress, clamped to sane clinic hours.
  const earliest = dayStart + 8 * 60 * MINUTE
  const latest = dayStart + 21 * 60 * MINUTE
  const sessionStart = clamp(roundDownToStep(now - 150 * MINUTE, 15), earliest, latest - 240 * MINUTE)
  const sessionEnd = clamp(roundDownToStep(now + 210 * MINUTE, 15), sessionStart + 180 * MINUTE, latest)
  const t = (ts: number) => slotLabel(ts)

  /** One more doctor in the seed's own shape — contact details from a
   *  handle, Active, working every day on the session given. */
  const seedDoctor = (d: {
    providerId: string
    name: string
    gender: Provider['gender']
    dateOfBirth: string
    mobile: string
    handle: string
    department: string
    specialty: string
    qualification: string
    registrationNumber: string
    experienceYears: number
    employeeId: string
    consultationType: Provider['consultationType']
    consultationFee: number
    room: string
    role: Provider['role']
    start: number
    end: number
    slotMinutes: number
    breaks?: { start: string; end: string }[]
    /** How long ago the profile was created. */
    days: number
  }): Provider => ({
    providerId: d.providerId,
    name: d.name,
    gender: d.gender,
    dateOfBirth: d.dateOfBirth,
    mobile: d.mobile,
    email: `${d.handle}@example.com`,
    department: d.department,
    specialty: d.specialty,
    qualification: d.qualification,
    registrationNumber: d.registrationNumber,
    experienceYears: d.experienceYears,
    employeeId: d.employeeId,
    consultationType: d.consultationType,
    consultationFee: d.consultationFee,
    room: d.room,
    loginEmail: `${d.handle}@example.com`,
    role: d.role,
    status: 'Active',
    schedule: { workingDays: ALL_DAYS, startTime: t(d.start), endTime: t(Math.max(d.end, d.start + 120 * MINUTE)), slotMinutes: d.slotMinutes, breaks: d.breaks ?? [] },
    createdAt: minutesAgo(d.days * 24 * 60),
  })

  const providers: Provider[] = [
    {
      providerId: 'dr-arun-kumar',
      name: 'Dr. Arun Kumar',
      gender: 'Male',
      dateOfBirth: '1974-03-12',
      mobile: '+91 98450 11020',
      email: 'arun.kumar@example.com',
      department: 'Neurology',
      specialty: 'Stroke & Neurology',
      qualification: 'MBBS, MD, DM (Neurology)',
      registrationNumber: 'KMC-48120',
      experienceYears: 18,
      employeeId: 'SHRI-DOC-014',
      consultationType: 'Outpatient',
      consultationFee: 250,
      room: 'Room 12, Block B',
      loginEmail: 'arun.kumar@example.com',
      role: 'Consultant',
      status: 'Active',
      schedule: { workingDays: ALL_DAYS, startTime: t(sessionStart), endTime: t(sessionEnd), slotMinutes: 15, breaks: [] },
      createdAt: minutesAgo(400 * 24 * 60),
    },
    {
      providerId: 'dr-priya-nair',
      name: 'Dr. Priya Nair',
      gender: 'Female',
      dateOfBirth: '1981-07-30',
      mobile: '+91 98451 33440',
      email: 'priya.nair@example.com',
      department: 'Cardiology',
      specialty: 'Interventional Cardiology',
      qualification: 'MBBS, MD, DM (Cardiology)',
      registrationNumber: 'KMC-52990',
      experienceYears: 12,
      employeeId: 'SHRI-DOC-021',
      consultationType: 'Outpatient + Teleconsult',
      consultationFee: 250,
      room: 'Room 4, Block A',
      loginEmail: 'priya.nair@example.com',
      role: 'Consultant',
      status: 'Active',
      schedule: { workingDays: ALL_DAYS, startTime: t(sessionStart + 30 * MINUTE), endTime: t(sessionEnd), slotMinutes: 15, breaks: [] },
      createdAt: minutesAgo(300 * 24 * 60),
    },
    {
      providerId: 'dr-rahul-menon',
      name: 'Dr. Rahul Menon',
      gender: 'Male',
      dateOfBirth: '1978-11-04',
      mobile: '+91 98452 77810',
      email: 'rahul.menon@example.com',
      department: 'General Medicine',
      specialty: 'Internal Medicine',
      qualification: 'MBBS, MD (General Medicine)',
      registrationNumber: 'KMC-44117',
      experienceYears: 15,
      employeeId: 'SHRI-DOC-008',
      consultationType: 'Outpatient',
      consultationFee: 200,
      room: 'Room 2, Block A',
      loginEmail: 'rahul.menon@example.com',
      role: 'Consultant',
      status: 'Active',
      schedule: { workingDays: ALL_DAYS, startTime: t(sessionStart), endTime: t(sessionEnd), slotMinutes: 15, breaks: [] },
      createdAt: minutesAgo(500 * 24 * 60),
    },
    {
      providerId: 'dr-meera-shah',
      name: 'Dr. Meera Shah',
      gender: 'Female',
      dateOfBirth: '1983-01-22',
      mobile: '+91 98453 90015',
      email: 'meera.shah@example.com',
      department: 'Orthopedics',
      specialty: 'Joint Replacement',
      qualification: 'MBBS, MS (Orthopedics)',
      registrationNumber: 'KMC-60441',
      experienceYears: 10,
      employeeId: 'SHRI-DOC-030',
      consultationType: 'Outpatient',
      consultationFee: 200,
      room: 'Room 8, Block C',
      loginEmail: 'meera.shah@example.com',
      role: 'Consultant',
      status: 'Active',
      schedule: { workingDays: ALL_DAYS, startTime: t(sessionStart), endTime: t(sessionEnd), slotMinutes: 20, breaks: [] },
      createdAt: minutesAgo(220 * 24 * 60),
    },
    {
      providerId: 'dr-ananya-rao',
      name: 'Dr. Ananya Rao',
      gender: 'Female',
      dateOfBirth: '1986-05-18',
      mobile: '+91 98454 20077',
      email: 'ananya.rao@example.com',
      department: 'Neurology',
      specialty: 'Epilepsy & Neurology',
      qualification: 'MBBS, MD, DM (Neurology)',
      registrationNumber: 'KMC-71203',
      experienceYears: 8,
      employeeId: 'SHRI-DOC-042',
      consultationType: 'Outpatient',
      consultationFee: 200,
      room: 'Room 14, Block B',
      loginEmail: 'ananya.rao@example.com',
      role: 'Consultant',
      status: 'Active',
      schedule: {
        workingDays: ALL_DAYS,
        startTime: t(sessionStart + 60 * MINUTE),
        endTime: t(sessionEnd),
        slotMinutes: 30,
        // A real break window covering "now" — this is what makes the
        // "On break" status derivable rather than invented.
        breaks: [{ start: t(roundDownToStep(now - 10 * MINUTE, 5)), end: t(roundDownToStep(now + 20 * MINUTE, 5)) }],
      },
      createdAt: minutesAgo(150 * 24 * 60),
    },
    {
      providerId: 'dr-vikram-das',
      name: 'Dr. Vikram Das',
      gender: 'Male',
      dateOfBirth: '1976-09-09',
      mobile: '+91 98455 61234',
      email: 'vikram.das@example.com',
      department: 'General Medicine',
      specialty: 'Diabetology',
      qualification: 'MBBS, MD (General Medicine)',
      registrationNumber: 'KMC-39088',
      experienceYears: 20,
      employeeId: 'SHRI-DOC-003',
      consultationType: 'Outpatient + Teleconsult',
      consultationFee: 300,
      room: 'Room 1, Block A',
      loginEmail: 'vikram.das@example.com',
      role: 'Senior Consultant',
      status: 'Active',
      // Coarse 30-minute grid; every slot gets consumed below -> Fully booked.
      schedule: { workingDays: ALL_DAYS, startTime: t(sessionStart), endTime: t(sessionStart + 240 * MINUTE), slotMinutes: 30, breaks: [] },
      createdAt: minutesAgo(700 * 24 * 60),
    },
    {
      providerId: 'dr-raj-srinivas',
      name: 'Dr. Raj Srinivas',
      gender: 'Male',
      dateOfBirth: '1971-08-21',
      mobile: '+91 98451 30418',
      email: 'raj.srinivas@example.com',
      department: 'Neurosurgery',
      specialty: 'Neurosurgeon',
      qualification: 'MBBS, MS, MCh (Neurosurgery)',
      registrationNumber: 'TNMC-61307',
      experienceYears: 22,
      employeeId: 'SHRI-DOC-031',
      consultationType: 'Outpatient',
      consultationFee: 300,
      room: 'Room 16, Block B',
      loginEmail: 'raj.srinivas@example.com',
      role: 'Senior Consultant',
      status: 'Active',
      schedule: { workingDays: ALL_DAYS, startTime: t(sessionStart), endTime: t(sessionEnd), slotMinutes: 20, breaks: [] },
      createdAt: minutesAgo(600 * 24 * 60),
    },
    {
      providerId: 'dr-logesh',
      name: 'Dr. Logesh',
      gender: 'Male',
      dateOfBirth: '1986-01-09',
      mobile: '+91 97890 44126',
      email: 'logesh@example.com',
      department: 'Emergency',
      specialty: 'Emergency Care Specialist',
      qualification: 'MBBS, MD (Emergency Medicine)',
      registrationNumber: 'TNMC-88214',
      experienceYears: 11,
      employeeId: 'SHRI-DOC-036',
      consultationType: 'Outpatient',
      consultationFee: 200,
      room: 'Emergency Block, Bay 2',
      loginEmail: 'logesh@example.com',
      role: 'Consultant',
      status: 'Active',
      schedule: { workingDays: ALL_DAYS, startTime: t(sessionStart), endTime: t(sessionEnd), slotMinutes: 15, breaks: [] },
      createdAt: minutesAgo(250 * 24 * 60),
    },
    // Every department has at least five doctors (more below), so the
    // desk always has a real choice — the same records drive the directory,
    // booking, Doctor's Availability and every filter.
    seedDoctor({
      providerId: 'dr-sanjay-iyer', name: 'Dr. Sanjay Iyer', gender: 'Male', dateOfBirth: '1979-02-14', mobile: '+91 98456 20341', handle: 'sanjay.iyer',
      department: 'Neurology', specialty: 'Movement Disorders', qualification: 'MBBS, MD, DM (Neurology)', registrationNumber: 'KMC-55617', experienceYears: 15,
      employeeId: 'SHRI-DOC-044', consultationType: 'Outpatient', consultationFee: 250, room: 'Room 15, Block B', role: 'Consultant',
      start: sessionStart + 30 * MINUTE, end: sessionEnd, slotMinutes: 20, days: 280,
    }),
    seedDoctor({
      providerId: 'dr-revathi-reddy', name: 'Dr. Revathi Reddy', gender: 'Female', dateOfBirth: '1983-11-02', mobile: '+91 98457 41190', handle: 'revathi.reddy',
      department: 'Cardiology', specialty: 'Cardiac Electrophysiology', qualification: 'MBBS, MD, DM (Cardiology)', registrationNumber: 'KMC-60482', experienceYears: 11,
      employeeId: 'SHRI-DOC-047', consultationType: 'Outpatient + Teleconsult', consultationFee: 250, room: 'Room 5, Block A', role: 'Consultant',
      start: sessionStart, end: sessionEnd, slotMinutes: 15, days: 190,
      // A lunch break in the afternoon part of her session.
      breaks: [{ start: t(sessionStart + 180 * MINUTE), end: t(sessionStart + 210 * MINUTE) }],
    }),
    seedDoctor({
      providerId: 'dr-harish-menon', name: 'Dr. Harish Menon', gender: 'Male', dateOfBirth: '1972-06-25', mobile: '+91 98458 77012', handle: 'harish.menon',
      department: 'Cardiology', specialty: 'Heart Failure & Preventive Cardiology', qualification: 'MBBS, MD, DM (Cardiology)', registrationNumber: 'KMC-41275', experienceYears: 21,
      employeeId: 'SHRI-DOC-009', consultationType: 'Outpatient', consultationFee: 300, room: 'Room 6, Block A', role: 'Senior Consultant',
      start: sessionStart + 60 * MINUTE, end: sessionEnd, slotMinutes: 20, days: 820,
    }),
    seedDoctor({
      providerId: 'dr-farah-ahmed', name: 'Dr. Farah Ahmed', gender: 'Female', dateOfBirth: '1988-04-19', mobile: '+91 98459 30558', handle: 'farah.ahmed',
      department: 'General Medicine', specialty: 'Family Medicine', qualification: 'MBBS, MD (Family Medicine)', registrationNumber: 'TNMC-90417', experienceYears: 7,
      employeeId: 'SHRI-DOC-051', consultationType: 'Outpatient + Teleconsult', consultationFee: 150, room: 'Room 3, Block A', role: 'Associate Consultant',
      start: sessionStart, end: sessionEnd, slotMinutes: 15, days: 120,
    }),
    seedDoctor({
      providerId: 'dr-ashwin-kamath', name: 'Dr. Ashwin Kamath', gender: 'Male', dateOfBirth: '1984-09-07', mobile: '+91 98460 12873', handle: 'ashwin.kamath',
      department: 'Orthopedics', specialty: 'Sports Medicine & Arthroscopy', qualification: 'MBBS, MS (Orthopaedics)', registrationNumber: 'KMC-63911', experienceYears: 10,
      employeeId: 'SHRI-DOC-038', consultationType: 'Outpatient', consultationFee: 200, room: 'Room 9, Block C', role: 'Consultant',
      start: sessionStart, end: sessionEnd, slotMinutes: 20, days: 340,
    }),
    seedDoctor({
      providerId: 'dr-nandini-hegde', name: 'Dr. Nandini Hegde', gender: 'Female', dateOfBirth: '1980-12-03', mobile: '+91 98461 56024', handle: 'nandini.hegde',
      department: 'Orthopedics', specialty: 'Spine & Trauma', qualification: 'MBBS, MS (Orthopaedics), FNB (Spine)', registrationNumber: 'KMC-50734', experienceYears: 14,
      employeeId: 'SHRI-DOC-027', consultationType: 'Outpatient', consultationFee: 250, room: 'Room 10, Block C', role: 'Consultant',
      start: sessionStart + 30 * MINUTE, end: sessionEnd, slotMinutes: 30, days: 510,
    }),
    seedDoctor({
      providerId: 'dr-suresh-pillai', name: 'Dr. Suresh Pillai', gender: 'Male', dateOfBirth: '1969-03-28', mobile: '+91 98462 90317', handle: 'suresh.pillai',
      department: 'Neurosurgery', specialty: 'Spine Surgery', qualification: 'MBBS, MS, MCh (Neurosurgery)', registrationNumber: 'TNMC-47902', experienceYears: 25,
      employeeId: 'SHRI-DOC-005', consultationType: 'Outpatient', consultationFee: 300, room: 'Room 17, Block B', role: 'Senior Consultant',
      start: sessionStart, end: sessionEnd, slotMinutes: 30, days: 900,
    }),
    seedDoctor({
      providerId: 'dr-divya-raghavan', name: 'Dr. Divya Raghavan', gender: 'Female', dateOfBirth: '1985-07-16', mobile: '+91 98463 22148', handle: 'divya.raghavan',
      department: 'Neurosurgery', specialty: 'Paediatric Neurosurgery', qualification: 'MBBS, MS, MCh (Neurosurgery)', registrationNumber: 'KMC-66205', experienceYears: 9,
      employeeId: 'SHRI-DOC-049', consultationType: 'Outpatient + Teleconsult', consultationFee: 250, room: 'Room 18, Block B', role: 'Consultant',
      // Starts after her morning theatre list.
      start: sessionStart + 90 * MINUTE, end: sessionEnd, slotMinutes: 20, days: 230,
    }),
    seedDoctor({
      providerId: 'dr-arvind-shetty', name: 'Dr. Arvind Shetty', gender: 'Male', dateOfBirth: '1982-01-30', mobile: '+91 98464 71530', handle: 'arvind.shetty',
      department: 'Emergency', specialty: 'Acute Medicine', qualification: 'MBBS, MD (Emergency Medicine)', registrationNumber: 'KMC-58840', experienceYears: 12,
      employeeId: 'SHRI-DOC-033', consultationType: 'Outpatient', consultationFee: 200, room: 'Emergency Block, Bay 3', role: 'Consultant',
      start: sessionStart, end: sessionEnd, slotMinutes: 15, days: 310,
    }),
    seedDoctor({
      providerId: 'dr-swetha-venkat', name: 'Dr. Swetha Venkat', gender: 'Female', dateOfBirth: '1990-10-11', mobile: '+91 98465 08623', handle: 'swetha.venkat',
      department: 'Emergency', specialty: 'Trauma Care', qualification: 'MBBS, MD (Emergency Medicine)', registrationNumber: 'TNMC-93361', experienceYears: 6,
      employeeId: 'SHRI-DOC-053', consultationType: 'Outpatient', consultationFee: 150, room: 'Emergency Block, Bay 4', role: 'Associate Consultant',
      start: sessionStart, end: sessionEnd, slotMinutes: 15, days: 95,
    }),
    // Two more for every department, so each has a fuller choice of doctors.
    seedDoctor({
      providerId: 'dr-kavitha-sundaram', name: 'Dr. Kavitha Sundaram', gender: 'Female', dateOfBirth: '1981-05-09', mobile: '+91 98466 31245', handle: 'kavitha.sundaram',
      department: 'General Medicine', specialty: 'Internal Medicine', qualification: 'MBBS, MD (General Medicine)', registrationNumber: 'TNMC-71823', experienceYears: 13,
      employeeId: 'SHRI-DOC-055', consultationType: 'Outpatient + Teleconsult', consultationFee: 200, room: 'Room 4, Block A', role: 'Consultant',
      start: sessionStart, end: sessionEnd, slotMinutes: 15, days: 260,
    }),
    seedDoctor({
      providerId: 'dr-prakash-natarajan', name: 'Dr. Prakash Natarajan', gender: 'Male', dateOfBirth: '1976-08-21', mobile: '+91 98467 50982', handle: 'prakash.natarajan',
      department: 'General Medicine', specialty: 'Infectious Diseases', qualification: 'MBBS, MD (General Medicine), FID', registrationNumber: 'TNMC-62047', experienceYears: 18,
      employeeId: 'SHRI-DOC-056', consultationType: 'Outpatient', consultationFee: 250, room: 'Room 7, Block A', role: 'Senior Consultant',
      start: sessionStart + 30 * MINUTE, end: sessionEnd, slotMinutes: 15, days: 640,
    }),
    seedDoctor({
      providerId: 'dr-deepak-varma', name: 'Dr. Deepak Varma', gender: 'Male', dateOfBirth: '1984-03-12', mobile: '+91 98468 27713', handle: 'deepak.varma',
      department: 'Emergency', specialty: 'Critical Care', qualification: 'MBBS, MD (Emergency Medicine), IDCCM', registrationNumber: 'KMC-61392', experienceYears: 11,
      employeeId: 'SHRI-DOC-057', consultationType: 'Outpatient', consultationFee: 200, room: 'Emergency Block, Bay 5', role: 'Consultant',
      start: sessionStart, end: sessionEnd, slotMinutes: 15, days: 300,
    }),
    seedDoctor({
      providerId: 'dr-lakshmi-priya', name: 'Dr. Lakshmi Priya', gender: 'Female', dateOfBirth: '1991-12-04', mobile: '+91 98469 64028', handle: 'lakshmi.priya',
      department: 'Emergency', specialty: 'Toxicology & Emergency Care', qualification: 'MBBS, MD (Emergency Medicine)', registrationNumber: 'TNMC-95108', experienceYears: 5,
      employeeId: 'SHRI-DOC-058', consultationType: 'Outpatient', consultationFee: 150, room: 'Emergency Block, Bay 6', role: 'Associate Consultant',
      start: sessionStart, end: sessionEnd, slotMinutes: 15, days: 80,
    }),
    seedDoctor({
      providerId: 'dr-karthik-raman', name: 'Dr. Karthik Raman', gender: 'Male', dateOfBirth: '1978-10-30', mobile: '+91 98470 18456', handle: 'karthik.raman',
      department: 'Cardiology', specialty: 'Interventional Cardiology', qualification: 'MBBS, MD, DM (Cardiology)', registrationNumber: 'TNMC-58361', experienceYears: 17,
      employeeId: 'SHRI-DOC-059', consultationType: 'Outpatient', consultationFee: 300, room: 'Room 8, Block A', role: 'Senior Consultant',
      start: sessionStart + 60 * MINUTE, end: sessionEnd, slotMinutes: 20, days: 700,
    }),
    seedDoctor({
      providerId: 'dr-shalini-gupta', name: 'Dr. Shalini Gupta', gender: 'Female', dateOfBirth: '1987-02-17', mobile: '+91 98471 39287', handle: 'shalini.gupta',
      department: 'Cardiology', specialty: 'Paediatric Cardiology', qualification: 'MBBS, MD (Paediatrics), DM (Cardiology)', registrationNumber: 'KMC-67520', experienceYears: 9,
      employeeId: 'SHRI-DOC-060', consultationType: 'Outpatient + Teleconsult', consultationFee: 250, room: 'Room 11, Block A', role: 'Consultant',
      start: sessionStart + 30 * MINUTE, end: sessionEnd, slotMinutes: 20, days: 210,
    }),
    seedDoctor({
      providerId: 'dr-vivek-chandran', name: 'Dr. Vivek Chandran', gender: 'Male', dateOfBirth: '1982-07-08', mobile: '+91 98472 70614', handle: 'vivek.chandran',
      department: 'Neurology', specialty: 'Epilepsy', qualification: 'MBBS, MD, DM (Neurology)', registrationNumber: 'KMC-59973', experienceYears: 12,
      employeeId: 'SHRI-DOC-061', consultationType: 'Outpatient', consultationFee: 250, room: 'Room 16, Block B', role: 'Consultant',
      start: sessionStart, end: sessionEnd, slotMinutes: 20, days: 330,
    }),
    seedDoctor({
      providerId: 'dr-anitha-george', name: 'Dr. Anitha George', gender: 'Female', dateOfBirth: '1986-11-25', mobile: '+91 98473 05539', handle: 'anitha.george',
      department: 'Neurology', specialty: 'Stroke & Headache', qualification: 'MBBS, MD, DM (Neurology)', registrationNumber: 'TNMC-80264', experienceYears: 10,
      employeeId: 'SHRI-DOC-062', consultationType: 'Outpatient + Teleconsult', consultationFee: 250, room: 'Room 19, Block B', role: 'Consultant',
      start: sessionStart + 60 * MINUTE, end: sessionEnd, slotMinutes: 20, days: 250,
    }),
    seedDoctor({
      providerId: 'dr-rajesh-kannan', name: 'Dr. Rajesh Kannan', gender: 'Male', dateOfBirth: '1974-04-03', mobile: '+91 98474 82106', handle: 'rajesh.kannan',
      department: 'Neurosurgery', specialty: 'Brain Tumour Surgery', qualification: 'MBBS, MS, MCh (Neurosurgery)', registrationNumber: 'TNMC-52689', experienceYears: 20,
      employeeId: 'SHRI-DOC-063', consultationType: 'Outpatient', consultationFee: 350, room: 'Room 20, Block B', role: 'Senior Consultant',
      start: sessionStart + 90 * MINUTE, end: sessionEnd, slotMinutes: 30, days: 780,
    }),
    seedDoctor({
      providerId: 'dr-pooja-menon', name: 'Dr. Pooja Menon', gender: 'Female', dateOfBirth: '1989-06-14', mobile: '+91 98475 41873', handle: 'pooja.menon',
      department: 'Neurosurgery', specialty: 'Functional Neurosurgery', qualification: 'MBBS, MS, MCh (Neurosurgery)', registrationNumber: 'KMC-68841', experienceYears: 7,
      employeeId: 'SHRI-DOC-064', consultationType: 'Outpatient', consultationFee: 250, room: 'Room 21, Block B', role: 'Associate Consultant',
      start: sessionStart + 30 * MINUTE, end: sessionEnd, slotMinutes: 20, days: 140,
    }),
    seedDoctor({
      providerId: 'dr-manoj-krishnan', name: 'Dr. Manoj Krishnan', gender: 'Male', dateOfBirth: '1979-09-19', mobile: '+91 98476 26450', handle: 'manoj.krishnan',
      department: 'Orthopedics', specialty: 'Joint Replacement', qualification: 'MBBS, MS (Orthopaedics), FJRS', registrationNumber: 'TNMC-60715', experienceYears: 16,
      employeeId: 'SHRI-DOC-065', consultationType: 'Outpatient', consultationFee: 300, room: 'Room 11, Block C', role: 'Senior Consultant',
      start: sessionStart + 30 * MINUTE, end: sessionEnd, slotMinutes: 20, days: 560,
    }),
    seedDoctor({
      providerId: 'dr-sneha-balaji', name: 'Dr. Sneha Balaji', gender: 'Female', dateOfBirth: '1990-01-27', mobile: '+91 98477 93162', handle: 'sneha.balaji',
      department: 'Orthopedics', specialty: 'Paediatric Orthopaedics', qualification: 'MBBS, MS (Orthopaedics)', registrationNumber: 'KMC-70396', experienceYears: 6,
      employeeId: 'SHRI-DOC-066', consultationType: 'Outpatient + Teleconsult', consultationFee: 200, room: 'Room 12, Block C', role: 'Associate Consultant',
      start: sessionStart, end: sessionEnd, slotMinutes: 20, days: 110,
    }),
  ]

  // Dr. Meera Shah is on approved leave today — drives the "On leave" status.
  const leaves: DoctorLeave[] = [{ leaveId: 'leave-1', providerId: 'dr-meera-shah', date: today, reason: 'Approved leave' }]

  // ------------------------------------------------------------- patients
  // 31 patients, each with one story that every record about them tells the
  // same way — bookings, queue, bills, admission, guest pass, MLC, estimate.
  // UHIDs rise with the date of registration; today's registrations are the
  // newest. A deliberate duplicate pair shares a mobile number.
  const patient = (
    p: Omit<Patient, 'patientId' | 'registrationStatus' | 'nameNative' | 'email' | 'abhaId'> &
      Partial<Pick<Patient, 'nameNative' | 'email' | 'abhaId'>>,
  ): Patient => ({ patientId: p.uhid, registrationStatus: 'Registered', nameNative: null, email: null, abhaId: null, ...p })

  const patients: Patient[] = [
    // In a bed now
    patient({ uhid: 'ISH-0044120', name: 'Ramesh Babu', nameNative: 'ரமேஷ் பாபு', age: 64, sex: 'Male', mobile: '+91 98431 22456', address: '12 Raja Street, R.S. Puram, Coimbatore 641002', abhaId: 'ramesh.babu@abdm', createdAt: daysAgo(400) }),
    patient({ uhid: 'ISH-0069958', name: 'Abdul Rahman', nameNative: 'عبدالرحمن', age: 59, sex: 'Male', mobile: '+91 98422 70315', email: 'a.rahman@example.com', address: '31 Big Bazaar Street, Town Hall, Coimbatore 641001', abhaId: 'abdul.rahman@abdm', createdAt: daysAgo(280) }),
    patient({ uhid: 'ISH-0102234', name: 'Anjali Menon', nameNative: 'അഞ്ജലി മേനോൻ', age: 29, sex: 'Female', mobile: '+91 99000 44310', email: 'anjali.menon@example.com', address: '7 Lake View, Race Course, Coimbatore 641018', createdAt: daysAgo(90) }),
    patient({ uhid: 'ISH-0106392', name: 'Selvi Murugan', nameNative: 'செல்வி முருகன்', age: 71, sex: 'Female', mobile: '+91 98940 31876', address: '5 Kamarajar Street, Ganapathy, Coimbatore 641006', abhaId: '91-4410-2286-7731', createdAt: daysAgo(75) }),
    patient({ uhid: 'ISH-0125590', name: 'Karthik Subramanian', nameNative: 'கார்த்திக் சுப்பிரமணியன்', age: 52, sex: 'Male', mobile: '+91 94440 66231', address: '88 Avinashi Road, Peelamedu, Coimbatore 641004', abhaId: 'karthik.s@abdm', createdAt: hoursAgo(21) }),
    patient({ uhid: 'ISH-0129901', name: 'Mohan Raj', nameNative: 'மோகன் ராஜ்', age: 38, sex: 'Male', mobile: '+91 97890 22144', address: '19 Sathy Road, Saravanampatti, Coimbatore 641035', createdAt: minutesAgo(150) }),

    // Waiting for a bed
    patient({ uhid: 'ISH-0111045', name: 'Mohammed Irfan', age: 35, sex: 'Male', mobile: '+91 90031 77812', address: '21 Cross Cut Road, Gandhipuram, Coimbatore 641012', abhaId: 'mohammed.irfan@abdm', aliases: ['mohamed irfan', 'muhammad irfan'], createdAt: daysAgo(60) }),
    patient({ uhid: 'ISH-0122871', name: 'Kavitha Balaji', nameNative: 'கவிதா பாலாஜி', age: 56, sex: 'Female', mobile: '+91 99438 12055', address: '14 Bharathi Park Road, Saibaba Colony, Coimbatore 641011', abhaId: 'kavitha.b@abdm', createdAt: daysAgo(20) }),

    // Outpatients in the queue today
    patient({ uhid: 'ISH-0091133', name: 'R. Lakshmanan', nameNative: 'ஆர். லக்ஷ்மணன்', age: 58, sex: 'Male', mobile: '+91 98432 11987', address: '44 Gandhi Road, Peelamedu, Coimbatore 641004', abhaId: 'lakshmanan.r@abdm', aliases: ['laxmanan r', 'laxmanan'], createdAt: daysAgo(200) }),
    patient({ uhid: 'ISH-0118934', name: 'Gopal Krishnan', nameNative: 'கோபால் கிருஷ்ணன்', age: 67, sex: 'Male', mobile: '+91 94433 50871', address: '3 Nehru Street, Ramanathapuram, Coimbatore 641045', createdAt: daysAgo(32) }),
    patient({ uhid: 'ISH-0120338', name: 'Sunita Rao', age: 47, sex: 'Female', mobile: '+91 98860 20114', address: '3 Trichy Road, Sungam, Coimbatore 641045', createdAt: daysAgo(30) }),
    patient({ uhid: 'ISH-0117760', name: 'Harish Chandran', nameNative: 'ഹരീഷ് ചന്ദ്രൻ', age: 44, sex: 'Male', mobile: '+91 95669 04218', email: 'harish.c@example.com', address: '27 Thadagam Road, Vadavalli, Coimbatore 641041', abhaId: '71-2093-5518-4402', createdAt: daysAgo(35) }),
    patient({ uhid: 'ISH-0124106', name: 'Arjun Prakash', age: 26, sex: 'Male', mobile: '+91 90807 44562', email: 'arjun.prakash@example.com', address: '62 DB Road, R.S. Puram, Coimbatore 641002', abhaId: 'arjun.prakash@abdm', createdAt: daysAgo(12) }),
    patient({ uhid: 'ISH-0078812', name: 'Fatima Sheikh', nameNative: 'فاطمہ شیخ', age: 41, sex: 'Female', mobile: '+91 90441 55220', email: 'f.sheikh@example.com', address: '9 Mill Road, Singanallur, Coimbatore 641005', abhaId: '34-1187-0043-9921', createdAt: daysAgo(260) }),
    patient({ uhid: 'ISH-0129904', name: 'Ravi Shankar', age: 29, sex: 'Male', mobile: '+91 99520 61873', address: '8 Kalingarayan Street, Ram Nagar, Coimbatore 641009', createdAt: minutesAgo(20) }),

    // Booked for later today
    patient({ uhid: 'ISH-0114479', name: 'Lakshmi Narayanan', nameNative: 'லட்சுமி நாராயணன்', age: 54, sex: 'Female', mobile: '+91 94860 15532', address: '11 Avarampalayam Road, Coimbatore 641006', abhaId: 'lakshmi.n@abdm', createdAt: daysAgo(45) }),
    patient({ uhid: 'ISH-0125311', name: 'Deepa Krishnan', nameNative: 'தீபா கிருஷ்ணன்', age: 33, sex: 'Female', mobile: '+91 98653 27740', address: '45 Sowripalayam Road, Coimbatore 641028', createdAt: daysAgo(2) }),
    patient({ uhid: 'ISH-0129902', name: 'Nisha Varghese', nameNative: 'നിഷ വർഗീസ്', age: 31, sex: 'Female', mobile: '+91 97455 80213', email: 'nisha.v@example.com', address: '4 Lawley Road, Coimbatore 641003', createdAt: minutesAgo(75) }),
    // Duplicate of R. Lakshmanan: same mobile, transliterated name, registered
    // again today. getPossibleDuplicates() finds this from the data itself.
    patient({ uhid: 'ISH-0129903', name: 'Laxmanan R', age: 58, sex: 'Male', mobile: '+91 98432 11987', address: '44 Gandhi Road, Peelamedu, Coimbatore 641004', createdAt: minutesAgo(52) }),

    // Dr. Vikram Das's full day
    patient({ uhid: 'ISH-0057164', name: 'Senthil Kumar', nameNative: 'செந்தில் குமார்', age: 49, sex: 'Male', mobile: '+91 98944 10273', address: '22 Masakalipalayam Road, Peelamedu, Coimbatore 641004', abhaId: 'senthil.k@abdm', aliases: ['senthilkumar'], createdAt: daysAgo(330) }),
    patient({ uhid: 'ISH-0063390', name: 'Meenakshi Sundaram', nameNative: 'மீனாட்சி சுந்தரம்', age: 62, sex: 'Female', mobile: '+91 94421 88306', address: '9 Sarojini Street, Ram Nagar, Coimbatore 641009', createdAt: daysAgo(300) }),
    patient({ uhid: 'ISH-0083041', name: 'Prakash Rao', nameNative: 'ಪ್ರಕಾಶ್ ರಾವ್', age: 57, sex: 'Male', mobile: '+91 98450 63117', email: 'prakash.rao@example.com', address: '16 Bharathi Nagar, Ganapathy, Coimbatore 641006', abhaId: '56-3301-7745-1208', createdAt: daysAgo(240) }),
    patient({ uhid: 'ISH-0087576', name: 'Geetha Raman', nameNative: 'கீதா ராமன்', age: 50, sex: 'Female', mobile: '+91 99940 27165', address: '2 Thiruvenkatasamy Road, R.S. Puram, Coimbatore 641002', abhaId: 'geetha.raman@abdm', createdAt: daysAgo(220) }),
    patient({ uhid: 'ISH-0095218', name: 'Shabana Begum', nameNative: 'شبانہ بیگم', age: 46, sex: 'Female', mobile: '+91 90037 41129', address: '7 Ukkadam Main Road, Coimbatore 641001', createdAt: daysAgo(170) }),
    patient({ uhid: 'ISH-0098647', name: 'S. Kumaravel', nameNative: 'எஸ். குமரவேல்', age: 55, sex: 'Male', mobile: '+91 97877 52310', address: '40 Mettupalayam Road, Thudiyalur, Coimbatore 641034', createdAt: daysAgo(150) }),
    patient({ uhid: 'ISH-0108815', name: 'Imran Basha', nameNative: 'عمران باشا', age: 41, sex: 'Male', mobile: '+91 98946 77021', address: '12 Karumbukadai Main Road, Coimbatore 641008', abhaId: 'imran.basha@abdm', createdAt: daysAgo(70) }),
    patient({ uhid: 'ISH-0116023', name: 'Uma Maheswari', nameNative: 'ఉమా మహేశ్వరి', age: 36, sex: 'Female', mobile: '+91 93453 60948', email: 'uma.m@example.com', address: '18 Kovaipudur Main Road, Coimbatore 641042', abhaId: '88-5512-0937-6634', createdAt: daysAgo(40) }),
    patient({ uhid: 'ISH-0048305', name: 'Joseph Thomas', nameNative: 'ജോസഫ് തോമസ്', age: 68, sex: 'Male', mobile: '+91 94473 50127', address: '6 Church Road, Podanur, Coimbatore 641023', createdAt: daysAgo(380) }),

    // Discharged
    patient({ uhid: 'ISH-0052719', name: 'Saraswathi Ammal', nameNative: 'சரஸ்வதி அம்மாள்', age: 76, sex: 'Female', mobile: '+91 98425 66018', address: '25 Vysial Street, Town Hall, Coimbatore 641001', createdAt: daysAgo(350) }),
    patient({ uhid: 'ISH-0125584', name: 'Naveen Chandra', age: 34, sex: 'Male', mobile: '+91 96007 18233', address: '91 Nanjundapuram Road, Coimbatore 641036', abhaId: 'naveen.chandra@abdm', createdAt: hoursAgo(23) }),

    // Registered a few minutes ago — nothing else yet
    patient({ uhid: 'ISH-0129905', name: 'Pooja Sharma', nameNative: 'पूजा शर्मा', age: 24, sex: 'Female', mobile: '+91 99766 31245', email: 'pooja.sharma@example.com', address: '33 Avinashi Road, Hope College, Coimbatore 641004', createdAt: minutesAgo(8) }),
  ]

  // Longitudinal records — registered from 2022 on, with visits since, and
  // some arriving today (see seedPatientHistory.ts). Same builders, same list.
  PATIENT_HISTORY.forEach((h, index) => {
    const createdAt =
      typeof h.registered === 'string'
        ? dayStartTimestamp(h.registered) + 6 * HOUR
        : typeof h.registered === 'number'
          ? dayStart + h.registered * DAY + 6 * HOUR
          : Math.max(dayStart + 5 * MINUTE, minutesAgo(h.registered.minutesAgo))
    patients.push(patient({ uhid: h.uhid, name: h.name, nameNative: h.nameNative, age: h.age, sex: h.sex, email: h.email, abhaId: h.abhaId, ...contactFor(index), createdAt }))
  })

  const patientOf = (patientId: string) => patients.find((p) => p.patientId === patientId)!
  const providerOf = (providerId: string) => providers.find((p) => p.providerId === providerId)!

  const activityLog: ActivityLogEntry[] = []
  const logAt = (time: number, text: string, meta?: string) => activityLog.push({ id: '', time, text, meta })

  // ---------------------------------------------------------------- bills
  // Administrative bills only, never a clinical charge. Built through one
  // helper so total, balance and status always agree with what was
  // collected; numbered in the order they happened at the end.
  const payments: Payment[] = []
  const pushBill = ({
    patientId,
    items,
    createdAt,
    appointmentId = null,
    admissionId = null,
    estimateId = null,
    collections = [],
    failed = [],
    refund,
    cancelled,
  }: SeedBill): Payment => {
    const total = sumItems(items)
    const paid = collections.reduce((sum, c) => sum + c.amount, 0)
    const name = patientOf(patientId).name
    const bill: Payment = {
      paymentId: '',
      receiptNo: '',
      patientId,
      patientName: name,
      appointmentId,
      estimateId,
      admissionId,
      items,
      totalAmount: total,
      paidAmount: paid,
      balance: Math.max(0, total - paid),
      status: cancelled ? 'Cancelled' : refund ? 'Refunded' : paid >= total ? 'Paid' : paid > 0 ? 'Partially Paid' : 'Pending',
      transactions: collections.map((c) => ({ transactionId: '', amount: c.amount, method: c.method, collectedAt: c.at })),
      failedAttempts: failed.map((f) => ({ attemptId: '', amount: f.amount, method: f.method, reason: f.reason, attemptedAt: f.at })),
      refund: refund
        ? { refundId: '', amount: paid, reason: refund.reason, refundedAt: refund.at, methods: [...new Set(collections.map((c) => c.method))] }
        : null,
      createdAt,
      updatedAt: Math.max(createdAt, ...collections.map((c) => c.at), ...failed.map((f) => f.at), refund?.at ?? 0, cancelled?.at ?? 0),
      cancelledAt: cancelled?.at ?? null,
      cancelReason: cancelled?.reason ?? null,
    }
    payments.push(bill)
    for (const c of collections) logAt(c.at, 'Payment received at the billing counter', `${name} · ${formatRupees(c.amount)} · ${c.method}`)
    for (const f of failed) logAt(f.at, 'Payment attempt failed', `${name} · ${formatRupees(f.amount)} · ${f.method} · ${f.reason}`)
    if (refund) logAt(refund.at, 'Payment refunded', `${name} · ${formatRupees(paid)}`)
    return bill
  }

  /** A consultation's bill line — the doctor's own fee, the only charge a
   *  booking carries (registering is free). */
  const consultationItems = (providerId: string): PaymentItem[] => {
    const provider = providerOf(providerId)
    return [{ code: 'CONS-FEE', description: `Consultation — ${provider.name}`, amount: provider.consultationFee }]
  }

  // ---------------------------------------------------------- outpatients
  const slotsOf = (providerId: string): string[] => {
    const provider = providerOf(providerId)
    const { startTime, endTime, slotMinutes } = provider.schedule
    const out: string[] = []
    for (let ts = slotToTimestamp(today, startTime); ts <= slotToTimestamp(today, endTime); ts += slotMinutes * MINUTE) {
      out.push(slotLabel(ts))
    }
    return out
  }


  // No slot is ever booked twice, whatever the hour the app opens at.
  const taken = new Set<string>()
  const slotKey = (providerId: string, date: string, slot: string) => `${providerId}|${date}|${slot}`

  /** Today's slot `offset` places from the doctor's next one (negative =
   *  already past) — or the nearest free one on the same side of now that
   *  `fits`. Null when there is none: early in the morning there is no past. */
  function todaySlot(providerId: string, offset: number, fits: (slotTs: number) => boolean): string | null {
    const slots = slotsOf(providerId).map((slot) => ({ slot, ts: slotToTimestamp(today, slot) }))
    const next = slots.findIndex((s) => s.ts >= now)
    const split = next === -1 ? slots.length : next
    const side = offset < 0 ? slots.slice(0, split).reverse() : slots.slice(split)
    const want = Math.min(offset < 0 ? -offset - 1 : offset, side.length)
    const nearestFirst = [...side.slice(want), ...side.slice(0, want).reverse()]
    return nearestFirst.find((s) => fits(s.ts) && !taken.has(slotKey(providerId, today, s.slot)))?.slot ?? null
  }

  const appointments: Appointment[] = []
  const differenceBills: [RescheduleEntry, Payment][] = []
  const encounters: EncounterSeed[] = []
  let appointmentSeq = 1

  /** Books and pays in one step, as the desk does — every booking carries
   *  exactly one bill. A booking that has happened leaves its visit. */
  function book(seed: BookingSeed): Appointment | null {
    const provider = providerOf(seed.providerId)
    const p = patientOf(seed.patientId)
    let status = seed.status
    let date = dateFromToday(seed.day ?? 0)
    let slot = seed.slot ?? (seed.day ? slotsOf(provider.providerId)[seed.slotIndex ?? 0] : null)
    if (!slot) {
      // Today: a finished visit needs a slot long enough ago, an arrival or
      // a no-show one already past; anything else is still ahead.
      const ahead = (ts: number) => ts >= now
      const offset = seed.offset ?? 0
      if (status === 'Completed') slot = todaySlot(provider.providerId, Math.min(offset, -1), (ts) => ts + 26 * MINUTE <= now)
      else if (status === 'No-show') slot = todaySlot(provider.providerId, Math.min(offset, -1), (ts) => ts + NO_SHOW_GRACE_MINUTES * MINUTE <= now)
      else if (status === 'Checked-in') slot = todaySlot(provider.providerId, Math.min(offset, -1), (ts) => ts < now)
      else slot = todaySlot(provider.providerId, Math.max(offset, 0), ahead)
      if (!slot && status === 'Completed' && seed.fallbackDay) {
        date = dateFromToday(seed.fallbackDay)
        slot = slotsOf(provider.providerId)[seed.slotIndex ?? 3]
      } else if (!slot && status !== 'Confirmed') {
        status = 'Confirmed'
        slot = todaySlot(provider.providerId, Math.max(offset, 1), ahead)
      }
    }
    if (!slot || taken.has(slotKey(provider.providerId, date, slot))) return null
    taken.add(slotKey(provider.providerId, date, slot))
    const slotTs = slotToTimestamp(date, slot)
    const bookedAt = seed.bookedAt ?? Math.max(p.createdAt + 3 * MINUTE, Math.min(slotTs - 2 * HOUR, now - 5 * MINUTE))
    const appointment: Appointment = {
      appointmentId: `apt-${appointmentSeq++}`,
      patientId: p.patientId,
      providerId: provider.providerId,
      department: provider.department,
      date,
      slot,
      status,
      visitId: null,
      reason: seed.reason ?? null,
      mode: seed.mode ?? 'In person',
      createdAt: bookedAt,
      cancelledAt: seed.cancel?.at ?? null,
      cancelledBy: seed.cancel?.by ?? null,
      cancelReason: seed.cancel?.reason ?? null,
      reschedules: [],
    }
    appointments.push(appointment)
    const moved = seed.moved
    const from = moved ? providerOf(moved.fromProviderId ?? provider.providerId) : provider
    if (moved) {
      const entry: RescheduleEntry = {
        at: moved.at,
        from: { providerId: from.providerId, date: dateFromToday(moved.fromDay), slot: slotsOf(from.providerId)[moved.fromSlotIndex], mode: appointment.mode },
        to: { providerId: provider.providerId, date, slot, mode: appointment.mode },
        by: moved.by,
        note: moved.note,
        differencePaymentId: null,
      }
      appointment.reschedules.push(entry)
      logAt(moved.at, 'Appointment rescheduled', `${p.name} · ${from.name} ${entry.from.date} ${formatTime(entry.from.slot)} → ${provider.name} ${date} ${formatTime(slot)} · ${moved.by === 'Doctor' ? 'doctor unavailable' : 'patient’s request'}`)
      const difference = provider.consultationFee - from.consultationFee
      if (difference > 0 && moved.by === 'Patient') {
        const differenceBill = pushBill({
          patientId: p.patientId,
          items: [{ code: 'FEE-DIFF', description: `Fee difference — ${provider.name}`, amount: difference }],
          createdAt: moved.at,
          appointmentId: appointment.appointmentId,
          collections: [{ amount: difference, method: seed.method, at: moved.at + MINUTE }],
        })
        // Bills are numbered at the end; the move names its bill then.
        differenceBills.push([entry, differenceBill])
      }
    }
    const first = appointment.reschedules[0]?.from ?? { date, slot }
    logAt(bookedAt, 'Appointment booked', `${p.name} → ${from.name} at ${formatTime(first.slot)}${first.date === today ? '' : ` on ${first.date}`}`)
    if (seed.cancel) logAt(seed.cancel.at, 'Appointment cancelled', `${p.name} · ${formatTime(slot)} · ${seed.cancel.reason}`)

    // A moved booking was paid for its first doctor; its line now names the
    // doctor the patient will see.
    const items = consultationItems(from.providerId).map((item) =>
      item.code === 'CONS-FEE' ? { ...item, description: `Consultation — ${provider.name}` } : item,
    )
    pushBill({
      patientId: p.patientId,
      items,
      createdAt: bookedAt,
      appointmentId: appointment.appointmentId,
      collections: [{ amount: sumItems(items), method: seed.method, at: bookedAt + MINUTE }],
      refund: seed.cancel?.by === 'Doctor' ? { reason: 'Doctor unavailable', at: seed.cancel.at } : undefined,
    })

    if (status === 'Checked-in' || status === 'Completed') {
      const arrival = status === 'Checked-in' && seed.arrivedAt ? seed.arrivedAt : slotTs - 10 * MINUTE
      encounters.push({
        patientId: p.patientId,
        providerId: provider.providerId,
        appointment,
        arrival,
        tokenStatus: date === today ? (status === 'Completed' ? 'Completed' : (seed.tokenStatus ?? 'Waiting')) : null,
        closedAt: status === 'Completed' ? Math.min(arrival + 34 * MINUTE, now - 2 * MINUTE) : null,
      })
    }
    return appointment
  }

  /** When the patient's latest finished visit ended — what followed it (an
   *  admission request, an estimate) is timed from there. */
  const visitEnd = (patientId: string): number | null =>
    encounters.filter((e) => e.patientId === patientId && e.closedAt).reduce<number | null>((latest, e) => Math.max(latest ?? 0, e.closedAt!), null)


  // History — earlier encounters, so the timeline has a past.
  book({ patientId: 'ISH-0091133', providerId: 'dr-arun-kumar', day: -21, slotIndex: 4, status: 'Completed', method: 'Card' })
  book({ patientId: 'ISH-0078812', providerId: 'dr-priya-nair', day: -45, slotIndex: 1, status: 'Completed', method: 'UPI' })
  book({ patientId: 'ISH-0102234', providerId: 'dr-priya-nair', day: -30, slotIndex: 3, status: 'Completed', method: 'UPI' })
  book({ patientId: 'ISH-0057164', providerId: 'dr-vikram-das', day: -30, slotIndex: 3, status: 'Completed', method: 'UPI' })
  book({ patientId: 'ISH-0044120', providerId: 'dr-arun-kumar', day: -14, slotIndex: 2, status: 'Completed', method: 'UPI' })
  book({ patientId: 'ISH-0048305', providerId: 'dr-vikram-das', day: -7, slotIndex: 4, status: 'Completed', method: 'Card' })
  book({ patientId: 'ISH-0122871', providerId: 'dr-meera-shah', day: -7, slotIndex: 2, status: 'Completed', method: 'UPI', reason: 'Second opinion' })
  book({ patientId: 'ISH-0069958', providerId: 'dr-priya-nair', day: -5, slotIndex: 2, status: 'Completed', method: 'Card' })
  book({ patientId: 'ISH-0052719', providerId: 'dr-rahul-menon', day: -5, slotIndex: 1, status: 'Completed', method: 'UPI' })
  book({ patientId: 'ISH-0106392', providerId: 'dr-vikram-das', day: -3, slotIndex: 2, status: 'Completed', method: 'UPI' })
  // Booked with Dr. Rahul Menon, then cancelled by the patient (travelling)
  // — the fee is kept.
  book({
    patientId: 'ISH-0095218', providerId: 'dr-rahul-menon', day: -10, slotIndex: 2, status: 'Cancelled', method: 'UPI',
    bookedAt: daysAgo(12), cancel: { by: 'Patient', reason: 'Patient travelling', at: daysAgo(11) },
  })
  // Booked with Dr. Meera Shah, who then could not attend — cancelled as
  // doctor unavailable, so the fee went back to the card it came from.
  book({
    patientId: 'ISH-0063390', providerId: 'dr-meera-shah', day: -2, slotIndex: 2, status: 'Cancelled', method: 'Card',
    bookedAt: daysAgo(3), cancel: { by: 'Doctor', reason: 'Dr. Meera Shah unavailable', at: daysAgo(3) + 3 * HOUR },
  })

  // Today — Dr. Arun Kumar: one seen this morning (admission advised), one
  // called in now, one still to come.
  book({ patientId: 'ISH-0111045', providerId: 'dr-arun-kumar', offset: -7, status: 'Completed', method: 'UPI', fallbackDay: -1, slotIndex: 3, reason: 'Review with reports' })
  book({ patientId: 'ISH-0091133', providerId: 'dr-arun-kumar', offset: -2, status: 'Checked-in', method: 'Card', arrivedAt: minutesAgo(24), tokenStatus: 'Called', reason: 'Follow-up' })
  book({ patientId: 'ISH-0125311', providerId: 'dr-arun-kumar', offset: 2, status: 'Confirmed', method: 'UPI', bookedAt: daysAgo(2) + 5 * MINUTE, reason: 'First consultation' })

  // Dr. Rahul Menon — behind schedule: patients checked in for slots already
  // past are still waiting, so the delay is derivable.
  book({ patientId: 'ISH-0118934', providerId: 'dr-rahul-menon', offset: -4, status: 'Checked-in', method: 'UPI', arrivedAt: minutesAgo(52) })
  book({ patientId: 'ISH-0120338', providerId: 'dr-rahul-menon', offset: -1, status: 'Checked-in', method: 'Card', arrivedAt: minutesAgo(16) })
  book({ patientId: 'ISH-0129903', providerId: 'dr-rahul-menon', offset: 3, status: 'Confirmed', method: 'UPI' })

  // Dr. Priya Nair — a no-show, one seen, a new patient booked for her next
  // free slot, and a review still to come by teleconsult.
  book({ patientId: 'ISH-0078812', providerId: 'dr-priya-nair', offset: -6, status: 'No-show', method: 'Card', bookedAt: daysAgo(1) })
  book({ patientId: 'ISH-0124106', providerId: 'dr-priya-nair', offset: -3, status: 'Completed', method: 'UPI', fallbackDay: -1, slotIndex: 5 })
  book({ patientId: 'ISH-0114479', providerId: 'dr-priya-nair', offset: 4, status: 'Confirmed', method: 'Card', bookedAt: daysAgo(1) + 2 * HOUR, reason: 'Review with reports', mode: 'Teleconsult' })
  // Registered this morning and booked straight into her next free slot.
  book({ patientId: 'ISH-0129904', providerId: 'dr-priya-nair', offset: 0, status: 'Confirmed', method: 'UPI', reason: 'First consultation' })

  // Dr. Ananya Rao — on a break, with one patient waiting and one after it.
  book({ patientId: 'ISH-0117760', providerId: 'dr-ananya-rao', offset: -1, status: 'Checked-in', method: 'UPI', arrivedAt: minutesAgo(26) })
  book({ patientId: 'ISH-0129902', providerId: 'dr-ananya-rao', offset: 1, status: 'Confirmed', method: 'UPI', reason: 'First consultation' })

  // Dr. Vikram Das — every slot taken: the morning's patients seen, the rest
  // booked and paid; nobody booked twice.
  const vikramDay = ['ISH-0057164', 'ISH-0063390', 'ISH-0083041', 'ISH-0087576', 'ISH-0095218', 'ISH-0098647', 'ISH-0108815', 'ISH-0116023', 'ISH-0048305']
  slotsOf('dr-vikram-das').forEach((slot, index) => {
    const patientId = vikramDay[index]
    if (!patientId) return
    const seen = slotToTimestamp(today, slot) + 25 * MINUTE <= now
    book({ patientId, providerId: 'dr-vikram-das', slot, status: seen ? 'Completed' : 'Confirmed', method: index % 2 ? 'Card' : 'UPI' })
  })

  // Ahead — Dr. Meera Shah is back tomorrow; a follow-up by teleconsult next week.
  // Uma was booked with Dr. Meera Shah for today; the doctor's leave moved
  // her to tomorrow at the same fee.
  book({
    patientId: 'ISH-0116023', providerId: 'dr-meera-shah', day: 1, slotIndex: 3, status: 'Confirmed', method: 'Card', bookedAt: daysAgo(4), reason: 'Bring the X-ray report',
    moved: { fromDay: 0, fromSlotIndex: 3, by: 'Doctor', note: 'Dr. Meera Shah on leave', at: daysAgo(2) },
  })
  // Saraswathi asked to see the diabetologist instead of Dr. Rahul Menon —
  // she paid the ₹100 difference when the booking was moved.
  book({
    patientId: 'ISH-0052719', providerId: 'dr-vikram-das', day: 2, slotIndex: 2, status: 'Confirmed', method: 'UPI', bookedAt: daysAgo(3), reason: 'Sugar review',
    moved: { fromProviderId: 'dr-rahul-menon', fromDay: 2, fromSlotIndex: 4, by: 'Patient', note: 'Asked to see the diabetologist', at: daysAgo(1) },
  })
  book({ patientId: 'ISH-0057164', providerId: 'dr-vikram-das', day: 7, slotIndex: 1, status: 'Confirmed', method: 'UPI', bookedAt: minutesAgo(100), reason: 'Follow-up', mode: 'Teleconsult' })

  // The newer doctors — referrals later today from this morning's patients,
  // and visits on the coming days, so their hours read as real.
  book({ patientId: 'ISH-0057164', providerId: 'dr-revathi-reddy', offset: 4, status: 'Confirmed', method: 'UPI', bookedAt: minutesAgo(70), reason: 'Referred by Dr. Vikram Das — palpitations' })
  book({ patientId: 'ISH-0063390', providerId: 'dr-ashwin-kamath', offset: 3, status: 'Confirmed', method: 'Card', bookedAt: minutesAgo(95), reason: 'Knee pain' })
  book({ patientId: 'ISH-0083041', providerId: 'dr-sanjay-iyer', offset: 3, status: 'Confirmed', method: 'UPI', bookedAt: daysAgo(1), reason: 'Tremor review' })
  book({ patientId: 'ISH-0087576', providerId: 'dr-farah-ahmed', day: 1, slotIndex: 2, status: 'Confirmed', method: 'UPI', bookedAt: minutesAgo(40), reason: 'Fever follow-up' })
  book({ patientId: 'ISH-0098647', providerId: 'dr-suresh-pillai', day: 2, slotIndex: 1, status: 'Confirmed', method: 'Card', bookedAt: daysAgo(1), reason: 'Lower back pain — MRI review' })
  book({ patientId: 'ISH-0108815', providerId: 'dr-harish-menon', day: 3, slotIndex: 3, status: 'Confirmed', method: 'UPI', bookedAt: daysAgo(2), reason: 'Breathlessness on exertion' })
  book({ patientId: 'ISH-0048305', providerId: 'dr-nandini-hegde', day: 1, slotIndex: 4, status: 'Confirmed', method: 'UPI', bookedAt: minutesAgo(180), reason: 'Neck pain' })

  // The longitudinal patients' visits: earlier days first, each in the
  // doctor's first free slot of that day, then today's visit.
  const dayOfIso = (iso: string) => Math.round((dayStartTimestamp(iso) - dayStart) / DAY)
  PATIENT_HISTORY.forEach((h, patientIndex) => {
    h.visits.forEach((visit, visitIndex) => {
      const day = typeof visit.on === 'string' ? dayOfIso(visit.on) : visit.on
      const slots = slotsOf(visit.doctor)
      const date = dateFromToday(day)
      const first = (patientIndex * 5 + visitIndex * 3) % slots.length
      const slot = slots.map((_, i) => slots[(first + i) % slots.length]).find((candidate) => !taken.has(slotKey(visit.doctor, date, candidate)))
      if (!slot) return
      // A cancelled booking was cancelled by the patient the evening before; the fee stays.
      const slotAt = slotToTimestamp(date, slot)
      book({
        patientId: h.uhid, providerId: visit.doctor, day, slot, status: visit.status === 'Incomplete' ? 'Confirmed' : (visit.status ?? 'Completed'), method: (patientIndex + visitIndex) % 2 ? 'Card' : 'UPI',
        reason: visit.reason,
        cancel: visit.status === 'Cancelled' ? { by: 'Patient', reason: 'Patient could not come', at: slotAt - 14 * HOUR } : undefined,
      })
    })
    const t = h.today
    if (!t) return
    const earlier = typeof h.registered !== 'object'
    book({
      patientId: h.uhid, providerId: t.doctor, offset: t.offset, status: t.status, method: patientIndex % 2 ? 'Card' : 'UPI', reason: t.reason,
      bookedAt: earlier ? daysAgo(1) + patientIndex * 3 * MINUTE : undefined,
      arrivedAt: t.arrivedMinutesAgo ? minutesAgo(t.arrivedMinutesAgo) : undefined,
      tokenStatus: t.token,
      cancel: t.status === 'Cancelled' ? { by: 'Patient', reason: 'Patient unwell — will rebook', at: minutesAgo(45) } : undefined,
    })
  })

  // Visits and tokens in arrival order; token numbers run per department.
  const visits: Visit[] = []
  const queueTokens: QueueToken[] = []
  const tokenCounters: TokenCounters = { NEU: 0, CAR: 0, MED: 0, ORT: 0, NSG: 0, EMG: 0 }
  const PREFIX: Record<string, string> = { Neurology: 'NEU', Cardiology: 'CAR', 'General Medicine': 'MED', Orthopedics: 'ORT', Neurosurgery: 'NSG', 'Emergency': 'EMG' }
  encounters.sort((a, b) => a.arrival - b.arrival)
  encounters.forEach((encounter, index) => {
    const visitId = `visit-${index + 1}`
    const provider = providerOf(encounter.providerId)
    const name = patientOf(encounter.patientId).name
    if (encounter.appointment) encounter.appointment.visitId = visitId
    visits.push({
      visitId,
      patientId: encounter.patientId,
      appointmentId: encounter.appointment?.appointmentId ?? null,
      providerId: provider.providerId,
      status: encounter.closedAt ? 'Closed' : 'Open',
      arrivalTime: encounter.arrival,
      checkInTime: encounter.arrival + MINUTE,
      closedAt: encounter.closedAt,
    })
    logAt(encounter.arrival + MINUTE, 'Patient checked in', `${name} · ${provider.name}${encounter.appointment ? '' : ' · walk-in'}`)
    const status = encounter.tokenStatus
    if (!status) return

    const prefix = PREFIX[provider.department] ?? 'GEN'
    tokenCounters[prefix] = (tokenCounters[prefix] ?? 0) + 1
    const tokenNumber = `${prefix}-${String(tokenCounters[prefix]).padStart(3, '0')}`
    const at = (minutes: number) => Math.min(encounter.arrival + minutes * MINUTE, now - MINUTE)
    queueTokens.push({
      tokenId: `tok-${queueTokens.length + 1}`,
      tokenNumber,
      patientId: encounter.patientId,
      visitId,
      providerId: provider.providerId,
      status,
      createdAt: encounter.arrival + MINUTE,
      calledAt: status === 'Waiting' ? null : at(10),
      startedAt: status === 'In consultation' || status === 'Completed' ? at(12) : null,
      completedAt: status === 'Completed' ? (encounter.closedAt ?? at(34)) - MINUTE : null,
      recalled: false,
    })
    logAt(encounter.arrival + 2 * MINUTE, 'Token generated', `${tokenNumber} · ${name}`)
  })

  // ----------------------------------------------------------- inpatients
  const admissionSeed = createAdmissionSeed(now, {
    visitEnd,
    patientName: (patientId) => patientOf(patientId).name,
    doctor: (providerId) => {
      const doctor = providerOf(providerId)
      return { name: doctor.name, department: doctor.department }
    },
    historicStays: PATIENT_HISTORY.flatMap((h): StaySeed[] => {
      const stay = h.stay
      if (!stay) return []
      const admittedAt = dayStartTimestamp(stay.admittedOn) + 11 * HOUR
      return [
        {
          patientId: h.uhid, doctorId: stay.doctor, admissionType: stay.type, reason: stay.reason, referralSource: stay.referral,
          attendant: { ...stay.attendant, address: null }, paymentType: stay.payment, insuranceProvider: stay.insurer, policyNumber: stay.policy,
          status: 'Discharged', bedId: stay.bedId, admittedAt, dischargedAt: admittedAt + stay.days * DAY - 2 * HOUR,
          dischargeType: stay.dischargeType ?? 'Normal Discharge', dischargeRemarks: stay.remarks,
        },
      ]
    }),
  })
  const stayOf = (patientId: string): Admission => admissionSeed.admissions.find((a) => a.patientId === patientId)!
  const afterAdmission = (patientId: string, minutes: number) => (stayOf(patientId).admittedAt ?? now) + minutes * MINUTE
  const firstDay = (patientId: string) => sumItems(admissionBillItems(stayOf(patientId).roomType ?? 'General', 1))

  const stayBills: [Admission, Payment][] = []
  /** A stay's bill — the admission charge and the bed for every day started
   *  so far (or up to discharge), linked both ways. */
  const billStay = (patientId: string, extra: Pick<SeedBill, 'collections' | 'failed'> = {}) => {
    const admission = stayOf(patientId)
    const admittedAt = admission.admittedAt ?? admission.createdAt
    const cancelled = admission.status === 'Cancelled'
    const days = cancelled ? 1 : stayDays(admittedAt, admission.dischargedAt ?? now)
    const bill = pushBill({
      patientId,
      items: admissionBillItems(admission.roomType ?? 'General', days),
      createdAt: admittedAt,
      admissionId: admission.admissionId,
      ...extra,
      cancelled: cancelled ? { reason: 'Admission cancelled', at: admission.cancelledAt ?? admittedAt } : undefined,
    })
    stayBills.push([admission, bill])
  }

  for (const admission of admissionSeed.admissions) {
    const where = [admission.wardLabel, admission.bedNumber].filter(Boolean).join(' · ')
    if (admission.admittedAt) logAt(admission.admittedAt, 'Patient admitted', `${admission.admissionNumber} · ${admission.patientName} · ${where}`)
    else logAt(admission.createdAt, 'Admission requested', `${admission.admissionNumber} · ${admission.patientName}`)
    if (admission.dischargedAt) logAt(admission.dischargedAt, 'Patient discharged', `${admission.admissionNumber} · ${admission.patientName}`)
    if (admission.cancelledAt) logAt(admission.cancelledAt, 'Admission cancelled', `${admission.admissionNumber} · ${admission.cancelReason ?? ''}`)
  }

  // Self-pay patients pay the first day when admitted, and the rest as it
  // accrues; insured, TPA and corporate stays are settled at discharge.
  billStay('ISH-0048305')
  billStay('ISH-0069958', {
    collections: [
      { amount: firstDay('ISH-0069958'), method: 'UPI', at: afterAdmission('ISH-0069958', 5) },
      { amount: 10000, method: 'Card', at: afterAdmission('ISH-0069958', 50 * 60) },
    ],
  })
  billStay('ISH-0052719', {
    collections: [
      { amount: firstDay('ISH-0052719'), method: 'UPI', at: afterAdmission('ISH-0052719', 5) },
      { amount: 4000, method: 'Card', at: (stayOf('ISH-0052719').dischargedAt ?? now) - 15 * MINUTE },
    ],
  })
  billStay('ISH-0106392')
  billStay('ISH-0044120', { collections: [{ amount: firstDay('ISH-0044120'), method: 'Card', at: afterAdmission('ISH-0044120', 5) }] })
  billStay('ISH-0125584', { collections: [{ amount: firstDay('ISH-0125584'), method: 'UPI', at: afterAdmission('ISH-0125584', 10) }] })
  billStay('ISH-0125590', { failed: [{ amount: 5000, method: 'UPI', reason: 'Payment not received', at: minutesAgo(45) }] })
  billStay('ISH-0102234')
  // Earlier stays are over and settled in full — by the patient at the counter,
  // or by the insurer, TPA or employer at discharge.
  for (const h of PATIENT_HISTORY) {
    if (!h.stay) continue
    const stay = stayOf(h.uhid)
    const settled = sumItems(admissionBillItems(stay.roomType ?? 'General', stayDays(stay.admittedAt ?? stay.createdAt, stay.dischargedAt ?? now)))
    billStay(h.uhid, { collections: [{ amount: settled, method: stay.paymentType === 'Self Pay' ? 'UPI' : 'Insurance/TPA', at: (stay.dischargedAt ?? now) - 15 * MINUTE }] })
  }
  billStay('ISH-0129901', { collections: [{ amount: firstDay('ISH-0129901'), method: 'UPI', at: afterAdmission('ISH-0129901', 10) }] })

  // Every pass is checked before it is printed. One visitor pass per
  // inpatient, held by the attendant recorded at admission — returned at
  // discharge, one kept two days and now overdue — plus today's visiting
  // doctor and a service engineer, each confirmed with their host.
  const visitorPass = (passNo: number, patientId: string, issuedAt: number, returnedAt: number | null): GuestPass => {
    const stay = stayOf(patientId)
    const ward = stay.wardLabel ?? ''
    const passId = `GP/${ward.toUpperCase()}/${passNo}`
    logAt(issuedAt, 'Guest pass printed', `${passId} · ${stay.attendant.name} · visiting ${patientOf(patientId).name} · confirmed with the patient`)
    if (returnedAt) logAt(returnedAt, 'Guest pass returned', passId)
    return {
      passId,
      type: 'Patient visitor',
      holderName: stay.attendant.name,
      holderMobile: stay.attendant.phone,
      idProof: `Aadhaar ••${String(4100 + passNo * 37).slice(-4)}`,
      patientId,
      patientName: patientOf(patientId).name,
      hostName: null,
      ward,
      relationship: stay.attendant.relationship,
      purpose: 'Attendant for the stay',
      verifiedWith: patientOf(patientId).name,
      issuedBy: 'Meera Iyer',
      validUntil: issuedAt + DAY,
      issuedAt,
      returnedAt,
      returned: returnedAt !== null,
    }
  }
  // Today's other visitors arrive after the day starts, whatever the hour.
  const todayAt = (minutesBack: number) => Math.max(dayStart + 5 * MINUTE, minutesAgo(minutesBack))
  const visitingDoctorAt = todayAt(110)
  const engineerAt = todayAt(45)
  logAt(visitingDoctorAt, 'Guest pass printed', 'GP/VDR/105 · Anand Krishnan · for Dr. Arun Kumar · confirmed with the host')
  logAt(engineerAt, 'Guest pass printed', 'GP/STF/106 · Suresh Babu · for Prakash Natarajan · confirmed with the host')
  const guestPasses: GuestPass[] = [
    visitorPass(101, 'ISH-0052719', afterAdmission('ISH-0052719', 30), stayOf('ISH-0052719').dischargedAt),
    visitorPass(102, 'ISH-0069958', daysAgo(2) - 2 * HOUR, null),
    visitorPass(103, 'ISH-0044120', hoursAgo(5), null),
    visitorPass(104, 'ISH-0125590', hoursAgo(3), null),
    {
      passId: 'GP/VDR/105',
      type: 'Visiting doctor',
      holderName: 'Anand Krishnan',
      holderMobile: '+91 98840 21673',
      idProof: 'Medical council ID ••7731',
      patientId: null,
      patientName: null,
      hostName: 'Dr. Arun Kumar',
      ward: 'Neurology',
      relationship: 'Visiting doctor',
      purpose: 'Joint review of a stroke patient',
      verifiedWith: 'Dr. Arun Kumar',
      issuedBy: 'Meera Iyer',
      validUntil: dayStart + DAY - 1,
      issuedAt: visitingDoctorAt,
      returnedAt: null,
      returned: false,
    },
    {
      passId: 'GP/STF/106',
      type: 'Staff / service',
      holderName: 'Suresh Babu',
      holderMobile: '+91 96290 58114',
      idProof: 'Company ID ••4412',
      patientId: null,
      patientName: null,
      hostName: 'Prakash Natarajan',
      ward: 'Biomedical engineering',
      relationship: 'Vendor',
      purpose: 'Service the MRI chiller',
      verifiedWith: 'Prakash Natarajan',
      issuedBy: 'Meera Iyer',
      validUntil: dayStart + DAY - 1,
      issuedAt: engineerAt,
      returnedAt: null,
      returned: false,
    },
  ]

  // Two road accidents: last night's, acknowledged by the police and
  // discharged; this morning's, acknowledgement still awaited.
  const mlcRecords: MlcRecord[] = [
    {
      mlcId: 'MLC/0001',
      patientId: 'ISH-0125584',
      patientName: patientOf('ISH-0125584').name,
      category: 'Road traffic accident',
      broughtBy: 'Bystander',
      policeStation: 'Gandhipuram Police Station',
      incidentAt: localDateTime(afterAdmission('ISH-0125584', -40)),
      registeredAt: afterAdmission('ISH-0125584', 5),
      intimationSent: true,
      acknowledgedAt: afterAdmission('ISH-0125584', 150),
    },
    {
      mlcId: 'MLC/0002',
      patientId: 'ISH-0129901',
      patientName: patientOf('ISH-0129901').name,
      category: 'Road traffic accident',
      broughtBy: 'Ambulance',
      policeStation: 'Saravanampatti Police Station',
      incidentAt: localDateTime(afterAdmission('ISH-0129901', -35)),
      registeredAt: afterAdmission('ISH-0129901', 5),
      intimationSent: true,
      acknowledgedAt: null,
    },
  ]
  for (const record of mlcRecords) {
    logAt(record.registeredAt, 'MLC registered', `${record.mlcId} · ${record.patientName}`)
    if (record.acknowledgedAt) logAt(record.acknowledgedAt, 'MLC acknowledged', `${record.mlcId} · ${record.policeStation}`)
  }

  // Estimates: a knee X-ray paid at the counter (billed as it was paid), and
  // an ECG + echo quoted after Arjun's cardiology visit, not yet paid.
  const quotedAt = Math.min((visitEnd('ISH-0124106') ?? minutesAgo(30)) + 10 * MINUTE, now - 3 * MINUTE)
  const estimates: Estimate[] = [
    {
      estimateId: 'EST/00001',
      patientId: 'ISH-0116023',
      patientName: patientOf('ISH-0116023').name,
      items: [{ code: 'INV-XR-KNEE', name: 'X-Ray Knee (AP/Lat)', rate: 650, quantity: 1 }],
      total: 650,
      payer: 'Self-pay',
      status: 'Saved',
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2) + 5 * MINUTE,
    },
    {
      estimateId: 'EST/00002',
      patientId: 'ISH-0124106',
      patientName: patientOf('ISH-0124106').name,
      items: [
        { code: 'INV-ECG', name: 'ECG', rate: 350, quantity: 1 },
        { code: 'INV-ECHO', name: '2D Echocardiogram', rate: 2400, quantity: 1 },
      ],
      total: 2750,
      payer: 'Self-pay',
      status: 'Saved',
      createdAt: quotedAt,
      updatedAt: quotedAt + 2 * MINUTE,
    },
  ]
  pushBill({
    patientId: 'ISH-0116023',
    items: [{ code: 'INV-XR-KNEE', description: 'X-Ray Knee (AP/Lat)', amount: 650 }],
    createdAt: daysAgo(2) + 12 * MINUTE,
    estimateId: 'EST/00001',
    collections: [{ amount: 650, method: 'UPI', at: daysAgo(2) + 13 * MINUTE }],
  })
  for (const estimate of estimates) logAt(estimate.updatedAt, 'Estimate saved', `${estimate.estimateId} · ${estimate.patientName} · ${formatRupees(estimate.total)}`)

  // Receipts, transactions and failed attempts are numbered in the order
  // they happened, as the desk numbers them.
  payments.sort((a, b) => a.createdAt - b.createdAt)
  payments.forEach((bill, index) => {
    const seq = 101 + index
    bill.paymentId = `pay-${seq}`
    bill.receiptNo = `RCT-${String(seq).padStart(6, '0')}`
    if (bill.refund) bill.refund.refundId = `RFD-${bill.receiptNo.replace('RCT-', '')}`
  })
  const transactions = payments.flatMap((bill) => bill.transactions).sort((a, b) => a.collectedAt - b.collectedAt)
  transactions.forEach((txn, index) => {
    txn.transactionId = `TXN-${String(101 + index).padStart(6, '0')}`
  })
  const attempts = payments.flatMap((bill) => bill.failedAttempts).sort((a, b) => a.attemptedAt - b.attemptedAt)
  attempts.forEach((attempt, index) => {
    attempt.attemptId = `ATT-${String(index + 1).padStart(6, '0')}`
  })
  for (const [admission, bill] of stayBills) admission.paymentId = bill.paymentId
  for (const [entry, bill] of differenceBills) entry.differencePaymentId = bill.paymentId

  const registrationLog: RegistrationLogEntry[] = patients
    .filter((p) => p.createdAt >= dayStart)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((p) => ({ patientId: p.patientId, registeredAt: p.createdAt }))
  for (const entry of registrationLog) logAt(entry.registeredAt, 'New patient registered', `${patientOf(entry.patientId).name} · ${entry.patientId}`)

  activityLog.sort((a, b) => a.time - b.time)
  activityLog.forEach((entry, index) => {
    entry.id = `act-${index + 1}`
  })

  // Profiles the desk opens most often — seeds the search box's "Most opened".
  const patientOpens: AppState['patientOpens'] = {
    'ISH-0091133': { count: 7, lastOpenedAt: minutesAgo(30) },
    'ISH-0125590': { count: 6, lastOpenedAt: minutesAgo(50) },
    'ISH-0044120': { count: 5, lastOpenedAt: hoursAgo(2) },
    'ISH-0069958': { count: 4, lastOpenedAt: hoursAgo(5) },
    'ISH-0078812': { count: 3, lastOpenedAt: daysAgo(1) },
  }

  // Rate card for the enquiry/estimate desk. A real deployment reads this
  // from the hospital's tariff master; the rates themselves are never
  // calculated or guessed here. Consultations match what the department's
  // doctors charge — a small fee (₹150–₹300), the only charge a visit has.
  const tariffs: Tariff[] = [
    { code: 'CONS-GEN', name: 'General Medicine consultation', department: 'General Medicine', rate: 200 },
    { code: 'CONS-NEU', name: 'Neurology consultation', department: 'Neurology', rate: 250 },
    { code: 'CONS-CAR', name: 'Cardiology consultation', department: 'Cardiology', rate: 250 },
    { code: 'CONS-ORT', name: 'Orthopedics consultation', department: 'Orthopedics', rate: 200 },
    { code: 'CONS-NSG', name: 'Neurosurgery consultation', department: 'Neurosurgery', rate: 300 },
    { code: 'CONS-EMG', name: 'Emergency medicine consultation', department: 'Emergency', rate: 200 },
    { code: 'INV-ECG', name: 'ECG', department: 'Cardiology', rate: 350 },
    { code: 'INV-ECHO', name: '2D Echocardiogram', department: 'Cardiology', rate: 2400 },
    { code: 'INV-MRI-B', name: 'MRI Brain (plain)', department: 'Neurology', rate: 7500 },
    { code: 'INV-CT-B', name: 'CT Brain (plain)', department: 'Neurology', rate: 3200 },
    { code: 'INV-XR-KNEE', name: 'X-Ray Knee (AP/Lat)', department: 'Orthopedics', rate: 650 },
    { code: 'LAB-CBC', name: 'Complete Blood Count', department: 'General Medicine', rate: 400 },
    { code: 'LAB-HBA1C', name: 'HbA1c', department: 'General Medicine', rate: 550 },
    { code: 'PKG-MASTER-M', name: 'Master Health Checkup (Male)', department: 'General Medicine', rate: 6500 },
  ]

  return {
    today,
    patients,
    providers,
    leaves,
    appointments,
    visits,
    queueTokens,
    guestPasses,
    estimates,
    mlcRecords,
    tariffs,
    payments,
    beds: admissionSeed.beds,
    admissions: admissionSeed.admissions,
    registrationLog,
    patientOpens,
    activityLog,
    // Explicitly labelled DEVELOPMENT infrastructure state — there is no real
    // service to connect to, and the UI says so rather than implying one.
    connectivity: { mode: 'development', network: 'online', abha: 'unavailable' },
    tokenCounters,
    nextIds: {
      appointment: appointmentSeq,
      visit: visits.length + 1,
      token: queueTokens.length + 1,
      activity: activityLog.length + 1,
      patient: 1,
      provider: 1,
      leave: 2,
      pass: 101 + guestPasses.length,
      estimate: estimates.length + 1,
      mlc: mlcRecords.length + 1,
      payment: 101 + payments.length,
      transaction: 101 + transactions.length,
      attempt: attempts.length + 1,
      ...admissionSeed.nextIds,
    },
  }
}

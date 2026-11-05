// DEVELOPMENT SEED DATA — NOT A BACKEND. Same convention as the other
// domain seed files: timestamps generated relative to app start.
import type { Admission, AdmissionStatus, Bed, DischargeType } from '../types/admission'
import type { NextIds } from '../types/store'

const MINUTE = 60000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export interface AdmissionSeed {
  beds: Bed[]
  admissions: Admission[]
  nextIds: Pick<NextIds, 'admission'>
}

/** Names come from the patient and doctor records, so an admission can never
 *  disagree with them; a request made in clinic follows that visit. */
export interface AdmissionSeedContext {
  patientName: (patientId: string) => string
  doctor: (providerId: string) => { name: string; department: string }
  /** When the patient's latest finished outpatient visit ended. */
  visitEnd: (patientId: string) => number | null
  /** Earlier stays already over — numbered after the current ones, so their admission numbers don't move. */
  historicStays?: StaySeed[]
}

export type StaySeed = Pick<Admission, 'patientId' | 'doctorId' | 'admissionType' | 'reason' | 'referralSource' | 'attendant' | 'paymentType'> & {
  status: AdmissionStatus
  bedId?: string
  insuranceProvider?: string
  policyNumber?: string
  /** When the request was made — for a stay still waiting for a bed. */
  requestedAt?: number
  admittedAt?: number
  dischargedAt?: number
  dischargeType?: DischargeType
  dischargeRemarks?: string
  cancelledAt?: number
  cancelReason?: string
}

export function createAdmissionSeed(now: number, context: AdmissionSeedContext): AdmissionSeed {
  const minutesAgo = (minutes: number) => now - minutes * MINUTE
  const hoursAgo = (hours: number) => now - hours * HOUR
  const daysAgo = (days: number) => now - days * DAY

  // Every bed starts free; who is in which bed is derived from the stays below.
  const bed = (bedId: string, bedNumber: string, ward: Bed['ward'], roomType: Bed['roomType'], status: Bed['status'] = 'Available'): Bed => ({
    bedId,
    bedNumber,
    roomNumber: bedNumber.replace(/-B$/, ''),
    ward,
    roomType,
    status,
    currentAdmissionId: null,
  })
  const beds: Bed[] = [
    bed('bed-1', 'G-101-B', 'General Ward', 'General'),
    bed('bed-2', 'G-102-B', 'General Ward', 'General'),
    bed('bed-3', 'G-103-B', 'General Ward', 'General'),
    bed('bed-4', 'G-104-B', 'General Ward', 'General'),
    bed('bed-5', 'G-105-B', 'General Ward', 'General', 'Maintenance'),
    bed('bed-6', 'P-201-B', 'Private Ward', 'Private'),
    bed('bed-7', 'P-202-B', 'Private Ward', 'Private'),
    bed('bed-8', 'SP-301-B', 'Semi-Private Ward', 'Semi-Private'),
    bed('bed-9', 'SP-302-B', 'Semi-Private Ward', 'Semi-Private'),
    bed('bed-10', 'ICU-01-B', 'ICU', 'ICU'),
    bed('bed-11', 'ICU-02-B', 'ICU', 'ICU'),
    bed('bed-12', 'ER-01-B', 'Emergency', 'General'),
    bed('bed-13', 'ER-02-B', 'Emergency', 'General'),
    bed('bed-14', 'G-106-B', 'General Ward', 'General'),
    bed('bed-15', 'G-107-B', 'General Ward', 'General'),
    bed('bed-16', 'G-108-B', 'General Ward', 'General'),
    bed('bed-17', 'P-203-B', 'Private Ward', 'Private'),
    bed('bed-18', 'P-204-B', 'Private Ward', 'Private'),
    bed('bed-19', 'SP-303-B', 'Semi-Private Ward', 'Semi-Private'),
    bed('bed-20', 'SP-304-B', 'Semi-Private Ward', 'Semi-Private'),
    bed('bed-21', 'ICU-03-B', 'ICU', 'ICU'),
    bed('bed-22', 'ICU-04-B', 'ICU', 'ICU'),
    bed('bed-23', 'ER-03-B', 'Emergency', 'General'),
  ]

  const attendant = (name: string, relationship: Admission['attendant']['relationship'], phone: string): Admission['attendant'] => ({
    name,
    relationship,
    phone,
    address: null,
  })

  const stays: StaySeed[] = [
    // Admitted after a clinic visit, then declined within the hour — the
    // unpaid bill went with it.
    {
      patientId: 'ISH-0048305', doctorId: 'dr-vikram-das', admissionType: 'Elective',
      reason: 'Diabetic foot ulcer — wound care', referralSource: 'Outpatient',
      attendant: attendant('Mary Thomas', 'Spouse', '+91 94473 50128'),
      paymentType: 'Insurance', insuranceProvider: 'New India Assurance', policyNumber: 'NIA-7720915',
      status: 'Cancelled', bedId: 'bed-19', admittedAt: daysAgo(6), cancelledAt: daysAgo(6) + 40 * MINUTE,
      cancelReason: 'Patient declined admission — chose outpatient care',
    },
    // Day 5 after an angioplasty; two deposits paid, the rest still due.
    {
      patientId: 'ISH-0069958', doctorId: 'dr-priya-nair', admissionType: 'Elective',
      reason: 'Coronary angioplasty — post-procedure care', referralSource: 'Outpatient',
      attendant: attendant('Salim Rahman', 'Son', '+91 98422 70316'),
      paymentType: 'Self Pay', status: 'Admitted', bedId: 'bed-6', admittedAt: daysAgo(4) - 2 * HOUR,
    },
    // Three days for gastroenteritis; discharged yesterday, bill settled.
    {
      patientId: 'ISH-0052719', doctorId: 'dr-rahul-menon', admissionType: 'Emergency',
      reason: 'Acute gastroenteritis with dehydration', referralSource: 'Outpatient',
      attendant: attendant('Kannan', 'Son', '+91 98425 66019'),
      paymentType: 'Self Pay', status: 'Discharged', bedId: 'bed-1',
      admittedAt: daysAgo(4) - HOUR, dischargedAt: daysAgo(1) - 3 * HOUR,
      dischargeType: 'Normal Discharge', dischargeRemarks: 'Recovered — review in the outpatient clinic in a week',
    },
    // Day 3, billed to the employer.
    {
      patientId: 'ISH-0106392', doctorId: 'dr-vikram-das', admissionType: 'Elective',
      reason: 'Uncontrolled diabetes — insulin titration', referralSource: 'Outpatient',
      attendant: attendant('Revathi Murugan', 'Daughter', '+91 98940 31877'),
      paymentType: 'Corporate', insuranceProvider: 'Larsen & Toubro', policyNumber: 'LT-EMP-20417',
      status: 'Admitted', bedId: 'bed-8', admittedAt: daysAgo(2) - 3 * HOUR,
    },
    // Day 2: the first day paid at admission, today's bed charge due.
    {
      patientId: 'ISH-0044120', doctorId: 'dr-arun-kumar', admissionType: 'Elective',
      reason: 'Recurrent giddiness — observation and MRI brain', referralSource: 'Outpatient',
      attendant: attendant('Vikram Babu', 'Son', '+91 98430 55112'),
      paymentType: 'Self Pay', status: 'Admitted', bedId: 'bed-2', admittedAt: hoursAgo(26),
    },
    // Planned knee replacement, waiting for a bed.
    {
      patientId: 'ISH-0122871', doctorId: 'dr-meera-shah', admissionType: 'Elective',
      reason: 'Planned right total knee replacement', referralSource: 'Outpatient',
      attendant: attendant('Balaji Raman', 'Spouse', '+91 99438 12056'),
      paymentType: 'TPA', insuranceProvider: 'Vidal Health TPA', policyNumber: 'VH-5510234',
      status: 'Pending', requestedAt: hoursAgo(26) + 30 * MINUTE,
    },
    // Road accident, observed overnight in Emergency and discharged this morning.
    {
      patientId: 'ISH-0125584', doctorId: 'dr-rahul-menon', admissionType: 'Emergency',
      reason: 'Road traffic accident — minor injuries, observation', referralSource: 'Emergency',
      attendant: attendant('Lalitha Chandra', 'Mother', '+91 96007 18234'),
      paymentType: 'Self Pay', status: 'Discharged', bedId: 'bed-23',
      admittedAt: hoursAgo(22) - 30 * MINUTE, dischargedAt: hoursAgo(3),
      dischargeType: 'Normal Discharge', dischargeRemarks: 'Stable — police statement recorded',
    },
    // Transferred in after surgery elsewhere; the TPA settles at discharge.
    {
      patientId: 'ISH-0125590', doctorId: 'dr-rahul-menon', admissionType: 'Emergency',
      reason: 'Post-operative monitoring — transferred from another hospital', referralSource: 'Transfer',
      attendant: attendant('Lakshmi Subramanian', 'Spouse', '+91 94440 66232'),
      paymentType: 'TPA', insuranceProvider: 'MediAssist TPA', policyNumber: 'MA-2231987',
      status: 'Admitted', bedId: 'bed-10', admittedAt: hoursAgo(20),
    },
    // Chest pain this morning; the insurer settles at discharge.
    {
      patientId: 'ISH-0102234', doctorId: 'dr-priya-nair', admissionType: 'Emergency',
      reason: 'Chest pain — cardiac workup', referralSource: 'Emergency',
      attendant: attendant('Rajesh Menon', 'Spouse', '+91 99000 44311'),
      paymentType: 'Insurance', insuranceProvider: 'Star Health', policyNumber: 'SH-88213340',
      status: 'Admitted', bedId: 'bed-7', admittedAt: hoursAgo(3),
    },
    // Road accident brought in by ambulance — a medico-legal case.
    {
      patientId: 'ISH-0129901', doctorId: 'dr-rahul-menon', admissionType: 'Emergency',
      reason: 'Road traffic accident — head injury, under observation', referralSource: 'Emergency',
      attendant: attendant('Suresh Raj', 'Brother', '+91 97890 22145'),
      paymentType: 'Self Pay', status: 'Admitted', bedId: 'bed-12', admittedAt: minutesAgo(140),
    },
    // Seen by Dr. Arun Kumar; admission advised at that visit, bed awaited.
    {
      patientId: 'ISH-0111045', doctorId: 'dr-arun-kumar', admissionType: 'Elective',
      reason: 'Lumbar disc prolapse — pain management', referralSource: 'Outpatient',
      attendant: attendant('Ayesha Irfan', 'Spouse', '+91 90031 77813'),
      paymentType: 'Self Pay', status: 'Pending',
      requestedAt: Math.min((context.visitEnd('ISH-0111045') ?? minutesAgo(65)) + 15 * MINUTE, minutesAgo(1)),
    },
  ]

  // Numbered in the order they were made, as the admissions desk numbers them.
  const byTime = (a: StaySeed, b: StaySeed) => (a.requestedAt ?? a.admittedAt ?? 0) - (b.requestedAt ?? b.admittedAt ?? 0)
  const ordered = [...[...stays].sort(byTime), ...[...(context.historicStays ?? [])].sort(byTime)]
  const admissions: Admission[] = ordered.map((stay, index) => {
    const seq = index + 1
    const createdAt = stay.requestedAt ?? stay.admittedAt ?? now
    const allotted = stay.bedId ? beds.find((b) => b.bedId === stay.bedId) ?? null : null
    const doctor = context.doctor(stay.doctorId)
    const closedAt = stay.dischargedAt ?? stay.cancelledAt ?? stay.admittedAt ?? createdAt
    return {
      admissionId: `adm-${seq}`,
      admissionNumber: `ADM-${new Date(createdAt).getFullYear()}-${String(seq).padStart(5, '0')}`,
      patientId: stay.patientId,
      patientName: context.patientName(stay.patientId),
      doctorId: stay.doctorId,
      doctorName: doctor.name,
      department: doctor.department,
      admissionType: stay.admissionType,
      reason: stay.reason,
      referralSource: stay.referralSource,
      bedId: allotted?.bedId ?? null,
      wardLabel: allotted?.ward ?? null,
      roomNumber: allotted?.roomNumber ?? null,
      bedNumber: allotted?.bedNumber ?? null,
      roomType: allotted?.roomType ?? null,
      attendant: stay.attendant,
      paymentType: stay.paymentType,
      insuranceProvider: stay.insuranceProvider ?? null,
      policyNumber: stay.policyNumber ?? null,
      paymentId: null,
      status: stay.status,
      admittedAt: stay.admittedAt ?? null,
      dischargedAt: stay.dischargedAt ?? null,
      dischargeType: stay.dischargeType ?? null,
      dischargeRemarks: stay.dischargeRemarks ?? null,
      cancelledAt: stay.cancelledAt ?? null,
      cancelReason: stay.cancelReason ?? null,
      createdAt,
      updatedAt: closedAt,
    }
  })

  for (const admission of admissions) {
    if (admission.status !== 'Admitted' || !admission.bedId) continue
    const occupied = beds.find((b) => b.bedId === admission.bedId)!
    occupied.status = 'Occupied'
    occupied.currentAdmissionId = admission.admissionId
  }

  return {
    beds,
    admissions,
    nextIds: { admission: admissions.length + 1 },
  }
}

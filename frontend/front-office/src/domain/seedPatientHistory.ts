// DEVELOPMENT SEED DATA — NOT A BACKEND. Fictional patients with a longitudinal
// record, so Search Patient and the patient profile have real histories to
// show: old visits (2022 onward), recent visits, and today's visit. Everything
// here is fed to the same builders as the original seed (patients, book(),
// the admission seed, bills) — no second data structure, no second timeline.
//
// A date is either an ISO day ('2023-03-21', fixed in the past) or a number of
// days ago (recent visits, which stay recent whenever the app is opened).
import type { AdmissionType, DischargeType, ReferralSource, AttendantRelationship, PaymentType } from '../types/admission'
import type { Sex } from '../types/patient'

export interface HistoryVisit {
  on: string | number
  doctor: string
  reason: string
  /** Completed unless said otherwise. Incomplete is a registered visit that was never completed (and not cancelled). */
  status?: 'Completed' | 'Cancelled' | 'Incomplete'
}

export interface TodayVisit {
  doctor: string
  reason: string
  /** Slots from the doctor's next one; negative = already past. */
  offset: number
  status: 'Completed' | 'Checked-in' | 'Confirmed' | 'Cancelled'
  /** Checked in and still here: Waiting (default) or Called. */
  token?: 'Waiting' | 'Called'
  arrivedMinutesAgo?: number
}

export interface HistoryStay {
  doctor: string
  type: AdmissionType
  reason: string
  referral: ReferralSource
  attendant: { name: string; relationship: AttendantRelationship; phone: string }
  payment: PaymentType
  insurer?: string
  policy?: string
  bedId: string
  admittedOn: string
  days: number
  dischargeType?: DischargeType
  remarks: string
}

export interface PatientHistorySeed {
  uhid: string
  name: string
  nameNative?: string
  age: number
  sex: Sex
  email?: string
  abhaId?: string
  /** An ISO day, a number of days ago, or minutes before the app opened (today's new patients). */
  registered: string | number | { minutesAgo: number }
  visits: HistoryVisit[]
  today?: TodayVisit
  stay?: HistoryStay
}

const streets = [
  'Avinashi Road, Peelamedu', 'Sathy Road, Saravanampatti', 'Trichy Road, Singanallur', 'Mettupalayam Road, Thudiyalur', 'Race Course Road, Coimbatore',
  'Cross Cut Road, Gandhipuram', 'Bharathi Park Road, Saibaba Colony', 'Thadagam Road, Vadavalli', 'Pollachi Road, Podanur', 'Oppanakara Street, Town Hall',
  'DB Road, R.S. Puram', 'Kamarajar Road, Ganapathy',
]

/** A phone number and address that are the same every time the app starts. */
export function contactFor(index: number): { mobile: string; address: string } {
  const prefix = [4, 6, 7, 8, 9][index % 5]
  return {
    mobile: `+91 9${prefix}${String(100 + ((index * 53) % 900))} ${String(20000 + index * 1873)}`,
    address: `${3 + ((index * 7) % 90)} ${streets[index % streets.length]}, Coimbatore 6410${String(1 + (index % 48)).padStart(2, '0')}`,
  }
}

const NEU = { arun: 'dr-arun-kumar', ananya: 'dr-ananya-rao', sanjay: 'dr-sanjay-iyer' }
const CAR = { priya: 'dr-priya-nair', revathi: 'dr-revathi-reddy', harish: 'dr-harish-menon' }
const GEN = { rahul: 'dr-rahul-menon', vikram: 'dr-vikram-das', farah: 'dr-farah-ahmed' }
const ORT = { meera: 'dr-meera-shah', ashwin: 'dr-ashwin-kamath', nandini: 'dr-nandini-hegde' }
const NSG = { raj: 'dr-raj-srinivas', suresh: 'dr-suresh-pillai', divya: 'dr-divya-raghavan' }
const EMG = { logesh: 'dr-logesh', arvind: 'dr-arvind-shetty', swetha: 'dr-swetha-venkat' }

export const PATIENT_HISTORY: PatientHistorySeed[] = [
  // ------------------------------------------------ long history, here today
  {
    uhid: 'ISH-0031042', name: 'Gopinath Rangasamy', nameNative: 'கோபிநாத் ரங்கசாமி', age: 67, sex: 'Male', abhaId: 'gopinath.r@abdm', registered: '2022-02-08',
    visits: [
      { on: '2022-02-08', doctor: GEN.rahul, reason: 'Fever and body ache' },
      { on: '2022-09-14', doctor: GEN.vikram, reason: 'Diabetes screening', status: 'Incomplete' },
      { on: '2023-03-21', doctor: GEN.vikram, reason: 'Diabetes review — HbA1c' },
      { on: '2023-11-07', doctor: CAR.harish, reason: 'Chest discomfort on exertion' },
      { on: '2024-06-18', doctor: CAR.harish, reason: 'Cardiac follow-up — echo review' },
      { on: '2025-04-09', doctor: GEN.vikram, reason: 'Diabetes review', status: 'Cancelled' },
      { on: '2025-12-02', doctor: CAR.harish, reason: 'Cardiac follow-up' },
      { on: -34, doctor: GEN.vikram, reason: 'Sugar review' },
    ],
    today: { doctor: CAR.harish, reason: 'Breathlessness on climbing stairs', offset: -2, status: 'Checked-in', token: 'Waiting', arrivedMinutesAgo: 35 },
  },
  {
    uhid: 'ISH-0031187', name: 'Rukmani Venkatesan', nameNative: 'ருக்மணி வெங்கடேசன்', age: 61, sex: 'Female', registered: '2022-05-17',
    visits: [
      { on: '2022-05-17', doctor: ORT.meera, reason: 'Right knee pain' },
      { on: '2022-11-29', doctor: ORT.meera, reason: 'Knee pain — X-ray review' },
      { on: '2023-08-03', doctor: ORT.ashwin, reason: 'Physiotherapy advice', status: 'Incomplete' },
      { on: '2024-02-20', doctor: GEN.rahul, reason: 'Hypertension check' },
      { on: '2025-01-15', doctor: CAR.revathi, reason: 'Palpitations' },
      { on: '2026-03-11', doctor: CAR.revathi, reason: 'Palpitations — Holter review' },
      { on: -48, doctor: GEN.farah, reason: 'Blood pressure review' },
    ],
    today: { doctor: CAR.revathi, reason: 'Follow-up — ECG', offset: -1, status: 'Checked-in', token: 'Called', arrivedMinutesAgo: 22 },
  },
  {
    uhid: 'ISH-0031356', name: 'Chandrasekar Pillai', nameNative: 'சந்திரசேகர் பிள்ளை', age: 72, sex: 'Male', registered: '2022-07-25',
    visits: [
      { on: '2022-07-25', doctor: NEU.arun, reason: 'Tremor in right hand' },
      { on: '2023-01-12', doctor: NEU.arun, reason: 'Tremor — medication review' },
      { on: '2023-09-26', doctor: NEU.sanjay, reason: 'Movement disorder assessment' },
      { on: '2024-05-14', doctor: NEU.sanjay, reason: 'Movement disorder follow-up', status: 'Cancelled' },
      { on: '2025-02-04', doctor: NEU.sanjay, reason: 'Medication adjustment' },
      { on: '2025-10-21', doctor: NEU.sanjay, reason: 'Six-monthly review' },
      { on: -62, doctor: NEU.sanjay, reason: 'Six-monthly review' },
    ],
    today: { doctor: NEU.sanjay, reason: 'Review with reports', offset: -3, status: 'Completed' },
  },
  {
    uhid: 'ISH-0031521', name: 'Padma Lakshmi', nameNative: 'பத்மா லட்சுமி', age: 58, sex: 'Female', email: 'padma.l@example.com', registered: '2022-10-03',
    visits: [
      { on: '2022-10-03', doctor: GEN.farah, reason: 'Persistent cough' },
      { on: '2023-04-18', doctor: GEN.rahul, reason: 'Thyroid review' },
      { on: '2023-12-05', doctor: ORT.nandini, reason: 'Lower back pain' },
      { on: '2024-07-23', doctor: ORT.nandini, reason: 'Back pain — MRI review' },
      { on: '2025-05-13', doctor: NSG.suresh, reason: 'Disc bulge — surgical opinion' },
      { on: '2026-01-27', doctor: NSG.suresh, reason: 'Spine follow-up' },
    ],
    today: { doctor: NSG.suresh, reason: 'Spine follow-up — MRI', offset: 2, status: 'Confirmed' },
  },
  {
    uhid: 'ISH-0031684', name: 'Muthu Krishnan', nameNative: 'முத்து கிருஷ்ணன்', age: 54, sex: 'Male', registered: '2023-01-09',
    visits: [
      { on: '2023-01-09', doctor: CAR.priya, reason: 'Chest pain' },
      { on: '2023-01-30', doctor: CAR.priya, reason: 'Stress test review' },
      { on: '2023-07-11', doctor: CAR.priya, reason: 'Cardiac follow-up' },
      { on: '2024-01-16', doctor: CAR.harish, reason: 'Lipid review', status: 'Incomplete' },
      { on: '2024-09-03', doctor: CAR.harish, reason: 'Cardiac follow-up' },
      { on: '2025-06-10', doctor: CAR.harish, reason: 'Annual cardiac review' },
      { on: -90, doctor: CAR.harish, reason: 'Cardiac follow-up' },
      { on: -21, doctor: CAR.priya, reason: 'Dizziness on standing' },
    ],
    today: { doctor: CAR.revathi, reason: 'Palpitations — second opinion', offset: -4, status: 'Checked-in', token: 'Waiting', arrivedMinutesAgo: 48 },
  },
  {
    uhid: 'ISH-0031790', name: 'Shanthi Subramaniam', nameNative: 'சாந்தி சுப்ரமணியம்', age: 49, sex: 'Female', registered: '2023-03-14',
    visits: [
      { on: '2023-03-14', doctor: NEU.ananya, reason: 'Recurrent headache' },
      { on: '2023-06-27', doctor: NEU.ananya, reason: 'Migraine — preventive treatment' },
      { on: '2023-12-19', doctor: NEU.ananya, reason: 'Migraine review', status: 'Cancelled' },
      { on: '2024-08-06', doctor: NEU.arun, reason: 'Migraine review' },
      { on: '2025-03-25', doctor: NEU.arun, reason: 'Headache diary review' },
      { on: -140, doctor: NEU.arun, reason: 'Migraine review' },
      { on: -41, doctor: NEU.ananya, reason: 'Giddiness', status: 'Incomplete' },
    ],
    today: { doctor: NEU.ananya, reason: 'Giddiness — review', offset: 3, status: 'Confirmed' },
  },
  {
    uhid: 'ISH-0031902', name: 'Ibrahim Khalil', nameNative: 'ابراہیم خلیل', age: 63, sex: 'Male', registered: '2022-04-19',
    visits: [
      { on: '2022-04-19', doctor: GEN.vikram, reason: 'Excessive thirst — sugar check' },
      { on: '2022-08-30', doctor: GEN.vikram, reason: 'Diabetes — insulin started' },
      { on: '2023-02-14', doctor: GEN.vikram, reason: 'Diabetes review' },
      { on: '2023-10-24', doctor: GEN.farah, reason: 'Foot care advice' },
      { on: '2024-05-07', doctor: GEN.vikram, reason: 'Diabetes review', status: 'Incomplete' },
      { on: '2025-02-18', doctor: GEN.vikram, reason: 'Diabetes review — kidney profile' },
      { on: '2025-11-11', doctor: ORT.ashwin, reason: 'Heel pain' },
      { on: -73, doctor: GEN.farah, reason: 'Sugar review', status: 'Cancelled' },
    ],
    today: { doctor: GEN.farah, reason: 'Sugar review', offset: -5, status: 'Checked-in', token: 'Waiting', arrivedMinutesAgo: 25 },
  },
  {
    uhid: 'ISH-0032015', name: 'Vasantha Kumari', nameNative: 'வசந்தா குமாரி', age: 66, sex: 'Female', abhaId: '62-1180-4457-2093', registered: '2022-12-06',
    visits: [
      { on: '2022-12-06', doctor: CAR.priya, reason: 'Breathlessness' },
      { on: '2023-05-23', doctor: CAR.priya, reason: 'Echo review' },
      { on: '2023-11-14', doctor: CAR.harish, reason: 'Heart failure follow-up' },
      { on: '2024-06-04', doctor: CAR.harish, reason: 'Heart failure follow-up', status: 'Incomplete' },
      { on: '2025-01-28', doctor: CAR.harish, reason: 'Heart failure follow-up' },
      { on: '2025-09-30', doctor: CAR.harish, reason: 'Cardiac review' },
      { on: -19, doctor: CAR.harish, reason: 'Swelling in both legs' },
    ],
    today: { doctor: CAR.harish, reason: 'Swelling in legs — review', offset: 1, status: 'Cancelled' },
  },

  // -------------------------------- many visits over the years, none today
  {
    uhid: 'ISH-0032240', name: 'Dhanapal Ramasamy', nameNative: 'தனபால் ராமசாமி', age: 69, sex: 'Male', registered: '2022-01-24',
    visits: [
      { on: '2022-01-24', doctor: GEN.rahul, reason: 'Fatigue and weight loss' },
      { on: '2022-03-08', doctor: GEN.rahul, reason: 'Blood reports review' },
      { on: '2022-08-16', doctor: GEN.vikram, reason: 'Diabetes diagnosis' },
      { on: '2023-02-07', doctor: GEN.vikram, reason: 'Diabetes review' },
      { on: '2023-09-12', doctor: GEN.vikram, reason: 'Diabetes review', status: 'Incomplete' },
      { on: '2024-03-26', doctor: CAR.harish, reason: 'Chest tightness' },
      { on: '2024-10-15', doctor: CAR.harish, reason: 'Cardiac follow-up' },
      { on: '2025-06-24', doctor: GEN.vikram, reason: 'Diabetes review' },
      { on: '2026-02-17', doctor: GEN.vikram, reason: 'Diabetes review', status: 'Cancelled' },
      { on: -112, doctor: GEN.farah, reason: 'Cold and cough' },
    ],
  },
  {
    uhid: 'ISH-0032377', name: 'Amudha Selvaraj', nameNative: 'அமுதா செல்வராஜ்', age: 57, sex: 'Female', registered: '2022-06-13',
    visits: [
      { on: '2022-06-13', doctor: ORT.meera, reason: 'Shoulder pain' },
      { on: '2022-07-04', doctor: ORT.meera, reason: 'Shoulder — physiotherapy plan' },
      { on: '2022-12-20', doctor: ORT.ashwin, reason: 'Frozen shoulder review' },
      { on: '2023-07-18', doctor: ORT.ashwin, reason: 'Knee pain' },
      { on: '2024-04-02', doctor: ORT.nandini, reason: 'Neck pain', status: 'Cancelled' },
      { on: '2024-12-10', doctor: ORT.nandini, reason: 'Cervical spondylosis review' },
      { on: '2025-08-19', doctor: NEU.arun, reason: 'Tingling in fingers' },
      { on: -150, doctor: NEU.arun, reason: 'Nerve conduction review' },
    ],
  },
  {
    uhid: 'ISH-0032498', name: 'Balasubramanian Iyer', nameNative: 'பாலசுப்பிரமணியன் ஐயர்', age: 74, sex: 'Male', registered: '2022-03-02',
    visits: [
      { on: '2022-03-02', doctor: NEU.arun, reason: 'Memory lapses' },
      { on: '2022-09-20', doctor: NEU.arun, reason: 'Memory assessment' },
      { on: '2023-04-11', doctor: NEU.sanjay, reason: 'Cognitive follow-up' },
      { on: '2023-12-12', doctor: NEU.sanjay, reason: 'Cognitive follow-up' },
      { on: '2024-08-27', doctor: NEU.sanjay, reason: 'Cognitive follow-up', status: 'Incomplete' },
      { on: '2025-05-06', doctor: NEU.sanjay, reason: 'Medication review' },
      { on: '2026-01-13', doctor: NEU.sanjay, reason: 'Six-monthly review' },
      { on: -84, doctor: NEU.sanjay, reason: 'Six-monthly review' },
    ],
  },
  {
    uhid: 'ISH-0032611', name: 'Nirmala Devi', nameNative: 'நிர்மலா தேவி', age: 52, sex: 'Female', registered: '2023-05-30',
    visits: [
      { on: '2023-05-30', doctor: GEN.farah, reason: 'Thyroid symptoms' },
      { on: '2023-08-22', doctor: GEN.farah, reason: 'Thyroid review' },
      { on: '2024-02-13', doctor: GEN.rahul, reason: 'Thyroid review', status: 'Incomplete' },
      { on: '2024-09-17', doctor: GEN.rahul, reason: 'Thyroid review' },
      { on: '2025-04-29', doctor: GEN.rahul, reason: 'Annual health check' },
      { on: -96, doctor: GEN.farah, reason: 'Thyroid review' },
    ],
  },
  {
    uhid: 'ISH-0032729', name: 'Kannan Ramalingam', nameNative: 'கண்ணன் ராமலிங்கம்', age: 60, sex: 'Male', registered: '2024-02-05',
    visits: [
      { on: '2024-02-05', doctor: CAR.priya, reason: 'Hypertension' },
      { on: '2024-05-21', doctor: CAR.priya, reason: 'Blood pressure review' },
      { on: '2024-11-12', doctor: CAR.revathi, reason: 'Palpitations' },
      { on: '2025-07-01', doctor: CAR.revathi, reason: 'Cardiac follow-up', status: 'Cancelled' },
      { on: -57, doctor: CAR.revathi, reason: 'Cardiac follow-up' },
    ],
  },
  {
    uhid: 'ISH-0032843', name: 'Fathima Beevi', nameNative: 'فاطمہ بی بی', age: 45, sex: 'Female', registered: '2023-09-18',
    visits: [
      { on: '2023-09-18', doctor: GEN.farah, reason: 'Fever and joint pain' },
      { on: '2024-03-12', doctor: ORT.meera, reason: 'Joint pain' },
      { on: '2024-12-03', doctor: ORT.ashwin, reason: 'Knee pain', status: 'Incomplete' },
      { on: '2025-09-09', doctor: ORT.ashwin, reason: 'Knee — physiotherapy review' },
      { on: -28, doctor: ORT.ashwin, reason: 'Knee pain follow-up' },
    ],
  },
  {
    uhid: 'ISH-0032956', name: 'Sundaram Narayanan', nameNative: 'சுந்தரம் நாராயணன்', age: 70, sex: 'Male', registered: '2022-08-09',
    visits: [
      { on: '2022-08-09', doctor: NSG.raj, reason: 'Back pain with leg numbness' },
      { on: '2022-09-06', doctor: NSG.raj, reason: 'MRI spine review' },
      { on: '2023-03-28', doctor: NSG.suresh, reason: 'Surgical opinion — lumbar canal stenosis' },
      { on: '2023-10-10', doctor: NSG.suresh, reason: 'Post-operative follow-up' },
      { on: '2024-04-23', doctor: NSG.suresh, reason: 'Post-operative follow-up', status: 'Cancelled' },
      { on: '2025-01-21', doctor: NSG.suresh, reason: 'Annual spine review' },
      { on: -130, doctor: NSG.suresh, reason: 'Annual spine review' },
    ],
    stay: {
      doctor: NSG.suresh, type: 'Elective', reason: 'Lumbar decompression surgery', referral: 'Outpatient',
      attendant: { name: 'Meenakshi Narayanan', relationship: 'Spouse', phone: '+91 98430 61122' }, payment: 'Insurance', insurer: 'Star Health',
      policy: 'SH-61100482', bedId: 'bed-17', admittedOn: '2023-04-17', days: 6, remarks: 'Recovered — walking with support; review in two weeks',
    },
  },

  // ----------------------------------------- one earlier visit, and recent
  {
    uhid: 'ISH-0033104', name: 'Poornima Ganesan', nameNative: 'பூர்ணிமா கணேசன்', age: 34, sex: 'Female', registered: '2024-04-11',
    visits: [
      { on: '2024-04-11', doctor: GEN.farah, reason: 'Viral fever' },
      { on: -45, doctor: GEN.farah, reason: 'Stomach pain', status: 'Incomplete' },
    ],
  },
  {
    uhid: 'ISH-0033218', name: 'Aravind Sekar', age: 28, sex: 'Male', registered: '2025-03-06',
    visits: [{ on: '2025-03-06', doctor: ORT.ashwin, reason: 'Ankle sprain while playing football' }],
  },
  {
    uhid: 'ISH-0033331', name: 'Leela Krishnamurthy', nameNative: 'லீலா கிருஷ்ணமூர்த்தி', age: 63, sex: 'Female', registered: '2023-07-04',
    visits: [{ on: '2023-07-04', doctor: CAR.priya, reason: 'Chest pain — ECG' }],
  },
  {
    uhid: 'ISH-0033447', name: 'Rajendran Palanisamy', nameNative: 'ராஜேந்திரன் பழனிசாமி', age: 55, sex: 'Male', registered: '2022-11-21',
    visits: [{ on: '2022-11-21', doctor: GEN.rahul, reason: 'Acidity and chest burning' }],
  },
  {
    uhid: 'ISH-0033562', name: 'Meenatchi Sundaresan', nameNative: 'மீனாட்சி சுந்தரேசன்', age: 41, sex: 'Female', registered: '2025-08-12',
    visits: [{ on: '2025-08-12', doctor: NEU.ananya, reason: 'Headache and blurred vision' }],
  },

  // ------------------------------------------ recent only, no visit today
  {
    uhid: 'ISH-0033679', name: 'Vignesh Natarajan', age: 31, sex: 'Male', email: 'vignesh.n@example.com', registered: '2026-06-02',
    visits: [{ on: -64, doctor: ORT.nandini, reason: 'Lower back pain after a long drive' }, { on: -23, doctor: ORT.nandini, reason: 'Back pain — review', status: 'Cancelled' }],
  },
  {
    uhid: 'ISH-0033795', name: 'Revathi Chandran', nameNative: 'ரேவதி சந்திரன்', age: 38, sex: 'Female', registered: '2026-07-14',
    visits: [{ on: -52, doctor: GEN.farah, reason: 'Fever for three days' }],
  },
  {
    uhid: 'ISH-0033812', name: 'Anwar Hussain', nameNative: 'انور حسین', age: 47, sex: 'Male', registered: '2026-08-03',
    visits: [{ on: -37, doctor: CAR.priya, reason: 'Palpitations' }, { on: -9, doctor: CAR.priya, reason: 'Holter results', status: 'Incomplete' }],
  },
  {
    uhid: 'ISH-0033926', name: 'Saranya Mohan', nameNative: 'சரண்யா மோகன்', age: 26, sex: 'Female', registered: '2026-09-01',
    visits: [{ on: -15, doctor: NEU.sanjay, reason: 'Recurrent migraine' }],
  },

  // ------------------- registered today or this week — new patients, no past
  {
    uhid: 'ISH-0034001', name: 'Dinesh Karthikeyan', age: 36, sex: 'Male', registered: { minutesAgo: 95 }, visits: [],
    today: { doctor: GEN.farah, reason: 'First consultation', offset: 2, status: 'Confirmed' },
  },
  {
    uhid: 'ISH-0034002', name: 'Kavya Ramesh', nameNative: 'காவ்யா ரமேஷ்', age: 22, sex: 'Female', registered: { minutesAgo: 70 }, visits: [],
    today: { doctor: NEU.sanjay, reason: 'First consultation — headache', offset: -1, status: 'Checked-in', token: 'Waiting', arrivedMinutesAgo: 14 },
  },
  {
    uhid: 'ISH-0034003', name: 'Surya Prakash', age: 44, sex: 'Male', abhaId: 'surya.prakash@abdm', registered: { minutesAgo: 120 }, visits: [],
    today: { doctor: ORT.ashwin, reason: 'First consultation — knee pain', offset: -2, status: 'Completed' },
  },
  {
    uhid: 'ISH-0034004', name: 'Bhuvaneswari Anand', nameNative: 'புவனேஸ்வரி ஆனந்த்', age: 39, sex: 'Female', registered: -2, visits: [],
    today: { doctor: CAR.revathi, reason: 'First consultation', offset: 4, status: 'Confirmed' },
  },
  {
    uhid: 'ISH-0034005', name: 'Tharun Vijay', age: 19, sex: 'Male', registered: -1, visits: [],
    today: { doctor: EMG.arvind, reason: 'Minor injury — dressing', offset: -1, status: 'Checked-in', token: 'Called', arrivedMinutesAgo: 9 },
  },

  // -------------------------------------------- registered, no visit at all
  { uhid: 'ISH-0034110', name: 'Harini Balaji', nameNative: 'ஹரிணி பாலாஜி', age: 27, sex: 'Female', registered: -6, visits: [] },
  { uhid: 'ISH-0034111', name: 'Manoj Kumar Sharma', age: 52, sex: 'Male', registered: -12, visits: [] },
  { uhid: 'ISH-0034112', name: 'Yamini Subbiah', nameNative: 'யாமினி சுப்பையா', age: 33, sex: 'Female', registered: -20, visits: [] },

  // --------------------------------- an earlier hospital stay plus OPD visits
  {
    uhid: 'ISH-0034230', name: 'Thangavel Murugesan', nameNative: 'தங்கவேல் முருகேசன்', age: 73, sex: 'Male', registered: '2022-09-12',
    visits: [
      { on: '2022-09-12', doctor: CAR.priya, reason: 'Severe chest pain' },
      { on: '2022-10-11', doctor: CAR.priya, reason: 'Post-discharge review' },
      { on: '2023-04-04', doctor: CAR.harish, reason: 'Cardiac follow-up' },
      { on: '2024-01-23', doctor: CAR.harish, reason: 'Cardiac follow-up' },
      { on: '2025-02-25', doctor: CAR.harish, reason: 'Annual cardiac review' },
      { on: -77, doctor: CAR.harish, reason: 'Cardiac follow-up' },
    ],
    stay: {
      doctor: CAR.priya, type: 'Emergency', reason: 'Acute coronary syndrome — angiography and stenting', referral: 'Emergency',
      attendant: { name: 'Sivakami Murugesan', relationship: 'Spouse', phone: '+91 98433 71204' }, payment: 'Insurance', insurer: 'New India Assurance',
      policy: 'NIA-4420187', bedId: 'bed-10', admittedOn: '2022-09-12', days: 5, remarks: 'Stable after stenting — dual antiplatelets, review in a month',
    },
  },
  {
    uhid: 'ISH-0034347', name: 'Jayanthi Raghunathan', nameNative: 'ஜெயந்தி ரகுநாதன்', age: 65, sex: 'Female', registered: '2023-02-27',
    visits: [
      { on: '2023-02-27', doctor: ORT.meera, reason: 'Severe knee pain' },
      { on: '2023-03-20', doctor: ORT.meera, reason: 'Pre-operative assessment' },
      { on: '2023-05-02', doctor: ORT.meera, reason: 'Post-operative review' },
      { on: '2023-08-08', doctor: ORT.meera, reason: 'Knee replacement — three-month review' },
      { on: '2024-05-14', doctor: ORT.ashwin, reason: 'Knee replacement — annual review' },
      { on: -118, doctor: ORT.ashwin, reason: 'Left knee pain', status: 'Incomplete' },
    ],
    stay: {
      doctor: ORT.meera, type: 'Elective', reason: 'Right total knee replacement', referral: 'Outpatient',
      attendant: { name: 'Raghunathan Iyer', relationship: 'Spouse', phone: '+91 94420 55318' }, payment: 'TPA', insurer: 'Vidal Health TPA',
      policy: 'VH-3380912', bedId: 'bed-18', admittedOn: '2023-04-11', days: 5, remarks: 'Mobilised with a walker — physiotherapy at home',
    },
  },
  {
    uhid: 'ISH-0034458', name: 'Selvaraj Manickam', nameNative: 'செல்வராஜ் மாணிக்கம்', age: 58, sex: 'Male', registered: '2024-06-19',
    visits: [
      { on: '2024-06-19', doctor: GEN.rahul, reason: 'Fever with abdominal pain' },
      { on: '2024-07-09', doctor: GEN.rahul, reason: 'Post-discharge review' },
      { on: '2025-03-18', doctor: GEN.vikram, reason: 'Diabetes screening' },
      { on: -66, doctor: GEN.farah, reason: 'Routine check-up' },
    ],
    stay: {
      doctor: GEN.rahul, type: 'Emergency', reason: 'Acute pancreatitis — conservative management', referral: 'Outpatient',
      attendant: { name: 'Gomathi Selvaraj', relationship: 'Spouse', phone: '+91 97877 40236' }, payment: 'Self Pay', bedId: 'bed-3',
      admittedOn: '2024-06-19', days: 4, remarks: 'Pain-free and eating — low-fat diet advised',
    },
  },
  {
    uhid: 'ISH-0034569', name: 'Ananthi Velusamy', nameNative: 'ஆனந்தி வேலுசாமி', age: 47, sex: 'Female', registered: '2025-05-08',
    visits: [
      { on: '2025-05-08', doctor: NSG.divya, reason: 'Persistent headache with vomiting' },
      { on: '2025-05-22', doctor: NSG.divya, reason: 'Post-discharge review' },
      { on: '2025-11-04', doctor: NSG.divya, reason: 'MRI follow-up' },
      { on: -88, doctor: NSG.divya, reason: 'Annual follow-up' },
    ],
    stay: {
      doctor: NSG.divya, type: 'Emergency', reason: 'Head injury — observation and CT brain', referral: 'Emergency',
      attendant: { name: 'Velusamy Arumugam', relationship: 'Spouse', phone: '+91 99437 18820' }, payment: 'Corporate', insurer: 'TVS Motors',
      policy: 'TVS-EMP-33012', bedId: 'bed-9', admittedOn: '2025-05-08', days: 3, remarks: 'CT normal — advised rest, review in two weeks',
    },
  },
]

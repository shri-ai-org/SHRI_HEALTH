/**
 * UI_ATLAS.md §8 — the sample data kit. Verbatim.
 *
 * §8.6, the rule: "NEVER INVENT DATA OUTSIDE THIS KIT. If a mockup needs a
 * value the kit does not have, add it here first... A new patient name invented
 * for one screen is a defect, not a detail — it is the thing a client notices
 * and cannot un-notice."
 *
 * Fixed reference moment for every screen: Monday 21 September 2026, 08:40 IST,
 * at facility SD-F-01 unless the screen is explicitly a spoke.
 */

import type { PersonaId, ReferencedPersonaId } from '@/atlas/personas'

// ─────────────────────────────────────────────────── §8.1 Facilities & wards

export interface Facility {
  id: string
  name: string
  /** The town, for the app-bar chip and anywhere the full name will not fit. */
  short: string
  code: string
  beds: number
  role: 'hub' | 'secondary' | 'spoke'
  wards: string[]
  /** M-18's hub-and-spoke design turns on this. */
  strokeCapability: string
}

export const FACILITIES: Facility[] = [
  {
    id: 'SD-F-01',
    name: 'Indostates Health Hospital, Coimbatore',
    short: 'Coimbatore',
    code: 'ICH',
    beds: 620,
    role: 'hub',
    wards: ['4B', '2A', 'ICU-1', 'NICU', 'OT-1', 'OT-2', 'OT-3', 'OT-4', 'OT-5', 'OT-6', 'CATH-1'],
    strokeCapability: 'CT · CTA · CTP · MRI · cath lab · neuro-ICU · 24×7 neurology',
  },
  {
    id: 'SD-F-02',
    name: 'Indostates Tiruppur',
    short: 'Tiruppur',
    code: 'ITP',
    beds: 340,
    role: 'secondary',
    wards: ['3C', 'ICU-2'],
    strokeCapability: 'CT · teleneurology only',
  },
  {
    id: 'SD-F-03',
    name: 'Indostates Pollachi',
    short: 'Pollachi',
    code: 'IPL',
    beds: 260,
    role: 'spoke',
    wards: ['1A', 'ED'],
    strokeCapability: 'CT · teleneurology only',
  },
  {
    id: 'SD-F-04',
    name: 'Indostates Udumalpet',
    short: 'Udumalpet',
    code: 'IUD',
    beds: 180,
    role: 'spoke',
    wards: ['2B'],
    strokeCapability: '⊘ no CT — transfer-only',
  },
]

export const HUB = FACILITIES[0]

export function facility(code: string): Facility {
  const f = FACILITIES.find((x) => x.code === code)
  if (!f) throw new Error(`Unknown facility ${code} — §8.1 lists four`)
  return f
}

// ───────────────────────────────────────────────────── §8.2 Cast of patients

export type Payer = 'Self-pay (UPI)' | 'Self-pay (card)' | 'PM-JAY' | 'ESI' | 'CGHS' | 'TPA cashless' | 'None yet'

export interface Patient {
  id: string
  /** The unidentified patient has no name — by design. */
  name: string
  /** §5.4 rule 4 — names carry native script alongside Latin. */
  nameNative?: string
  age: number
  sex: 'M' | 'F' | 'O'
  /** UHID format {FAC}-{7 digits} (§8.1). */
  uhid: string
  scenario: string
  payer: Payer
  /** ABHA address or 14-digit number; null where not linked. */
  abha: string | null
  abhaStatus: 'Linked' | 'Not linked' | 'Consent pending' | 'Revoked'
  /** §8.5 — penicillin on SD-P-03 is the hard-stop demo. */
  allergies: string[]
  /** Ward-bed for inpatients, null for outpatients. */
  bed: string | null
  facilityCode: string
  /** Medico-legal case flag — renders in the patient banner. */
  mlc?: boolean
  unidentified?: boolean
  /** Length of stay in days, for inpatients. */
  losDays?: number
  /** The consultant of record. */
  consultant?: string
  weightKg?: number
}

export const PATIENTS: Patient[] = [
  {
    id: 'SD-P-01',
    name: 'Meera Krishnan',
    nameNative: 'മീര കൃഷ്ണൻ',
    age: 34,
    sex: 'F',
    uhid: 'ICH-0044120',
    scenario: 'OPD follow-up, hypothyroid, ABHA Scan & Share',
    payer: 'Self-pay (UPI)',
    abha: 'meera.krishnan@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: null,
    facilityCode: 'ICH',
    consultant: 'Dr. Ananya Iyer',
    weightKg: 58,
  },
  {
    id: 'SD-P-02',
    name: 'Abdul Rahman Sheikh',
    age: 58,
    sex: 'M',
    uhid: 'ICH-0041882',
    scenario: 'Elective CABG, PM-JAY package',
    payer: 'PM-JAY',
    abha: '91-2233-4455-1122',
    abhaStatus: 'Linked',
    allergies: [],
    bed: '2A-04',
    facilityCode: 'ICH',
    losDays: 2,
    consultant: 'Dr. Ananya Iyer',
    weightKg: 74,
  },
  {
    /**
     * The hard-stop patient. Documented penicillin allergy plus co-amoxiclav is
     * deck beat #8 — the one screen where the AI is overruled by a
     * deterministic rule.
     */
    id: 'SD-P-03',
    name: 'R. Lakshmanan',
    nameNative: 'ஆர். லக்ஷ்மணன்',
    age: 62,
    sex: 'M',
    uhid: 'ICH-0044051',
    scenario: 'IP, community-acquired pneumonia, deteriorating',
    payer: 'PM-JAY',
    abha: 'lakshmanan.r@abdm',
    abhaStatus: 'Linked',
    allergies: ['Penicillin'],
    bed: '4B-12',
    facilityCode: 'ICH',
    losDays: 4,
    consultant: 'Dr. Ananya Iyer',
    weightKg: 66,
  },
  {
    id: 'SD-P-04',
    name: 'Sunita Devi',
    nameNative: 'सुनीता देवी',
    age: 29,
    sex: 'F',
    uhid: 'ICH-0044208',
    scenario: 'Obstetric, 32 weeks, ultrasound → Form F',
    payer: 'ESI',
    abha: 'sunita.devi@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: null,
    facilityCode: 'ICH',
    consultant: 'Dr. Ananya Iyer',
    weightKg: 68,
  },
  {
    /** The deck's protagonist — a 7-screen stroke journey on one patient. */
    id: 'SD-P-05',
    name: 'Vikram Malhotra',
    nameNative: 'विक्रम मल्होत्रा',
    age: 47,
    sex: 'M',
    uhid: 'IPL-0012774',
    scenario: 'Code stroke at Pollachi spoke, LVO, drip-and-ship',
    payer: 'TPA cashless',
    abha: 'vikram.malhotra@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: 'ED-02',
    facilityCode: 'IPL',
    consultant: 'Dr. Priya Menon',
    weightKg: 78,
  },
  {
    id: 'SD-P-06',
    name: 'Kavya Reddy',
    age: 6,
    sex: 'F',
    uhid: 'ICH-0044191',
    scenario: 'Paediatric, febrile, day care',
    payer: 'Self-pay (card)',
    abha: 'kavya.reddy@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: null,
    facilityCode: 'ICH',
    consultant: 'Dr. Ananya Iyer',
    weightKg: 19,
  },
  {
    id: 'SD-P-07',
    name: 'Joseph Mathew',
    age: 71,
    sex: 'M',
    uhid: 'ICH-0043910',
    scenario: 'ICU, septic shock, ventilated',
    payer: 'CGHS',
    abha: 'joseph.mathew@abdm',
    abhaStatus: 'Linked',
    allergies: ['Sulfa'],
    bed: 'ICU-1',
    facilityCode: 'ICH',
    losDays: 6,
    consultant: 'Dr. Ananya Iyer',
    weightKg: 62,
  },
  {
    id: 'SD-P-09',
    name: 'Fatima Bi',
    age: 66,
    sex: 'F',
    uhid: 'ICH-0042330',
    scenario: 'Dialysis, thrice weekly, chronic',
    payer: 'PM-JAY',
    abha: 'fatima.bi@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: null,
    facilityCode: 'ICH',
    consultant: 'Dr. Ananya Iyer',
    weightKg: 54,
  },
  {
    id: 'SD-P-10',
    name: 'Arjun Nair',
    age: 24,
    sex: 'M',
    uhid: 'ICH-0044240',
    scenario: 'Teleconsult, dermatology, follow-up',
    payer: 'Self-pay (UPI)',
    abha: 'arjun.nair@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: null,
    facilityCode: 'ICH',
    consultant: 'Dr. Ananya Iyer',
    weightKg: 70,
  },

  // ── The CT patients. Each stands behind one real, de-identified CQ500 head
  //    CT (scripts/ncct-import.mjs), and each story is chosen to fit that
  //    study's own ground-truth labels — so the words never contradict the
  //    pixels.
  {
    /** CQ500-CT-61 · SDH + mass effect + midline shift. Seen today three weeks after evacuation. */
    id: 'SD-P-11',
    name: 'Selvi Murugan',
    nameNative: 'செல்வி முருகன்',
    age: 76,
    sex: 'F',
    uhid: 'ICH-0044262',
    scenario: 'OPD follow-up, 3 weeks after right subdural haematoma evacuation',
    payer: 'PM-JAY',
    abha: 'selvi.murugan@abdm',
    abhaStatus: 'Linked',
    allergies: ['Aspirin'],
    bed: null,
    facilityCode: 'ICH',
    consultant: 'Dr. Ananya Iyer',
    weightKg: 52,
  },
  {
    /** CQ500-CT-10 · ICH + IPH. A small deep bleed, blood-pressure pathway. */
    id: 'SD-P-12',
    name: 'Kumar Subramanian',
    nameNative: 'குமார் சுப்பிரமணியன்',
    age: 58,
    sex: 'M',
    uhid: 'ICH-0044275',
    scenario: 'IP, left thalamic haemorrhage, hypertensive, stroke unit day 3',
    payer: 'CGHS',
    abha: 'kumar.subramanian@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: '4B-08',
    facilityCode: 'ICH',
    losDays: 3,
    consultant: 'Dr. Ananya Iyer',
    weightKg: 81,
  },
  {
    /** CQ500-CT-366 · mass effect + midline shift, no blood. A late, large infarct. */
    id: 'SD-P-13',
    name: 'Priya Raman',
    nameNative: 'பிரியா ராமன்',
    age: 44,
    sex: 'F',
    uhid: 'ICH-0044281',
    scenario: 'IP, large right MCA infarct with mass effect, neurosurgery review',
    payer: 'TPA cashless',
    abha: 'priya.raman@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: '4B-15',
    facilityCode: 'ICH',
    losDays: 1,
    consultant: 'Dr. Ananya Iyer',
    weightKg: 63,
  },
  {
    /** CQ500-CT-48 · IPH + IVH + SAH + mass effect + shift. The anticoagulated bleed. */
    id: 'SD-P-14',
    name: 'Santhosh Babu',
    nameNative: 'சந்தோஷ் பாபு',
    age: 69,
    sex: 'M',
    uhid: 'ITP-0021934',
    scenario: 'Code stroke at Tiruppur, large right basal ganglia haemorrhage on warfarin',
    payer: 'ESI',
    abha: 'santhosh.babu@abdm',
    abhaStatus: 'Linked',
    allergies: ['Sulfa'],
    bed: 'ICU-2',
    facilityCode: 'ITP',
    consultant: 'Dr. Rohit Desai',
    weightKg: 70,
  },
  {
    /** CQ500-CT-25 · normal. The reassuring scan. */
    id: 'SD-P-15',
    name: 'Lakshmi Narayanan',
    nameNative: 'லக்ஷ்மி நாராயணன்',
    age: 38,
    sex: 'F',
    uhid: 'ICH-0044290',
    scenario: 'OPD follow-up, migraine without aura, CT head normal',
    payer: 'Self-pay (UPI)',
    abha: 'lakshmi.narayanan@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: null,
    facilityCode: 'ICH',
    consultant: 'Dr. Ananya Iyer',
    weightKg: 60,
  },
  {
    /** CQ500-CT-50 · normal. A partial thin series — 8 images. */
    id: 'SD-P-16',
    name: 'Rahul Verma',
    nameNative: 'राहुल वर्मा',
    age: 22,
    sex: 'M',
    uhid: 'ICH-0044297',
    scenario: 'OPD follow-up, minor head injury, CT head normal',
    payer: 'ESI',
    abha: 'rahul.verma@abdm',
    abhaStatus: 'Consent pending',
    allergies: [],
    bed: null,
    facilityCode: 'ICH',
    /** Road-traffic head injury — a medico-legal case, flagged in the banner. */
    mlc: true,
    consultant: 'Dr. Ananya Iyer',
    weightKg: 72,
  },
]

const patientsById = new Map(PATIENTS.map((p) => [p.id, p]))

export function patient(id: string): Patient {
  const p = patientsById.get(id)
  if (!p) throw new Error(`Unknown patient ${id} — the sample-data kit lists ${PATIENTS.length}`)
  return p
}

export function maybePatient(id: string | undefined): Patient | undefined {
  return id ? patientsById.get(id) : undefined
}

/** Resolve either a SD-P id or a UHID, since routes carry the UHID. */
export function patientByAnyId(key: string | undefined): Patient | undefined {
  if (!key) return undefined
  return patientsById.get(key) ?? PATIENTS.find((p) => p.uhid === key)
}

// ──────────────────────────────────────────────────────── §8.3 Cast of staff

export interface Staff {
  id: string
  name: string
  persona: ReferencedPersonaId
  personaLabel: string
  facilityCode: string
  /** HPR number for clinicians, employee number for others. */
  identifier: string
  identifierKind: 'HPR' | 'Emp'
  speciality?: string
}

export const STAFF: Staff[] = [
  {
    id: 'SD-S-01',
    name: 'Dr. Ananya Iyer',
    persona: 'P-04',
    personaLabel: 'Consultant, general medicine',
    facilityCode: 'ICH',
    identifier: 'IN-HPR-2291840',
    identifierKind: 'HPR',
    speciality: 'General Medicine',
  },
  {
    id: 'SD-S-02',
    name: 'Dr. Rohit Desai',
    persona: 'P-35',
    personaLabel: 'Stroke neurologist (on-call)',
    facilityCode: 'ICH',
    identifier: 'IN-HPR-1180422',
    identifierKind: 'HPR',
    speciality: 'Neurology',
  },
  {
    id: 'SD-S-03',
    name: 'Dr. Priya Menon',
    persona: 'P-38',
    personaLabel: 'Spoke physician (general medicine)',
    facilityCode: 'IPL',
    identifier: 'IN-HPR-3342109',
    identifierKind: 'HPR',
    speciality: 'General Medicine',
  },
  {
    id: 'SD-S-04',
    name: 'Dr. Samir Kulkarni',
    persona: 'P-36',
    personaLabel: 'Neuro-interventionist',
    facilityCode: 'ICH',
    identifier: 'IN-HPR-2204711',
    identifierKind: 'HPR',
    speciality: 'Neurointervention',
  },
  {
    id: 'SD-S-05',
    name: 'Sr. Lalitha Raman',
    persona: 'P-07',
    personaLabel: 'Staff nurse, ward 4B',
    facilityCode: 'ICH',
    identifier: 'ICH-N-0912',
    identifierKind: 'Emp',
  },
  {
    id: 'SD-S-06',
    name: 'Sr. Grace Fernandes',
    persona: 'P-37',
    personaLabel: 'Stroke coordinator',
    facilityCode: 'ICH',
    identifier: 'ICH-N-0455',
    identifierKind: 'Emp',
  },
  {
    id: 'SD-S-07',
    name: 'Dr. Neha Bhatt',
    persona: 'P-13',
    personaLabel: 'Radiologist',
    facilityCode: 'ICH',
    identifier: 'IN-HPR-2871003',
    identifierKind: 'HPR',
    speciality: 'Radiology',
  },
  {
    id: 'SD-S-08',
    name: 'Mr Suresh Pillai',
    persona: 'P-21',
    personaLabel: 'Billing executive',
    facilityCode: 'ICH',
    identifier: 'ICH-B-0233',
    identifierKind: 'Emp',
  },
  {
    id: 'SD-S-09',
    name: 'Ms Rekha Joshi',
    persona: 'P-22',
    personaLabel: 'TPA desk executive',
    facilityCode: 'ICH',
    identifier: 'ICH-I-0118',
    identifierKind: 'Emp',
  },
  {
    id: 'SD-S-10',
    name: 'Mr Ganesh Kumar',
    persona: 'P-39',
    personaLabel: 'Paramedic',
    facilityCode: 'IPL',
    identifier: 'IPL-E-0071',
    identifierKind: 'Emp',
  },
  {
    id: 'SD-S-11',
    name: 'Dr. Vivek Sharma',
    persona: 'P-02',
    personaLabel: 'Medical superintendent',
    facilityCode: 'ICH',
    identifier: 'IN-HPR-1009922',
    identifierKind: 'HPR',
  },
  {
    id: 'SD-S-12',
    name: 'Ms Anjali Nambiar',
    persona: 'P-25',
    personaLabel: 'Quality manager / NABH coordinator',
    facilityCode: 'ICH',
    identifier: 'ICH-Q-0021',
    identifierKind: 'Emp',
  },
]

export function staff(id: string): Staff {
  const s = STAFF.find((x) => x.id === id)
  if (!s) throw new Error(`Unknown staff member ${id} — §8.3 lists twelve`)
  return s
}

/**
 * The staff member who is signed in when the app runs as a given persona.
 * SD-S-01 Dr. Ananya Iyer is the default; the resident has no §8.3 entry, so
 * she is presented as a registrar under her own name rather than inventing a
 * thirteenth cast member (§8.6).
 */
export const STAFF_FOR_PERSONA: Record<PersonaId, string> = {
  'P-04': 'SD-S-01',
  'P-05': 'SD-S-01',
  'P-06': 'SD-S-01',
  'P-13': 'SD-S-07',
  'P-35': 'SD-S-02',
  'P-36': 'SD-S-04',
  'P-38': 'SD-S-03',
}

// ─────────────────────────────────────────────────────── §8.4 Money & tariffs

export interface Tariff {
  id: string
  item: string
  selfPay: number
  pmjay: number | null
  tpa: number
  note?: string
}

export const TARIFFS: Tariff[] = [
  { id: 'SD-M-01', item: 'General ward bed / day', selfPay: 2400, pmjay: 1800, tpa: 2100, note: 'GST-exempt' },
  { id: 'SD-M-02', item: 'Private room / day', selfPay: 6500, pmjay: null, tpa: 5800, note: 'GST-taxable, > ₹5,000' },
  { id: 'SD-M-03', item: 'ICU bed / day', selfPay: 12000, pmjay: 9000, tpa: 10500 },
  { id: 'SD-M-04', item: 'Consultation, specialist', selfPay: 800, pmjay: 300, tpa: 700 },
  { id: 'SD-M-05', item: 'NCCT head', selfPay: 2200, pmjay: 1500, tpa: 1900 },
  { id: 'SD-M-06', item: 'CT angiogram + perfusion', selfPay: 9500, pmjay: 7000, tpa: 8600 },
  {
    id: 'SD-M-07',
    item: 'Tenecteplase 0.25 mg/kg',
    selfPay: 42000,
    pmjay: null,
    tpa: 42000,
    note: 'package-inclusive under PM-JAY · the stroke cost decision',
  },
  { id: 'SD-M-08', item: 'Mechanical thrombectomy', selfPay: 480000, pmjay: 165000, tpa: 390000 },
  { id: 'SD-M-09', item: 'CABG', selfPay: 325000, pmjay: 120000, tpa: 275000 },
  { id: 'SD-M-10', item: 'Haemodialysis session', selfPay: 2800, pmjay: 1500, tpa: 2400 },
]

export function tariff(id: string): Tariff {
  const t = TARIFFS.find((x) => x.id === id)
  if (!t) throw new Error(`Unknown tariff ${id} — §8.4 lists ten`)
  return t
}

/** The payer mix used in every dashboard mockup. */
export const PAYER_MIX = [
  { payer: 'TPA cashless', share: 35 },
  { payer: 'Self-pay', share: 25 },
  { payer: 'PM-JAY', share: 24 },
  { payer: 'Other schemes (CGHS/ESI/state)', share: 16 },
]

/**
 * §2.1 A10 — "Digital payment modes only. No cash is accepted." The list is
 * configurable with the cash mode absent, rather than structurally impossible.
 */
export const PAYMENT_MODES = ['UPI', 'QR', 'Card', 'POS', 'Netbanking'] as const

// ──────────────────────────────────────────── §8.5 Fixed option lists

/** Drugs. The kit's list and no others. */
export const DRUGS = [
  'Tenecteplase',
  'Co-amoxiclav 1.2g IV',
  'Piperacillin-tazobactam 4.5g IV',
  'Enoxaparin 40mg SC',
  'Atorvastatin 40mg',
  'Clopidogrel 75mg',
  'Metformin 500mg',
  'Paracetamol 1g IV',
] as const
export type Drug = (typeof DRUGS)[number]

export const ALLERGIES = ['Penicillin', 'Sulfa', 'Iodinated contrast'] as const

export const TESTS = [
  'CBC',
  'CRP',
  'Serum creatinine',
  'Serum magnesium',
  'HbA1c',
  'Blood culture',
  'NCCT head',
  'CT angiogram',
  'CT perfusion',
  'Chest X-ray PA',
  'ECG',
  'Troponin I',
] as const
export type Test = (typeof TESTS)[number]

export interface Diagnosis {
  label: string
  icd10: string
}

export const DIAGNOSES: Diagnosis[] = [
  { label: 'Community-acquired pneumonia', icd10: 'J18.9' },
  { label: 'Acute ischaemic stroke', icd10: 'I63.9' },
  { label: 'Septic shock', icd10: 'R65.21' },
  { label: 'Type 2 diabetes', icd10: 'E11.9' },
  { label: 'Hypothyroidism', icd10: 'E03.9' },
]

export const TRANSFER_REASONS = [
  'Higher level of care',
  'Isolation required',
  'Bed class change (payer)',
  'Patient request',
  'Gender-mix correction',
  'Ward closure',
] as const

export const ISOLATION_CATEGORIES = ['Contact', 'Droplet', 'Airborne', 'Protective', 'None'] as const

export const TRIAGE_LEVELS = [
  '1 Resuscitation',
  '2 Emergent',
  '3 Urgent',
  '4 Less urgent',
  '5 Non-urgent',
] as const

/** §5.4 — launch languages: English + Hindi + one regional (A6). */
export const LANGUAGES = [
  { code: 'EN', label: 'English' },
  { code: 'HI', label: 'हिन्दी' },
  { code: 'KN', label: 'ಕನ್ನಡ' },
] as const
export type LanguageCode = (typeof LANGUAGES)[number]['code']

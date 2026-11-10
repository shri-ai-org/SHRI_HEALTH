// SIMULATED ABHA health records — a front-end demo only. Nothing here comes
// from ABDM: there is no ABHA/ABDM integration, and none of this is medical
// advice or a real prescription. Every facility, clinician and result is
// fictional.
//
// Records come in short, coherent histories (a consultation, the tests it
// ordered, the follow-up …) with dates in order. Each linked patient gets one
// or two of these histories, picked by their patient id — so a patient always
// sees the same records, two patients rarely share a history, and no record
// appears twice. These are never the hospital's own visits or bills.
import { addDaysToKey } from './selectors'
import type { Patient } from '../types/patient'

export type AbhaRecordType = 'Lab report' | 'Prescription' | 'Discharge summary' | 'Diagnostic report' | 'Consultation'

/** One investigation result. `flag` marks a value outside its reference range. */
export interface AbhaResult {
  test: string
  value: string
  unit: string
  reference: string
  flag?: 'High' | 'Low' | 'Borderline'
}

/** One prescribed medicine, in the usual morning-noon-night schedule. */
export interface AbhaMedication {
  drug: string
  strength: string
  /** e.g. "0-0-1" */
  schedule: string
  /** The schedule in words, e.g. "Once nightly". */
  scheduleNote: string
  duration: string
}

export interface AbhaRecord {
  id: string
  type: AbhaRecordType
  title: string
  /** The record's date (YYYY-MM-DD): report, prescription, visit or discharge date. */
  date: string
  source: string
  clinician?: { name: string; department: string }
  /** Admission and discharge dates — discharge summaries. */
  stay?: { admitted: string; discharged: string }
  /** Sample collection date — lab reports (the report date is `date`). */
  collected?: string
  reason?: string
  findings?: string[]
  results?: AbhaResult[]
  assessment?: string
  medications?: AbhaMedication[]
  /** Non-medicine treatment, monitoring or hospital course. */
  treatment?: string[]
  advice?: string[]
  followUp?: string
  summary: string
}

export interface AbhaDemoProfile {
  bloodGroup: string
  records: AbhaRecord[]
}

// Fictional facilities and clinicians.
const NILA = 'Nila Diagnostics Centre'
const THENDRAL = 'Thendral Family Clinic'
const MALAR = 'Malar Multispeciality Hospital'
const VAIGAI = 'Vaigai Health Centre'
const KURINJI = 'Kurinji Scan & Labs'
const DR = {
  revathi: { name: 'Dr. K. Revathi', department: 'General Medicine' },
  senthil: { name: 'Dr. P. Senthil', department: 'General Medicine' },
  meera: { name: 'Dr. S. Meera', department: 'Pathology' },
  arul: { name: 'Dr. A. Arulmozhi', department: 'Radiology' },
  vignesh: { name: 'Dr. R. Vignesh', department: 'Orthopedics' },
  latha: { name: 'Dr. N. Latha', department: 'Internal Medicine' },
}

type Draft = Omit<AbhaRecord, 'id'> & { key: string }

/** A history: its records, dated from `d(n)` — n days after the history began. */
interface History {
  /** Days from its first record to its last. */
  span: number
  build: (d: (days: number) => string) => Draft[]
}

const HISTORIES: History[] = [
  // Tiredness → blood tests → blood pressure follow-up and treatment.
  {
    span: 31,
    build: (d) => [
      {
        key: 'tired-consult',
        type: 'Consultation',
        title: 'OP Consultation — Tiredness',
        date: d(0),
        source: THENDRAL,
        clinician: DR.revathi,
        reason: 'Tiredness for two weeks',
        findings: ['BP 138/88 mmHg', 'Pulse 78 /min, regular', 'Weight 74 kg · BMI 26.4 kg/m²', 'No pallor, no swelling of the feet'],
        assessment: 'Fatigue — cause to be found; blood pressure at the upper end of normal',
        advice: ['Complete blood count, HbA1c and lipid profile'],
        followUp: 'Review with the reports in 4 weeks',
        summary: 'First visit for tiredness; blood tests ordered and blood pressure to be rechecked.',
      },
      {
        key: 'tired-cbc',
        type: 'Lab report',
        title: 'Complete Blood Count',
        collected: d(1),
        date: d(1),
        source: NILA,
        clinician: DR.meera,
        reason: 'Tiredness — screening',
        results: [
          { test: 'Haemoglobin', value: '13.4', unit: 'g/dL', reference: '13.0–17.0' },
          { test: 'Total WBC count', value: '7,800', unit: '/µL', reference: '4,000–11,000' },
          { test: 'Platelet count', value: '260,000', unit: '/µL', reference: '150,000–410,000' },
        ],
        assessment: 'All values within the reference range',
        summary: 'Normal blood count — anaemia and infection not suggested.',
      },
      {
        key: 'tired-hba1c',
        type: 'Lab report',
        title: 'HbA1c',
        collected: d(1),
        date: d(2),
        source: NILA,
        clinician: DR.meera,
        reason: 'Tiredness — screening for raised blood sugar',
        results: [
          { test: 'HbA1c', value: '6.1', unit: '%', reference: 'Below 5.7 normal · 5.7–6.4 prediabetes range', flag: 'Borderline' },
          { test: 'Estimated average glucose', value: '128', unit: 'mg/dL', reference: 'Derived from HbA1c' },
        ],
        assessment: 'The result falls within the commonly used prediabetes range (5.7–6.4%)',
        followUp: 'Repeat HbA1c in 3 months',
        summary: 'A single raised reading — to be read together with the repeat test.',
      },
      {
        key: 'tired-lipid',
        type: 'Lab report',
        title: 'Lipid Profile',
        collected: d(1),
        date: d(2),
        source: NILA,
        clinician: DR.meera,
        reason: 'Cardiovascular risk screening',
        results: [
          { test: 'Total cholesterol', value: '212', unit: 'mg/dL', reference: 'Below 200', flag: 'High' },
          { test: 'LDL cholesterol', value: '138', unit: 'mg/dL', reference: 'Below 100', flag: 'High' },
          { test: 'HDL cholesterol', value: '44', unit: 'mg/dL', reference: 'Above 40' },
          { test: 'Triglycerides', value: '160', unit: 'mg/dL', reference: 'Below 150', flag: 'High' },
        ],
        assessment: 'Borderline high cholesterol and triglycerides',
        summary: 'Adds to cardiovascular risk alongside the borderline blood pressure.',
      },
      {
        key: 'tired-followup',
        type: 'Consultation',
        title: 'Follow-up Consultation — Blood Pressure',
        date: d(30),
        source: THENDRAL,
        clinician: DR.revathi,
        reason: 'Review of blood reports and blood pressure',
        findings: ['BP 146/92 mmHg (repeat reading 144/90 mmHg)', 'Pulse 80 /min', 'Reports reviewed: HbA1c 6.1 %, total cholesterol 212 mg/dL'],
        assessment: 'Raised blood pressure on repeated readings; HbA1c in the prediabetes range; borderline high cholesterol',
        treatment: ['Blood pressure medicine started — see the prescription of the same date'],
        followUp: 'Blood pressure review in 4 weeks',
        summary: 'Reports reviewed; blood pressure treatment started with lifestyle changes.',
      },
      {
        key: 'bp-rx',
        type: 'Prescription',
        title: 'Prescription — Blood Pressure Management',
        date: d(30),
        source: THENDRAL,
        clinician: DR.revathi,
        reason: 'Blood pressure management',
        medications: [{ drug: 'Amlodipine', strength: '5 mg', schedule: '0-0-1', scheduleNote: 'Once nightly', duration: '30 days' }],
        advice: ['Low-salt diet', '30 minutes of walking daily'],
        followUp: 'Blood pressure review in 4 weeks',
        summary: 'Blood pressure treatment started alongside lifestyle changes.',
      },
    ],
  },
  // Fever → low platelets → three-day admission → recovery.
  {
    span: 12,
    build: (d) => [
      {
        key: 'fever-consult',
        type: 'Consultation',
        title: 'OP Consultation — Fever',
        date: d(0),
        source: VAIGAI,
        clinician: DR.senthil,
        reason: 'Fever with body ache for 3 days',
        findings: ['Temperature 101.8 °F', 'BP 112/72 mmHg · Pulse 96 /min', 'No rash, no bleeding'],
        assessment: 'Acute febrile illness — dengue to be ruled out',
        advice: ['Complete blood count and dengue NS1 antigen today', 'Oral fluids, paracetamol for fever'],
        followUp: 'Review the same evening with reports',
        summary: 'Fever for 3 days; blood tests sent for dengue.',
      },
      {
        key: 'fever-cbc',
        type: 'Lab report',
        title: 'Complete Blood Count with Dengue NS1',
        collected: d(0),
        date: d(0),
        source: VAIGAI,
        clinician: DR.meera,
        reason: 'Fever — dengue screening',
        results: [
          { test: 'Haemoglobin', value: '14.1', unit: 'g/dL', reference: '13.0–17.0' },
          { test: 'Total WBC count', value: '3,200', unit: '/µL', reference: '4,000–11,000', flag: 'Low' },
          { test: 'Platelet count', value: '110,000', unit: '/µL', reference: '150,000–410,000', flag: 'Low' },
          { test: 'Dengue NS1 antigen', value: 'Positive', unit: '', reference: 'Negative', flag: 'High' },
        ],
        assessment: 'Low white cells and platelets with a positive NS1 antigen',
        summary: 'Findings consistent with dengue; platelets 110,000 /µL.',
      },
      {
        key: 'dengue-discharge',
        type: 'Discharge summary',
        title: 'Discharge Summary — Platelet Monitoring',
        stay: { admitted: d(1), discharged: d(4) },
        date: d(4),
        source: MALAR,
        clinician: DR.latha,
        reason: 'Platelet monitoring — dengue fever',
        findings: ['No bleeding symptoms reported', 'Afebrile from day 2 of admission'],
        results: [
          { test: 'Platelet count — lowest (day 2)', value: '88,000', unit: '/µL', reference: '150,000–410,000', flag: 'Low' },
          { test: 'Platelet count — at discharge', value: '160,000', unit: '/µL (1.6 lakh)', reference: '150,000–410,000' },
        ],
        treatment: ['Platelet count checked every 12 hours over 3 days', 'Oral and IV fluids to maintain hydration', 'Paracetamol for fever'],
        assessment: 'Dengue fever with low platelets, recovered without bleeding',
        advice: ['Plenty of oral fluids', 'Rest at home'],
        followUp: 'Repeat platelet count and review in 1 week',
        summary: 'Admitted for 3 days to watch the platelet count, which fell to 88,000 /µL and recovered to 160,000 /µL. No bleeding; discharged stable.',
      },
      {
        key: 'dengue-review-cbc',
        type: 'Lab report',
        title: 'Platelet Count — Post-Discharge',
        collected: d(11),
        date: d(11),
        source: NILA,
        clinician: DR.meera,
        reason: 'Follow-up after dengue fever',
        results: [
          { test: 'Platelet count', value: '240,000', unit: '/µL', reference: '150,000–410,000' },
          { test: 'Total WBC count', value: '6,400', unit: '/µL', reference: '4,000–11,000' },
        ],
        assessment: 'Platelets and white cells back within the reference range',
        summary: 'Full recovery of the blood count after dengue.',
      },
    ],
  },
  // Stomach infection → admission → scan finding → liver follow-up.
  {
    span: 40,
    build: (d) => [
      {
        key: 'ge-discharge',
        type: 'Discharge summary',
        title: 'Discharge Summary — Acute Gastroenteritis',
        stay: { admitted: d(0), discharged: d(2) },
        date: d(2),
        source: MALAR,
        clinician: DR.latha,
        reason: 'Loose stools and vomiting with dehydration',
        findings: ['Moderate dehydration on admission', 'Stool culture: no growth', 'Serum sodium 134 mmol/L (135–145)'],
        treatment: ['IV fluids for 2 days', 'Oral rehydration once vomiting settled'],
        assessment: 'Acute gastroenteritis with dehydration, resolved',
        advice: ['Oral rehydration solution after each loose stool', 'Soft, home-cooked food for 3 days'],
        followUp: 'General medicine review in 1 week',
        summary: 'Two-day admission for dehydration from gastroenteritis; discharged stable, eating normally.',
      },
      {
        key: 'ge-usg',
        type: 'Diagnostic report',
        title: 'Ultrasound Abdomen',
        date: d(9),
        source: KURINJI,
        clinician: DR.arul,
        reason: 'Upper abdominal discomfort after gastroenteritis',
        findings: ['Liver mildly enlarged (15.8 cm) with increased echotexture', 'Gall bladder, pancreas, kidneys and spleen normal', 'No free fluid'],
        assessment: 'Grade I fatty liver',
        summary: 'Fatty liver found on the scan; liver tests ordered next.',
      },
      {
        key: 'ge-lft',
        type: 'Lab report',
        title: 'Liver Function Test',
        collected: d(10),
        date: d(10),
        source: NILA,
        clinician: DR.meera,
        reason: 'Fatty liver on ultrasound',
        results: [
          { test: 'Total bilirubin', value: '0.8', unit: 'mg/dL', reference: '0.3–1.2' },
          { test: 'ALT (SGPT)', value: '58', unit: 'U/L', reference: 'Below 45', flag: 'High' },
          { test: 'AST (SGOT)', value: '41', unit: 'U/L', reference: 'Below 40', flag: 'High' },
          { test: 'Albumin', value: '4.3', unit: 'g/dL', reference: '3.5–5.0' },
        ],
        assessment: 'Mildly raised liver enzymes, in keeping with fatty liver',
        summary: 'Liver is working normally; only a mild enzyme rise.',
      },
      {
        key: 'ge-followup',
        type: 'Consultation',
        title: 'Follow-up Consultation — Fatty Liver',
        date: d(40),
        source: THENDRAL,
        clinician: DR.revathi,
        reason: 'Review of ultrasound and liver tests',
        findings: ['Weight 81 kg · BMI 28.1 kg/m²', 'Abdomen soft, no tenderness'],
        assessment: 'Grade I fatty liver with mildly raised liver enzymes',
        advice: ['Lose 5–7% of body weight over 6 months', 'Avoid alcohol', 'Cut down fried food and sugar'],
        followUp: 'Repeat liver function test in 3 months',
        summary: 'Fatty liver explained; weight loss and diet changes advised.',
      },
    ],
  },
  // Cough and fever → chest X-ray → later knee pain.
  {
    span: 120,
    build: (d) => [
      {
        key: 'cough-rx',
        type: 'Prescription',
        title: 'Prescription — Fever and Cough',
        date: d(0),
        source: VAIGAI,
        clinician: DR.senthil,
        reason: 'Fever and dry cough for 2 days',
        medications: [
          { drug: 'Paracetamol', strength: '650 mg', schedule: '1-0-1', scheduleNote: 'Twice a day after food', duration: '3 days' },
          { drug: 'Cetirizine', strength: '10 mg', schedule: '0-0-1', scheduleNote: 'Once nightly', duration: '5 days' },
        ],
        advice: ['Steam inhalation twice a day', 'Warm fluids'],
        followUp: 'Review if the fever lasts beyond 3 days',
        summary: 'Treatment for a viral-type fever and cough.',
      },
      {
        key: 'cough-xray',
        type: 'Diagnostic report',
        title: 'Chest X-ray (PA view)',
        date: d(4),
        source: KURINJI,
        clinician: DR.arul,
        reason: 'Cough persisting beyond 3 days',
        findings: ['Lung fields clear', 'Heart size normal', 'No pleural effusion'],
        assessment: 'No active lung lesion',
        summary: 'No chest X-ray finding explains the persisting cough.',
      },
      {
        key: 'knee-consult',
        type: 'Consultation',
        title: 'OP Consultation — Right Knee Pain',
        date: d(120),
        source: MALAR,
        clinician: DR.vignesh,
        reason: 'Right knee pain on climbing stairs for 1 month',
        findings: ['Mild tenderness over the inner joint line', 'Full range of movement', 'No swelling'],
        assessment: 'Suspected early wear of the right knee joint',
        advice: ['Quadriceps strengthening exercises daily', 'Avoid squatting and sitting cross-legged'],
        followUp: 'Review in 6 weeks if not better',
        summary: 'Knee pain managed with exercises; no imaging needed for now.',
      },
      {
        key: 'knee-ecg',
        type: 'Diagnostic report',
        title: 'ECG (12-lead) — Pre-procedure Check',
        date: d(121),
        source: MALAR,
        clinician: DR.latha,
        reason: 'Routine check before a knee injection',
        findings: ['Heart rate 76 /min', 'Normal sinus rhythm', 'No ST-T changes'],
        assessment: 'Normal ECG',
        summary: 'No heart-rhythm concern before the planned knee injection.',
      },
    ],
  },
]

const BLOOD_GROUPS = ['O+', 'B+', 'A+', 'AB+', 'O−', 'B−', 'A−']

/** A small, repeatable random sequence from a patient id. */
function seeded(text: string): () => number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
}

/** The simulated ABHA profile for a patient with an ABHA linked — null without one. */
export function getAbhaDemoProfile(patient: Pick<Patient, 'patientId' | 'abhaId'>, today: string): AbhaDemoProfile | null {
  if (!patient.abhaId) return null
  const random = seeded(patient.patientId)
  const bloodGroup = BLOOD_GROUPS[Math.floor(random() * BLOOD_GROUPS.length)]
  // One or two different histories, the older one well before the newer.
  const first = Math.floor(random() * HISTORIES.length)
  const chosen = random() < 0.6 ? [first, (first + 1 + Math.floor(random() * (HISTORIES.length - 1))) % HISTORIES.length] : [first]
  let end = -(10 + Math.floor(random() * 60)) // the newest history ends 10–70 days ago
  const records: AbhaRecord[] = []
  for (const index of chosen) {
    const history = HISTORIES[index]
    const start = end - history.span
    const d = (days: number) => addDaysToKey(today, start + days)
    for (const { key, ...record } of history.build(d)) records.push({ ...record, id: `abha-${patient.patientId}-${key}` })
    end = start - (90 + Math.floor(random() * 300)) // months between histories
  }
  return { bloodGroup, records: records.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)) }
}

/**
 * M-06 · the rest of the record for the patients on today's lists — earlier
 * visits' notes, earlier prescriptions, the appointments around today,
 * documents, problems and the encounters three of them were missing. Merged
 * into `PAST_NOTES`, `PRESCRIPTION_HISTORY`, `APPOINTMENTS` and the documents
 * by `record.ts`, and into `PROBLEMS` and `ENCOUNTERS` by `clinical.ts`, so
 * every tab reads one list.
 *
 * Each entry sits on a date the record already has — a completed visit, an
 * admission, a result — and agrees with it: Meera's dose rising with her TSH,
 * Joseph's meropenem kept on when the cultures came back sensitive, Fatima's
 * erythropoietin raised as her haemoglobin fell, Arjun's isotretinoin raised
 * once his liver tests and lipids came back in range. The first entries are in `record.ts` and `clinical.ts`.
 */

import type { Encounter, Problem } from './clinical'
import { minutesAgo, minutesAhead } from './format'
import type { Appointment, PastNote, PrescriptionRecord, RecordReport } from './record'

function on(month: number, day: number, h = 10, m = 0, year = 2026): Date {
  return new Date(year, month - 1, day, h, m)
}

export const PAST_NOTES_EXT: PastNote[] = [
  {
    id: 'PN-0103',
    patientId: 'SD-P-01',
    at: on(3, 18, 11, 0, 2025),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Tired, feels the cold, weight up 2 kg since the winter. Taking 50 mcg every morning.',
    objective: 'Pulse 68, BP 120/78, weight 61 kg. Dry skin, no goitre. TSH 5.8.',
    assessment: 'Hypothyroidism, under-replaced on 50 mcg.',
    plan: 'Increase levothyroxine to 75 mcg. Thyroid function in six months.',
  },
  {
    id: 'PN-0102',
    patientId: 'SD-P-01',
    at: on(9, 18, 11, 0, 2025),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Less tired. Taking the tablet on an empty stomach as advised.',
    objective: 'Pulse 72, BP 118/76, weight 60 kg. TSH 4.2.',
    assessment: 'Hypothyroidism, improving on 75 mcg.',
    plan: 'Continue 75 mcg. Thyroid function in six months.',
  },
  {
    id: 'PN-0402',
    patientId: 'SD-P-04',
    at: on(9, 19, 12, 45),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'Antenatal clinic',
    subjective: '32 weeks. Good fetal movements. No headache or visual change.',
    objective: 'BP 116/72, fundal height 32 cm, fetal heart 140. Glucose 2 h after 75 g: 162 mg/dL. Non-stress test reactive. Growth scan: 32 weeks by biometry.',
    assessment: 'Gestational diabetes by the DIPSI threshold, newly diagnosed. Mild anaemia on iron.',
    plan: 'Diet plan with the dietitian, capillary glucose four times a day, review in two days with the readings, then weekly. Continue iron.',
  },
  {
    id: 'PN-0602',
    patientId: 'SD-P-06',
    at: on(9, 20, 9, 30),
    by: 'Dr. Rajsrinivas',
    kind: 'Progress note',
    setting: 'Day care · Paediatrics',
    subjective: 'Fever to 38.6 overnight, drinking better, passing urine well.',
    objective: 'Temp 38.1, pulse 118, capillary refill < 2 s. NS1 negative, platelets 190, white cells 4.2.',
    assessment: 'Viral fever, improving. Dengue NS1 negative.',
    plan: 'Continue oral fluids and paracetamol. Home once afebrile for 18 hours.',
  },
  {
    id: 'PN-0702',
    patientId: 'SD-P-07',
    at: on(9, 15, 4, 10),
    by: 'Dr. Rajsrinivas',
    kind: 'Admission assessment',
    setting: 'Emergency → ICU-1',
    subjective: 'Three days of dysuria and fever, confused since the evening. Sulfa allergy.',
    objective: 'BP 78/40 after 30 mL/kg of fluid, pulse 128, temp 39.4. Lactate 5.8, white cells 24.8.',
    assessment: 'Septic shock from a urinary source, with acute kidney injury.',
    plan: 'Blood and urine cultures before antibiotics, meropenem, noradrenaline through a central line, ventilation for airway protection.',
  },
  {
    id: 'PN-0703',
    patientId: 'SD-P-07',
    at: on(9, 17, 15, 0),
    by: 'Dr. Rajsrinivas',
    kind: 'Progress note',
    setting: 'ICU-1 · Critical Care',
    subjective: 'Ventilated and sedated.',
    objective: 'Noradrenaline 0.18 mcg/kg/min, lactate 3.6 → 2.4. Urine and both blood cultures: ESBL-producing E. coli, meropenem sensitive, co-trimoxazole resistant.',
    assessment: 'ESBL E. coli urosepsis, source identified; on the right antibiotic.',
    plan: 'Continue meropenem for 10–14 days. Wean noradrenaline as tolerated.',
  },
  {
    id: 'PN-0902',
    patientId: 'SD-P-09',
    at: on(9, 19, 18, 0),
    by: 'Dialysis team',
    kind: 'Procedure note',
    setting: 'Dialysis unit · station 6',
    subjective: 'No cramps. Fistula comfortable.',
    objective: 'Pre 55.2 kg, post 54.0 kg — 1.2 L removed. BP 158/90 before, 138/80 after. Fistula thrill good.',
    assessment: 'Uneventful four-hour haemodialysis; dry weight 54.0 kg.',
    plan: 'Next session Monday 14:00. Monthly bloods taken today.',
  },
  {
    id: 'PN-1002',
    patientId: 'SD-P-10',
    at: on(8, 7, 16, 0),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · Dermatology',
    subjective: 'Two years of acne, scarring on both cheeks despite three months of doxycycline. Mood good.',
    objective: 'Inflammatory papules and some nodules on both cheeks and the jaw. Weight 69 kg. Baseline ALT 24, triglycerides 112 (28-Jul).',
    assessment: 'Moderate acne with scarring, not responding to an oral antibiotic.',
    plan: 'Stop doxycycline. Isotretinoin 20 mg daily with food; lip balm. Counselled on mood and dryness. Liver tests and lipids in five weeks.',
  },
  {
    id: 'PN-1302',
    patientId: 'SD-P-13',
    at: on(9, 21, 6, 30),
    by: 'Dr. Rajsrinivas',
    kind: 'Progress note',
    setting: 'Stroke unit · 4B-15',
    subjective: 'More drowsy overnight, per the nurse; family at the bedside.',
    objective: 'GCS 15 → 13 (E3V4M6) since midnight. Pupils equal and reactive. BP 164/92, pulse 64. MRI: right MCA territory infarct, swelling as on CT.',
    assessment: 'Large right MCA infarct with worsening mass effect, day 2.',
    plan: 'Neurosurgery review this morning for decompressive hemicraniectomy. Head up 30°, 3% saline, neurological observations hourly.',
  },
  {
    id: 'PN-1502',
    patientId: 'SD-P-15',
    at: on(3, 10, 10, 0),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Three migraines a month, each eased by sumatriptan. No aura.',
    objective: 'BP 118/76, pulse 74. Neurological examination normal. Haemoglobin 12.4.',
    assessment: 'Migraine without aura, episodic.',
    plan: 'Sumatriptan at onset, paracetamol as needed. Review in six months, or sooner if more frequent.',
  },
]

export const PRESCRIPTIONS_EXT: PrescriptionRecord[] = [
  {
    id: 'RX-0100',
    patientId: 'SD-P-01',
    at: on(3, 18, 11, 15, 2025),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [{ drug: 'Levothyroxine', dose: '75 mcg', route: 'Oral', frequency: 'Once daily, before breakfast', duration: 'Ongoing', status: 'Completed', note: 'Up from 50 mcg — TSH 5.8. Carried on by the March 2026 prescription.' }],
  },
  {
    id: 'RX-0400',
    patientId: 'SD-P-04',
    at: on(7, 20, 10, 30),
    by: 'Dr. Rajsrinivas',
    context: 'Antenatal booking visit',
    items: [
      { drug: 'Ferrous sulphate', dose: '200 mg', route: 'Oral', frequency: 'Once daily', duration: 'To delivery', status: 'Completed', note: 'Haemoglobin 10.4. Carried on at 28 weeks.' },
      { drug: 'Folic acid', dose: '5 mg', route: 'Oral', frequency: 'Once daily', duration: 'To delivery', status: 'Completed', note: 'Carried on at 28 weeks.' },
    ],
  },
  {
    id: 'RX-0702',
    patientId: 'SD-P-07',
    at: on(9, 17, 15, 15),
    by: 'Dr. Rajsrinivas',
    context: 'ICU chart — after the cultures',
    items: [
      { drug: 'Meropenem', dose: '1 g', route: 'IV', frequency: 'Every 8 hours, adjusted to kidney function', duration: '10–14 days', status: 'Active', note: 'ESBL E. coli, meropenem sensitive' },
      { drug: 'Hydrocortisone', dose: '50 mg', route: 'IV', frequency: 'Every 6 hours', duration: 'While on noradrenaline', status: 'Active' },
    ],
  },
  {
    id: 'RX-0902',
    patientId: 'SD-P-09',
    at: on(9, 19, 18, 10),
    by: 'Nephrologist',
    context: 'Dialysis unit — monthly review',
    items: [
      { drug: 'Erythropoietin', dose: '6000 IU', route: 'Subcutaneous', frequency: 'After each dialysis', duration: 'Ongoing', status: 'Active', note: 'Up from 4000 IU — haemoglobin 9.4 → 9.1' },
      { drug: 'Calcitriol', dose: '0.25 mcg', route: 'Oral', frequency: 'Once daily', duration: 'Ongoing', status: 'Active', note: 'Intact PTH 486' },
    ],
  },
  {
    id: 'RX-1002',
    patientId: 'SD-P-10',
    at: on(9, 12, 16, 20),
    by: 'Dr. Rajsrinivas',
    context: 'Teleconsult',
    items: [
      { drug: 'Isotretinoin', dose: '30 mg', route: 'Oral', frequency: 'Once daily with food', duration: 'To week 24', status: 'Active', note: 'Up from 20 mg — tolerating it, liver tests and lipids within range' },
      { drug: 'Sunscreen SPF 50', dose: 'Apply', route: 'Topical', frequency: 'Every morning', duration: 'Ongoing', status: 'Active' },
    ],
  },
  {
    id: 'RX-1500',
    patientId: 'SD-P-15',
    at: on(3, 10, 10, 20),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Sumatriptan', dose: '50 mg', route: 'Oral', frequency: 'At onset, may repeat after 2 h', duration: 'As needed', status: 'Completed', note: 'Carried on in September' },
      { drug: 'Paracetamol', dose: '1 g', route: 'Oral', frequency: 'Up to 4 times a day', duration: 'As needed', status: 'Completed' },
    ],
  },
]

export const APPOINTMENTS_RECORD_EXT: Appointment[] = [
  { id: 'AP-0400', patientId: 'SD-P-04', at: on(7, 20, 10, 0), kind: 'Follow-up', status: 'Completed', clinic: 'Antenatal clinic', with: 'Dr. Rajsrinivas', purpose: 'Antenatal booking visit' },
  { id: 'AP-0405', patientId: 'SD-P-04', at: on(9, 19, 10, 0), kind: 'Follow-up', status: 'Completed', clinic: 'Antenatal clinic', with: 'Dr. Rajsrinivas', purpose: '32-week visit, glucose tolerance test and growth scan' },
  { id: 'AP-0600', patientId: 'SD-P-06', at: on(9, 19, 11, 0), kind: 'Review', status: 'Completed', clinic: 'Paediatric day care', with: 'Dr. Rajsrinivas', purpose: 'Admitted with fever' },
  { id: 'AP-0602', patientId: 'SD-P-06', at: on(9, 21, 11, 0), kind: 'Review', status: 'Today', clinic: 'Ward 4B', with: 'Dr. Rajsrinivas', purpose: 'Discharge from day care', location: '4B-19' },
  { id: 'AP-0700', patientId: 'SD-P-07', at: on(9, 15, 3, 10), kind: 'Transfer', status: 'Completed', clinic: 'ICU-1', with: 'Critical Care', purpose: 'From Emergency to ICU' },
  { id: 'AP-0702', patientId: 'SD-P-07', at: on(9, 24, 10, 0), kind: 'Review', status: 'Booked', clinic: 'ICU-1', with: 'Nephrologist', purpose: 'Kidney recovery review' },
  { id: 'AP-1200', patientId: 'SD-P-12', at: on(9, 18, 22, 50), kind: 'Transfer', status: 'Completed', clinic: 'Stroke unit', with: 'Emergency team', purpose: 'From Emergency to the stroke unit' },
  { id: 'AP-1300', patientId: 'SD-P-13', at: on(9, 20, 18, 5), kind: 'Transfer', status: 'Completed', clinic: 'Stroke unit', with: 'Emergency team', purpose: 'From Emergency to the stroke unit' },
  { id: 'AP-1302', patientId: 'SD-P-13', at: on(9, 23, 10, 0), kind: 'Review', status: 'Booked', clinic: 'Stroke unit', with: 'Physiotherapy', purpose: 'Rehabilitation assessment', location: '4B-15' },
]

export const DOCUMENTS_EXT: RecordReport[] = [
  {
    id: 'DOC-0401',
    patientId: 'SD-P-04',
    at: on(9, 19, 11, 30),
    kind: 'Fetal monitoring',
    title: 'Non-stress test (CTG), 20 minutes',
    by: 'Antenatal clinic',
    summary: 'Reactive: baseline 140 bpm, variability 10–15 bpm, accelerations present, no decelerations.',
  },
  {
    id: 'DOC-1001',
    patientId: 'SD-P-10',
    at: on(9, 20, 19, 10),
    kind: 'Clinical photographs',
    title: 'Teleconsult photographs — face, three views',
    by: 'Uploaded by the patient',
    summary: 'Front and both sides in daylight, for today’s week-6 review. Kept in the teleconsult store; not shown in this demo.',
  },
]

export const PROBLEMS_EXT: Problem[] = [
  { id: 'PR-25', patientId: 'SD-P-01', label: 'Iron deficiency anaemia', icd10: 'D50.9', snomed: '87522002', onset: '18-Sep-2026', status: 'Open', leaf: true },
  { id: 'PR-26', patientId: 'SD-P-06', label: 'Leucopenia', icd10: 'D72.8', snomed: '84828003', onset: '20-Sep-2026', status: 'Open', leaf: true },
  { id: 'PR-27', patientId: 'SD-P-07', label: 'Urinary tract infection, ESBL-producing E. coli', icd10: 'N39.0', snomed: '68566005', onset: '15-Sep-2026', status: 'Open', leaf: true },
  { id: 'PR-28', patientId: 'SD-P-07', label: 'Acute kidney injury', icd10: 'N17.9', snomed: '14669001', onset: '15-Sep-2026', status: 'Open', leaf: true },
  { id: 'PR-29', patientId: 'SD-P-10', label: 'Cheilitis from isotretinoin', icd10: 'K13.0', snomed: '7847004', onset: 'Aug-2026', status: 'Open', leaf: true },
  { id: 'PR-30', patientId: 'SD-P-16', label: 'Abrasion of the right forearm', icd10: 'S50.8', snomed: '399963005', onset: '14-Sep-2026', status: 'Resolved', leaf: true },
]

export const ENCOUNTERS_EXT: Encounter[] = [
  { id: 'E-118395', encounterNo: 'OP/26-27/118395', patientId: 'SD-P-04', type: 'OP', startedAt: minutesAgo(48), consultantStaffId: 'SD-S-01', department: 'Obstetrics', token: 'MED-039' },
  { id: 'E-118371', encounterNo: 'IP/26-27/118371', patientId: 'SD-P-06', type: 'IP', startedAt: on(9, 19, 11, 0), consultantStaffId: 'SD-S-01', department: 'Paediatrics', ward: '4B' },
  { id: 'E-118452', encounterNo: 'OP/26-27/118452', patientId: 'SD-P-09', type: 'TELE', startedAt: minutesAhead(85), consultantStaffId: 'SD-S-01', department: 'Nephrology' },
]

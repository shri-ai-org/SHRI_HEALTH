/**
 * Seven more outpatients for today's General Medicine OPD, so the clinic list
 * reads as a real session: two walk-ins already in the waiting room, two
 * booked follow-ups later in the morning and three booked into the afternoon
 * session.
 *
 *   W-01     Thangavel Palanisamy   walked in at 08:18, new: fever and dry cough for three days
 *   W-02     Saraswathi Chinnasamy  walked in at 08:29, follow-up: diabetes and hypertension, giddy since morning
 *   MED-046  Nithya Sekar           09:20, follow-up: asthma, inhaler step-down with the September spirometry
 *   MED-047  Arumugam Velusamy      09:30, follow-up: COPD, spirometry review
 *   MED-061  Karthik Shanmugam      14:00, new: recurrent epigastric pain, H. pylori stool antigen positive
 *   MED-062  Jayanthi Ravichandran  14:20, follow-up: rheumatoid arthritis on methotrexate, liver tests
 *   MED-063  Prabhu Natarajan       14:40, follow-up: CKD stage 3a with gout
 *
 * Each one's whole record is here (the patient, today's visit and clinic row,
 * the problems, results with their series, vitals with their history, the
 * condition, earlier notes, prescriptions, appointments, imaging and
 * documents), merged into the shared lists by `kit.ts`, `clinical.ts`,
 * `vitals-history.ts`, `record.ts` and `imaging.ts`, so every screen reads one
 * list.
 *
 * Only types and the time helpers come from those files, so nothing here
 * imports a file that imports it back.
 *
 * The rules the other record files keep, kept here too:
 *   · a result's series ends on its row's own value, at its row's own time;
 *   · a vitals series ends on the snapshot, at the snapshot's time;
 *   · every result came back before today and was reviewed then, so none of
 *     them adds to the morning brief's "results changed";
 *   · a walk-in has no booking for today: the clinic row's `bookedAt` is when
 *     the front office registered them, and no appointment says "Today";
 *   · a booked patient's appointment today is at the clinic row's own time;
 *   · later bookings are with the laboratory, educators and therapists, never
 *     a slot on the doctor's own calendar;
 *   · the imaging is report-only where no open image fits the study, so none
 *     stands in; Karthik's ultrasound is backed by one that does (`us-2101`);
 *   · the notes, the medicines and the results agree with one another.
 */

import type { ClinicRow, Encounter, Problem, ResultRow } from './clinical'
import { minutesAgo } from './format'
import type { ImagingStudy } from './imaging'
import type { Patient } from './kit'
import type { Appointment, ConditionSummary, PastNote, PrescriptionRecord, RecordReport } from './record'
import type { VitalRow, VitalSeries } from './vitals-history'

function on(month: number, day: number, h = 10, m = 0, year = 2026): Date {
  return new Date(year, month - 1, day, h, m)
}

/** Today's bookings, at their clinic-row times. */
const AT_0920 = on(9, 21, 9, 20)
const AT_0930 = on(9, 21, 9, 30)
const AT_1400 = on(9, 21, 14, 0)
const AT_1420 = on(9, 21, 14, 20)
const AT_1440 = on(9, 21, 14, 40)

/** The walk-ins: registered at the front office on arrival, and seen by the triage nurse a few minutes later. */
const W01_ARRIVED = minutesAgo(22)
const W01_TRIAGE = minutesAgo(16)
const W02_ARRIVED = minutesAgo(11)
const W02_TRIAGE = minutesAgo(6)

// ───────────────────────────────────────────────────────────── The patients

export const OPD_PATIENTS: Patient[] = [
  {
    id: 'SD-P-39',
    name: 'Thangavel Palanisamy',
    nameNative: 'தங்கவேல் பழனிசாமி',
    age: 52,
    sex: 'M',
    uhid: 'ISH-0044306',
    scenario: 'OPD walk-in, new patient, fever and dry cough for 3 days',
    payer: 'Self-pay (UPI)',
    abha: null,
    abhaStatus: 'Not linked',
    allergies: [],
    bed: null,
    facilityCode: 'ISH',
    consultant: 'Dr. Rajsrinivas',
    weightKg: 74,
  },
  {
    id: 'SD-P-40',
    name: 'Saraswathi Chinnasamy',
    nameNative: 'சரஸ்வதி சின்னசாமி',
    age: 67,
    sex: 'F',
    uhid: 'ISH-0044307',
    scenario: 'OPD walk-in, diabetes and hypertension follow-up, giddiness since morning',
    payer: 'PM-JAY',
    abha: 'saraswathi.chinnasamy@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: null,
    facilityCode: 'ISH',
    consultant: 'Dr. Rajsrinivas',
    weightKg: 68,
  },
  {
    id: 'SD-P-41',
    name: 'Nithya Sekar',
    nameNative: 'நித்யா சேகர்',
    age: 34,
    sex: 'F',
    uhid: 'ISH-0044308',
    scenario: 'OPD follow-up, bronchial asthma, inhaler step-down review',
    payer: 'TPA cashless',
    abha: 'nithya.sekar@abdm',
    abhaStatus: 'Linked',
    /** Wheeze and a tight chest within an hour of aspirin for a headache, in 2019. */
    allergies: ['Aspirin'],
    bed: null,
    facilityCode: 'ISH',
    consultant: 'Dr. Rajsrinivas',
    weightKg: 58,
  },
  {
    id: 'SD-P-42',
    name: 'Arumugam Velusamy',
    nameNative: 'ஆறுமுகம் வேலுசாமி',
    age: 61,
    sex: 'M',
    uhid: 'ISH-0044309',
    scenario: 'OPD follow-up, COPD, spirometry review',
    payer: 'CGHS',
    abha: 'arumugam.velusamy@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: null,
    facilityCode: 'ISH',
    consultant: 'Dr. Rajsrinivas',
    weightKg: 61,
  },
  {
    id: 'SD-P-43',
    name: 'Karthik Shanmugam',
    nameNative: 'கார்த்திக் சண்முகம்',
    age: 28,
    sex: 'M',
    uhid: 'ISH-0044310',
    scenario: 'OPD new patient, recurrent epigastric pain',
    payer: 'ESI',
    abha: 'karthik.shanmugam@abdm',
    abhaStatus: 'Consent pending',
    allergies: [],
    bed: null,
    facilityCode: 'ISH',
    consultant: 'Dr. Rajsrinivas',
    weightKg: 64,
  },
  {
    id: 'SD-P-44',
    name: 'Jayanthi Ravichandran',
    nameNative: 'ஜெயந்தி ரவிச்சந்திரன்',
    age: 55,
    sex: 'F',
    uhid: 'ISH-0044311',
    scenario: 'OPD follow-up, rheumatoid arthritis on methotrexate',
    payer: 'Self-pay (UPI)',
    abha: 'jayanthi.ravichandran@abdm',
    abhaStatus: 'Linked',
    /** A widespread itchy rash two weeks into sulfasalazine, in 2022. */
    allergies: ['Sulfasalazine'],
    bed: null,
    facilityCode: 'ISH',
    consultant: 'Dr. Rajsrinivas',
    weightKg: 61,
  },
  {
    id: 'SD-P-45',
    name: 'Prabhu Natarajan',
    nameNative: 'பிரபு நடராஜன்',
    age: 47,
    sex: 'M',
    uhid: 'ISH-0044312',
    scenario: 'OPD follow-up, CKD stage 3a with gout',
    payer: 'PM-JAY',
    abha: 'prabhu.natarajan@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: null,
    facilityCode: 'ISH',
    consultant: 'Dr. Rajsrinivas',
    weightKg: 84,
  },
]

// ─────────────────────────────────────────────── Today's clinic and visits

export const OPD_CLINIC_EXT: ClinicRow[] = [
  // Walk-ins: registered on arrival, so booked and arrived at the same moment.
  { token: 'W-01', patientId: 'SD-P-39', bookedAt: W01_ARRIVED, arrivedAt: W01_ARRIVED, status: 'Waiting', walkIn: true, predictedWaitMin: 20, band: 'MED' },
  { token: 'W-02', patientId: 'SD-P-40', bookedAt: W02_ARRIVED, arrivedAt: W02_ARRIVED, status: 'Waiting', walkIn: true, predictedWaitMin: 30, band: 'MED' },
  // The rest of the morning session.
  { token: 'MED-046', patientId: 'SD-P-41', bookedAt: AT_0920, status: 'Not arrived', predictedWaitMin: 34, band: 'MED' },
  { token: 'MED-047', patientId: 'SD-P-42', bookedAt: AT_0930, status: 'Not arrived', predictedWaitMin: 40, band: 'MED' },
  // The afternoon session, from 14:00.
  { token: 'MED-061', patientId: 'SD-P-43', bookedAt: AT_1400, status: 'Not arrived' },
  { token: 'MED-062', patientId: 'SD-P-44', bookedAt: AT_1420, status: 'Not arrived' },
  { token: 'MED-063', patientId: 'SD-P-45', bookedAt: AT_1440, status: 'Not arrived' },
]

export const OPD_ENCOUNTERS: Encounter[] = [
  { id: 'E-118464', encounterNo: 'OP/26-27/118464', patientId: 'SD-P-39', type: 'OP', startedAt: W01_ARRIVED, consultantStaffId: 'SD-S-01', department: 'General Medicine', token: 'W-01' },
  { id: 'E-118465', encounterNo: 'OP/26-27/118465', patientId: 'SD-P-40', type: 'OP', startedAt: W02_ARRIVED, consultantStaffId: 'SD-S-01', department: 'General Medicine', token: 'W-02' },
  { id: 'E-118466', encounterNo: 'OP/26-27/118466', patientId: 'SD-P-41', type: 'OP', startedAt: AT_0920, consultantStaffId: 'SD-S-01', department: 'General Medicine', token: 'MED-046' },
  { id: 'E-118467', encounterNo: 'OP/26-27/118467', patientId: 'SD-P-42', type: 'OP', startedAt: AT_0930, consultantStaffId: 'SD-S-01', department: 'General Medicine', token: 'MED-047' },
  { id: 'E-118468', encounterNo: 'OP/26-27/118468', patientId: 'SD-P-43', type: 'OP', startedAt: AT_1400, consultantStaffId: 'SD-S-01', department: 'General Medicine', token: 'MED-061' },
  { id: 'E-118469', encounterNo: 'OP/26-27/118469', patientId: 'SD-P-44', type: 'OP', startedAt: AT_1420, consultantStaffId: 'SD-S-01', department: 'General Medicine', token: 'MED-062' },
  { id: 'E-118470', encounterNo: 'OP/26-27/118470', patientId: 'SD-P-45', type: 'OP', startedAt: AT_1440, consultantStaffId: 'SD-S-01', department: 'General Medicine', token: 'MED-063' },
]

// ─────────────────────────────────────────────────────────────── Problems

export const OPD_PROBLEMS: Problem[] = [
  { id: 'PR-37', patientId: 'SD-P-39', label: 'Acute bronchitis', icd10: 'J20.9', snomed: '10509002', onset: '18-Sep-2026', status: 'Open', leaf: true },
  { id: 'PR-38', patientId: 'SD-P-40', label: 'Type 2 diabetes with hyperglycaemia', icd10: 'E11.65', snomed: '44054006', onset: '2014', status: 'Open', leaf: true },
  { id: 'PR-39', patientId: 'SD-P-40', label: 'Essential hypertension', icd10: 'I10', snomed: '59621000', onset: '2016', status: 'Open', leaf: true },
  { id: 'PR-40', patientId: 'SD-P-41', label: 'Bronchial asthma', icd10: 'J45.9', snomed: '195967001', onset: '2015', status: 'Open', leaf: true },
  { id: 'PR-41', patientId: 'SD-P-42', label: 'Chronic obstructive pulmonary disease, GOLD 2', icd10: 'J44.9', snomed: '13645005', onset: '2021', status: 'Open', leaf: true },
  { id: 'PR-42', patientId: 'SD-P-42', label: 'COPD exacerbation, admitted on 12-Jan-2026', icd10: 'J44.1', snomed: '195951007', onset: '12-Jan-2026', status: 'Resolved', leaf: true },
  { id: 'PR-43', patientId: 'SD-P-43', label: 'Gastritis with Helicobacter pylori infection', icd10: 'K29.7', snomed: '4556007', onset: '13-Sep-2026', status: 'Open', leaf: true },
  { id: 'PR-44', patientId: 'SD-P-44', label: 'Rheumatoid arthritis, seropositive', icd10: 'M06.9', snomed: '69896004', onset: '2022', status: 'Open', leaf: true },
  { id: 'PR-45', patientId: 'SD-P-44', label: 'Mild anaemia', icd10: 'D64.9', snomed: '271737000', onset: 'Jun-2026', status: 'Open', leaf: true },
  { id: 'PR-46', patientId: 'SD-P-45', label: 'Chronic kidney disease, stage 3a', icd10: 'N18.3', snomed: '700378005', onset: '2025', status: 'Open', leaf: true },
  { id: 'PR-47', patientId: 'SD-P-45', label: 'Gout', icd10: 'M10.9', snomed: '90560007', onset: '2023', status: 'Open', leaf: true },
]

// ──────────────────────────────────────────────────────────────── Results

type Flag = ResultRow['flag']

/** A result reviewed when it came back: every one of these was, before today. */
function seen(
  id: string,
  patientId: string,
  test: string,
  value: string,
  unit: string,
  refRange: string,
  flag: Flag,
  reportedAt: Date,
  reason: string,
  extra: Partial<ResultRow> = {},
): ResultRow {
  return {
    id,
    patientId,
    test,
    value,
    unit,
    refRange,
    flag,
    reportedAt,
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Rajsrinivas',
    aiReason: reason,
    band: 'HIGH',
    ...extra,
  }
}

export const OPD_RESULTS: ResultRow[] = [
  // ── SD-P-39 · Thangavel Palanisamy, at the Emergency fever desk on Saturday night
  seen('R-93901', 'SD-P-39', 'White cell count', '11.8', '×10⁹/L', '4.0 – 11.0', '↑ High', on(9, 19, 21, 40), 'Just above range, up from 7.2 at his health check last year', { priorValue: '7.2', delta: '+4.6 since February 2025', refLow: 4, refHigh: 11 }),
  seen('R-93902', 'SD-P-39', 'C-reactive protein', '28', 'mg/L', '< 10', '↑ High', on(9, 19, 21, 40), 'Above range, as with a chest infection', { refLow: 0, refHigh: 10 }),
  seen('R-93903', 'SD-P-39', 'Haemoglobin', '14.8', 'g/dL', '13.0 – 17.0', 'Normal', on(9, 19, 21, 40), 'Within range', { priorValue: '15.1', refLow: 13, refHigh: 17 }),
  seen('R-93904', 'SD-P-39', 'Platelet count', '212', '×10⁹/L', '150 – 410', 'Normal', on(9, 19, 21, 40), 'Within range, which makes dengue less likely', { refLow: 150, refHigh: 410 }),
  seen('R-93905', 'SD-P-39', 'Dengue NS1 antigen', 'Negative', '', 'Negative', 'Normal', on(9, 19, 22, 10), 'Negative on day 2 of the fever'),
  seen('R-93906', 'SD-P-39', 'Malaria antigen, rapid test', 'Negative', '', 'Negative', 'Normal', on(9, 19, 22, 10), 'Negative'),

  // ── SD-P-40 · Saraswathi Chinnasamy, three-monthly bloods a week ago
  seen('R-94001', 'SD-P-40', 'HbA1c', '7.9', '%', '4.0 – 5.6', '↑ High', on(9, 14, 10, 30), 'Above range and above her 7.5% target, up from 7.6 in June', { priorValue: '7.6', delta: '+0.3 in 3 months', refLow: 4, refHigh: 5.6 }),
  seen('R-94002', 'SD-P-40', 'Fasting plasma glucose', '156', 'mg/dL', '70 – 100', '↑ High', on(9, 14, 10, 30), 'Above range, up from 142 in June', { priorValue: '142', refLow: 70, refHigh: 100 }),
  seen('R-94003', 'SD-P-40', 'Serum sodium', '132', 'mmol/L', '135 – 145', '↓ Low', on(9, 14, 10, 30), 'Below range, down from 138 in June, since hydrochlorothiazide was added', { priorValue: '138', delta: '−6 in 3 months', refLow: 135, refHigh: 145 }),
  seen('R-94004', 'SD-P-40', 'Serum potassium', '3.6', 'mmol/L', '3.5 – 5.1', 'Normal', on(9, 14, 10, 30), 'Within range, at the low end', { priorValue: '4.2', refLow: 3.5, refHigh: 5.1 }),
  seen('R-94005', 'SD-P-40', 'Serum creatinine', '88', 'µmol/L', '45 – 90', 'Normal', on(9, 14, 10, 30), 'Within range, so metformin can continue at full dose', { priorValue: '84', refLow: 45, refHigh: 90 }),
  seen('R-94006', 'SD-P-40', 'LDL cholesterol', '92', 'mg/dL', '< 100', 'Normal', on(9, 14, 10, 30), 'Within range on atorvastatin 10 mg', { refLow: 0, refHigh: 100 }),

  // ── SD-P-41 · Nithya Sekar, lung function on Friday for today's review
  seen('R-94101', 'SD-P-41', 'FEV1, % predicted', '88', '%', '≥ 80', 'Normal', on(9, 18, 10, 0), 'Within range, up from 85% in March and from 68% when her inhaler was stepped up in March 2025', { priorValue: '85', delta: '+3 in 6 months', refLow: 80, refHigh: 120 }),
  seen('R-94102', 'SD-P-41', 'FEV1/FVC ratio', '0.79', '', '≥ 0.70', 'Normal', on(9, 18, 10, 0), 'Within range, no fixed airflow obstruction', { priorValue: '0.78', refLow: 0.7, refHigh: 1 }),
  seen('R-94103', 'SD-P-41', 'Bronchodilator reversibility', '6', '%', '< 12', 'Normal', on(9, 18, 10, 0), 'No significant reversibility, so the airways are well controlled', { refLow: 0, refHigh: 12 }),
  seen('R-94104', 'SD-P-41', 'Blood eosinophil count', '0.28', '×10⁹/L', '0.04 – 0.40', 'Normal', on(9, 18, 9, 45), 'Within range, down from 0.62 in March 2025', { priorValue: '0.41', refLow: 0.04, refHigh: 0.4 }),
  seen('R-94105', 'SD-P-41', 'Fractional exhaled nitric oxide', '18', 'ppb', '< 25', 'Normal', on(9, 18, 10, 0), 'Within range, little airway inflammation on the current dose', { refLow: 0, refHigh: 25 }),

  // ── SD-P-42 · Arumugam Velusamy, his yearly lung function on Friday
  seen('R-94201', 'SD-P-42', 'FEV1, % predicted', '54', '%', '≥ 80', '↓ Low', on(9, 18, 11, 0), 'Below range and down from 57% a year ago, still GOLD 2', { priorValue: '57', delta: '−3 in a year', refLow: 80, refHigh: 120 }),
  seen('R-94202', 'SD-P-42', 'FEV1/FVC ratio', '0.58', '', '≥ 0.70', '↓ Low', on(9, 18, 11, 0), 'Below range: fixed airflow obstruction after the bronchodilator', { priorValue: '0.60', refLow: 0.7, refHigh: 1 }),
  seen('R-94203', 'SD-P-42', 'Six-minute walk distance', '380', 'm', '≥ 400', '↓ Low', on(9, 18, 11, 30), 'Below range, down from 410 m a year ago, lowest saturation 90%', { priorValue: '410', refLow: 400, refHigh: 700 }),
  seen('R-94204', 'SD-P-42', 'Haemoglobin', '15.6', 'g/dL', '13.0 – 17.0', 'Normal', on(9, 18, 10, 30), 'Within range, no polycythaemia', { refLow: 13, refHigh: 17 }),
  seen('R-94205', 'SD-P-42', 'Blood eosinophil count', '0.18', '×10⁹/L', '0.04 – 0.40', 'Normal', on(9, 18, 10, 30), 'Within range, below the level where an inhaled steroid would add much', { refLow: 0.04, refHigh: 0.4 }),

  // ── SD-P-43 · Karthik Shanmugam, from the Emergency visit on 13 September
  seen('R-94301', 'SD-P-43', 'H. pylori stool antigen', 'Positive', '', 'Negative', '↑ High', on(9, 15, 11, 0), 'Positive: an active Helicobacter pylori infection behind the gastritis'),
  seen('R-94302', 'SD-P-43', 'Haemoglobin', '13.9', 'g/dL', '13.0 – 17.0', 'Normal', on(9, 13, 23, 10), 'Within range, a little down from 14.6 in 2024, with no sign of bleeding', { priorValue: '14.6', refLow: 13, refHigh: 17 }),
  seen('R-94303', 'SD-P-43', 'Serum lipase', '42', 'U/L', '13 – 60', 'Normal', on(9, 13, 23, 10), 'Within range, so not pancreatitis', { refLow: 13, refHigh: 60 }),
  seen('R-94304', 'SD-P-43', 'ALT', '28', 'U/L', '7 – 56', 'Normal', on(9, 13, 23, 10), 'Within range', { priorValue: '24', refLow: 7, refHigh: 56 }),
  seen('R-94305', 'SD-P-43', 'Troponin I, high-sensitivity', '< 2', 'ng/L', '< 14', 'Normal', on(9, 13, 23, 10), 'Within range, so the pain was not from the heart'),

  // ── SD-P-44 · Jayanthi Ravichandran, methotrexate monitoring on Friday
  seen('R-94401', 'SD-P-44', 'ALT', '48', 'U/L', '7 – 35', '↑ High', on(9, 18, 11, 0), 'Above range and rising on methotrexate 15 mg weekly, up from 34 in June, under twice the upper limit', { priorValue: '34', delta: '+14 in 3 months', refLow: 7, refHigh: 35 }),
  seen('R-94402', 'SD-P-44', 'AST', '31', 'U/L', '8 – 33', 'Normal', on(9, 18, 11, 0), 'Within range, at the upper end', { priorValue: '27', refLow: 8, refHigh: 33 }),
  seen('R-94403', 'SD-P-44', 'Haemoglobin', '11.4', 'g/dL', '12.0 – 15.5', '↓ Low', on(9, 18, 11, 0), 'Below range, down from 11.6 in June', { priorValue: '11.6', refLow: 12, refHigh: 15.5 }),
  seen('R-94404', 'SD-P-44', 'White cell count', '5.6', '×10⁹/L', '4.0 – 11.0', 'Normal', on(9, 18, 11, 0), 'Within range, drifting down on methotrexate', { priorValue: '6.1', refLow: 4, refHigh: 11 }),
  seen('R-94405', 'SD-P-44', 'Platelet count', '236', '×10⁹/L', '150 – 410', 'Normal', on(9, 18, 11, 0), 'Within range', { refLow: 150, refHigh: 410 }),
  seen('R-94406', 'SD-P-44', 'ESR', '28', 'mm/h', '< 20', '↑ High', on(9, 18, 11, 0), 'Above range, but down from 52 at the January flare', { priorValue: '30', refLow: 0, refHigh: 20 }),
  seen('R-94407', 'SD-P-44', 'Serum creatinine', '64', 'µmol/L', '45 – 90', 'Normal', on(9, 18, 11, 0), 'Within range, so the methotrexate dose need not change for the kidneys', { refLow: 45, refHigh: 90 }),

  // ── SD-P-45 · Prabhu Natarajan, kidney bloods on Thursday
  seen('R-94501', 'SD-P-45', 'Serum creatinine', '142', 'µmol/L', '62 – 106', '↑ High', on(9, 17, 11, 0), 'Above range and up from 138 in May, a slow rise over a year', { priorValue: '138', delta: '+4 in 4 months', refLow: 62, refHigh: 106 }),
  seen('R-94502', 'SD-P-45', 'eGFR', '52', 'mL/min/1.73 m²', '≥ 90', '↓ Low', on(9, 17, 11, 0), 'Below range, still stage 3a, down from 54 in May', { priorValue: '54', refLow: 90, refHigh: 130 }),
  seen('R-94503', 'SD-P-45', 'Serum uric acid', '7.4', 'mg/dL', '3.4 – 7.0', '↑ High', on(9, 17, 11, 0), 'Above range and above his 6.0 target, though down from 9.8 before febuxostat', { priorValue: '8.1', delta: '−0.7 in 4 months', refLow: 3.4, refHigh: 7 }),
  seen('R-94504', 'SD-P-45', 'Serum potassium', '4.9', 'mmol/L', '3.5 – 5.1', 'Normal', on(9, 17, 11, 0), 'Within range on telmisartan, at the upper end', { priorValue: '4.7', refLow: 3.5, refHigh: 5.1 }),
  seen('R-94505', 'SD-P-45', 'Urine albumin-creatinine ratio', '64', 'mg/g', '< 30', '↑ High', on(9, 17, 11, 0), 'Above range, but down from 82 in January on telmisartan', { priorValue: '82', refLow: 0, refHigh: 30 }),
  seen('R-94506', 'SD-P-45', 'Haemoglobin', '13.4', 'g/dL', '13.0 – 17.0', 'Normal', on(9, 17, 11, 0), 'Within range, no anaemia from the kidneys yet', { refLow: 13, refHigh: 17 }),
]

/** The series behind the results above, each ending on its row's value and time. */
export const OPD_RESULT_TRENDS: Record<string, { at: Date; value: number }[]> = {
  // SD-P-39: a normal count at his health check, raised with the infection
  'R-93901': [
    { at: on(2, 8, 9, 30, 2025), value: 7.2 },
    { at: on(9, 19, 21, 40), value: 11.8 },
  ],
  'R-93903': [
    { at: on(2, 8, 9, 30, 2025), value: 15.1 },
    { at: on(9, 19, 21, 40), value: 14.8 },
  ],
  // SD-P-40: HbA1c climbing, and the sodium falling since the thiazide
  'R-94001': [
    { at: on(9, 13, 10, 30, 2025), value: 7.1 },
    { at: on(3, 14, 10, 30), value: 7.4 },
    { at: on(6, 13, 10, 30), value: 7.6 },
    { at: on(9, 14, 10, 30), value: 7.9 },
  ],
  'R-94002': [
    { at: on(3, 14, 10, 30), value: 138 },
    { at: on(6, 13, 10, 30), value: 142 },
    { at: on(9, 14, 10, 30), value: 156 },
  ],
  'R-94003': [
    { at: on(9, 13, 10, 30, 2025), value: 139 },
    { at: on(3, 14, 10, 30), value: 139 },
    { at: on(6, 13, 10, 30), value: 138 },
    { at: on(9, 14, 10, 30), value: 132 },
  ],
  'R-94004': [
    { at: on(3, 14, 10, 30), value: 4.4 },
    { at: on(6, 13, 10, 30), value: 4.2 },
    { at: on(9, 14, 10, 30), value: 3.6 },
  ],
  // SD-P-41: lung function recovering since the step-up, and the eosinophils settling
  'R-94101': [
    { at: on(3, 10, 10, 0, 2025), value: 68 },
    { at: on(9, 12, 10, 0, 2025), value: 79 },
    { at: on(3, 13, 10, 0), value: 85 },
    { at: on(9, 18, 10, 0), value: 88 },
  ],
  'R-94102': [
    { at: on(3, 10, 10, 0, 2025), value: 0.68 },
    { at: on(9, 12, 10, 0, 2025), value: 0.74 },
    { at: on(3, 13, 10, 0), value: 0.78 },
    { at: on(9, 18, 10, 0), value: 0.79 },
  ],
  'R-94104': [
    { at: on(3, 10, 9, 45, 2025), value: 0.62 },
    { at: on(3, 13, 9, 45), value: 0.41 },
    { at: on(9, 18, 9, 45), value: 0.28 },
  ],
  // SD-P-42: a slow yearly decline
  'R-94201': [
    { at: on(9, 16, 11, 0, 2024), value: 60 },
    { at: on(9, 12, 11, 0, 2025), value: 57 },
    { at: on(9, 18, 11, 0), value: 54 },
  ],
  'R-94202': [
    { at: on(9, 16, 11, 0, 2024), value: 0.62 },
    { at: on(9, 12, 11, 0, 2025), value: 0.6 },
    { at: on(9, 18, 11, 0), value: 0.58 },
  ],
  'R-94203': [
    { at: on(9, 12, 11, 30, 2025), value: 410 },
    { at: on(9, 18, 11, 30), value: 380 },
  ],
  // SD-P-43: his pre-employment check, then the Emergency visit
  'R-94302': [
    { at: on(6, 10, 9, 30, 2024), value: 14.6 },
    { at: on(9, 13, 23, 10), value: 13.9 },
  ],
  'R-94304': [
    { at: on(6, 10, 9, 30, 2024), value: 24 },
    { at: on(9, 13, 23, 10), value: 28 },
  ],
  // SD-P-44: the liver test rising and the ESR settling on methotrexate
  'R-94401': [
    { at: on(1, 10, 11, 0), value: 24 },
    { at: on(3, 14, 11, 0), value: 28 },
    { at: on(6, 13, 11, 0), value: 34 },
    { at: on(9, 18, 11, 0), value: 48 },
  ],
  'R-94403': [
    { at: on(1, 10, 11, 0), value: 12.2 },
    { at: on(3, 14, 11, 0), value: 11.9 },
    { at: on(6, 13, 11, 0), value: 11.6 },
    { at: on(9, 18, 11, 0), value: 11.4 },
  ],
  'R-94404': [
    { at: on(3, 14, 11, 0), value: 6.8 },
    { at: on(6, 13, 11, 0), value: 6.1 },
    { at: on(9, 18, 11, 0), value: 5.6 },
  ],
  'R-94406': [
    { at: on(1, 10, 11, 0), value: 52 },
    { at: on(3, 14, 11, 0), value: 36 },
    { at: on(6, 13, 11, 0), value: 30 },
    { at: on(9, 18, 11, 0), value: 28 },
  ],
  // SD-P-45: kidney function slowly falling, uric acid coming down on febuxostat
  'R-94501': [
    { at: on(9, 15, 11, 0, 2025), value: 128 },
    { at: on(1, 12, 11, 0), value: 134 },
    { at: on(5, 18, 11, 0), value: 138 },
    { at: on(9, 17, 11, 0), value: 142 },
  ],
  'R-94502': [
    { at: on(9, 15, 11, 0, 2025), value: 58 },
    { at: on(1, 12, 11, 0), value: 56 },
    { at: on(5, 18, 11, 0), value: 54 },
    { at: on(9, 17, 11, 0), value: 52 },
  ],
  'R-94503': [
    { at: on(1, 12, 11, 0), value: 9.8 },
    { at: on(5, 18, 11, 0), value: 8.1 },
    { at: on(9, 17, 11, 0), value: 7.4 },
  ],
  'R-94505': [
    { at: on(1, 12, 11, 0), value: 82 },
    { at: on(5, 18, 11, 0), value: 70 },
    { at: on(9, 17, 11, 0), value: 64 },
  ],
}

// ──────────────────────────────────────────────────────────────── Vitals

const BP = { label: 'BP', unit: 'mmHg systolic', low: 90, high: 140 }
const PULSE = { label: 'Pulse', unit: 'bpm', low: 60, high: 100 }
const SPO2 = { label: 'SpO₂', unit: '%', low: 94, high: 100 }
const TEMP = { label: 'Temperature', unit: '°C', low: 36.1, high: 37.9 }
const RR = { label: 'Respiratory rate', unit: '/min', low: 12, high: 20 }
const WEIGHT = { label: 'Weight', unit: 'kg' }
const PEAK_FLOW = { label: 'Peak flow', unit: 'L/min', low: 380, high: 520 }

/** The walk-ins by the triage nurse this morning; the others at their last visit to the hospital. */
export const OPD_VITALS: Record<string, VitalRow[]> = {
  // Thangavel: at triage, a few minutes after he walked in
  'SD-P-39': [
    { label: 'Temperature', value: '38.4 °C', flag: '↑ High', at: W01_TRIAGE },
    { label: 'Pulse', value: '98 bpm', flag: 'Normal', at: W01_TRIAGE },
    { label: 'BP', value: '128/80 mmHg', flag: 'Normal', at: W01_TRIAGE },
    { label: 'SpO₂', value: '96% on air', flag: 'Normal', at: W01_TRIAGE },
    { label: 'Respiratory rate', value: '20 /min', flag: 'Normal', at: W01_TRIAGE },
    { label: 'Weight', value: '74 kg', flag: 'Normal', at: W01_TRIAGE },
  ],
  // Saraswathi: at triage, giddy, with the pressure the pharmacy found
  'SD-P-40': [
    { label: 'BP', value: '172/98 mmHg', flag: '↑ High', at: W02_TRIAGE },
    { label: 'Pulse', value: '84 bpm', flag: 'Normal', at: W02_TRIAGE },
    { label: 'SpO₂', value: '98% on air', flag: 'Normal', at: W02_TRIAGE },
    { label: 'Temperature', value: '36.7 °C', flag: 'Normal', at: W02_TRIAGE },
    { label: 'Weight', value: '68 kg', flag: 'Normal', at: W02_TRIAGE },
    { label: 'BMI', value: '28.3 kg/m²', flag: '↑ High', at: W02_TRIAGE },
  ],
  // Nithya: in the lung function laboratory on Friday
  'SD-P-41': [
    { label: 'Peak flow', value: '420 L/min', flag: 'Normal', at: on(9, 18, 9, 40) },
    { label: 'SpO₂', value: '99% on air', flag: 'Normal', at: on(9, 18, 9, 40) },
    { label: 'Respiratory rate', value: '14 /min', flag: 'Normal', at: on(9, 18, 9, 40) },
    { label: 'Pulse', value: '76 bpm', flag: 'Normal', at: on(9, 18, 9, 40) },
    { label: 'BP', value: '114/72 mmHg', flag: 'Normal', at: on(9, 18, 9, 40) },
    { label: 'Weight', value: '58 kg', flag: 'Normal', at: on(9, 18, 9, 40) },
  ],
  // Arumugam: in the lung function laboratory on Friday
  'SD-P-42': [
    { label: 'SpO₂', value: '94% on air', flag: 'Normal', at: on(9, 18, 10, 10) },
    { label: 'Respiratory rate', value: '20 /min', flag: 'Normal', at: on(9, 18, 10, 10) },
    { label: 'Pulse', value: '88 bpm', flag: 'Normal', at: on(9, 18, 10, 10) },
    { label: 'BP', value: '136/84 mmHg', flag: 'Normal', at: on(9, 18, 10, 10) },
    { label: 'Weight', value: '61 kg', flag: 'Normal', at: on(9, 18, 10, 10) },
    { label: 'BMI', value: '22.4 kg/m²', flag: 'Normal', at: on(9, 18, 10, 10) },
  ],
  // Karthik: in the Emergency department on 13 September
  'SD-P-43': [
    { label: 'BP', value: '126/78 mmHg', flag: 'Normal', at: on(9, 13, 22, 20) },
    { label: 'Pulse', value: '92 bpm', flag: 'Normal', at: on(9, 13, 22, 20) },
    { label: 'Temperature', value: '36.9 °C', flag: 'Normal', at: on(9, 13, 22, 20) },
    { label: 'SpO₂', value: '99% on air', flag: 'Normal', at: on(9, 13, 22, 20) },
    { label: 'Weight', value: '64 kg', flag: 'Normal', at: on(9, 13, 22, 20) },
    { label: 'BMI', value: '21.6 kg/m²', flag: 'Normal', at: on(9, 13, 22, 20) },
  ],
  // Jayanthi: by the nurse when her bloods were drawn on Friday
  'SD-P-44': [
    { label: 'BP', value: '124/78 mmHg', flag: 'Normal', at: on(9, 18, 10, 50) },
    { label: 'Pulse', value: '80 bpm', flag: 'Normal', at: on(9, 18, 10, 50) },
    { label: 'Weight', value: '61 kg', flag: 'Normal', at: on(9, 18, 10, 50) },
    { label: 'BMI', value: '25.4 kg/m²', flag: '↑ High', at: on(9, 18, 10, 50) },
    { label: 'Temperature', value: '36.6 °C', flag: 'Normal', at: on(9, 18, 10, 50) },
  ],
  // Prabhu: by the nurse when his bloods were drawn on Thursday
  'SD-P-45': [
    { label: 'BP', value: '138/88 mmHg', flag: 'Normal', at: on(9, 17, 10, 50) },
    { label: 'Pulse', value: '74 bpm', flag: 'Normal', at: on(9, 17, 10, 50) },
    { label: 'Weight', value: '84 kg', flag: 'Normal', at: on(9, 17, 10, 50) },
    { label: 'BMI', value: '28.4 kg/m²', flag: '↑ High', at: on(9, 17, 10, 50) },
    { label: 'Temperature', value: '36.6 °C', flag: 'Normal', at: on(9, 17, 10, 50) },
  ],
}

export const OPD_VITALS_HISTORY: Record<string, VitalSeries[]> = {
  'SD-P-39': [
    {
      ...TEMP,
      points: [
        { at: on(2, 8, 9, 20, 2025), value: 36.7 },
        { at: on(9, 19, 21, 20), value: 38.6 },
        { at: W01_TRIAGE, value: 38.4 },
      ],
    },
    {
      ...PULSE,
      points: [
        { at: on(2, 8, 9, 20, 2025), value: 76 },
        { at: on(9, 19, 21, 20), value: 104 },
        { at: W01_TRIAGE, value: 98 },
      ],
    },
    {
      ...SPO2,
      points: [
        { at: on(9, 19, 21, 20), value: 97 },
        { at: W01_TRIAGE, value: 96 },
      ],
    },
    {
      ...WEIGHT,
      points: [
        { at: on(2, 8, 9, 20, 2025), value: 75 },
        { at: W01_TRIAGE, value: 74 },
      ],
    },
  ],
  'SD-P-40': [
    {
      ...BP,
      points: [
        { at: on(9, 15, 10, 0, 2025), value: 146 },
        { at: on(3, 16, 10, 0), value: 148 },
        { at: on(6, 15, 10, 0), value: 152 },
        { at: W02_TRIAGE, value: 172 },
      ],
    },
    {
      ...WEIGHT,
      points: [
        { at: on(9, 15, 10, 0, 2025), value: 70 },
        { at: on(3, 16, 10, 0), value: 69 },
        { at: on(6, 15, 10, 0), value: 68.5 },
        { at: W02_TRIAGE, value: 68 },
      ],
    },
    {
      ...PULSE,
      points: [
        { at: on(3, 16, 10, 0), value: 78 },
        { at: on(6, 15, 10, 0), value: 80 },
        { at: W02_TRIAGE, value: 84 },
      ],
    },
  ],
  'SD-P-41': [
    {
      ...PEAK_FLOW,
      points: [
        { at: on(3, 10, 9, 40, 2025), value: 290 },
        { at: on(9, 15, 9, 40, 2025), value: 360 },
        { at: on(3, 16, 9, 40), value: 400 },
        { at: on(9, 18, 9, 40), value: 420 },
      ],
    },
    {
      ...SPO2,
      points: [
        { at: on(3, 10, 9, 40, 2025), value: 96 },
        { at: on(9, 15, 9, 40, 2025), value: 98 },
        { at: on(3, 16, 9, 40), value: 99 },
        { at: on(9, 18, 9, 40), value: 99 },
      ],
    },
    {
      ...WEIGHT,
      points: [
        { at: on(9, 15, 9, 40, 2025), value: 57 },
        { at: on(3, 16, 9, 40), value: 57.5 },
        { at: on(9, 18, 9, 40), value: 58 },
      ],
    },
  ],
  'SD-P-42': [
    {
      ...SPO2,
      points: [
        { at: on(9, 12, 10, 10, 2025), value: 95 },
        { at: on(1, 12, 6, 30), value: 88 },
        { at: on(1, 16, 9, 0), value: 93 },
        { at: on(4, 20, 10, 0), value: 95 },
        { at: on(9, 18, 10, 10), value: 94 },
      ],
    },
    {
      ...RR,
      points: [
        { at: on(1, 12, 6, 30), value: 28 },
        { at: on(1, 16, 9, 0), value: 20 },
        { at: on(4, 20, 10, 0), value: 18 },
        { at: on(9, 18, 10, 10), value: 20 },
      ],
    },
    {
      ...WEIGHT,
      points: [
        { at: on(9, 12, 10, 10, 2025), value: 63 },
        { at: on(4, 20, 10, 0), value: 61.5 },
        { at: on(9, 18, 10, 10), value: 61 },
      ],
    },
  ],
  'SD-P-43': [
    {
      ...PULSE,
      points: [
        { at: on(6, 10, 9, 20, 2024), value: 72 },
        { at: on(9, 13, 22, 20), value: 92 },
      ],
    },
    {
      ...BP,
      points: [
        { at: on(6, 10, 9, 20, 2024), value: 118 },
        { at: on(9, 13, 22, 20), value: 126 },
      ],
    },
    {
      ...WEIGHT,
      points: [
        { at: on(6, 10, 9, 20, 2024), value: 65 },
        { at: on(9, 13, 22, 20), value: 64 },
      ],
    },
  ],
  'SD-P-44': [
    {
      ...WEIGHT,
      points: [
        { at: on(1, 10, 10, 30), value: 62.5 },
        { at: on(3, 16, 10, 30), value: 62 },
        { at: on(6, 15, 10, 30), value: 61.5 },
        { at: on(9, 18, 10, 50), value: 61 },
      ],
    },
    {
      ...BP,
      points: [
        { at: on(1, 10, 10, 30), value: 128 },
        { at: on(3, 16, 10, 30), value: 126 },
        { at: on(6, 15, 10, 30), value: 122 },
        { at: on(9, 18, 10, 50), value: 124 },
      ],
    },
  ],
  'SD-P-45': [
    {
      ...BP,
      points: [
        { at: on(9, 15, 10, 30, 2025), value: 148 },
        { at: on(1, 12, 10, 30), value: 146 },
        { at: on(5, 18, 10, 30), value: 140 },
        { at: on(9, 17, 10, 50), value: 138 },
      ],
    },
    {
      ...WEIGHT,
      points: [
        { at: on(9, 15, 10, 30, 2025), value: 87 },
        { at: on(1, 12, 10, 30), value: 86 },
        { at: on(5, 18, 10, 30), value: 85 },
        { at: on(9, 17, 10, 50), value: 84 },
      ],
    },
  ],
}

// ───────────────────────────────────────────────────────────── Condition

export const OPD_CONDITIONS: ConditionSummary[] = [
  {
    patientId: 'SD-P-39',
    status: 'Stable',
    headline: 'Fever and dry cough for three days, most likely acute bronchitis, with a clear chest X-ray',
    summary:
      'He was seen at the Emergency fever desk on Saturday night. His white cells and CRP were mildly raised, dengue and malaria tests were negative and the chest X-ray showed no pneumonia. He went home on paracetamol and has walked in today because the fever has not settled.',
    watch: ['Fever on day 4, 38.4 °C at triage', 'Oxygen saturation, 96% on air today', 'Breathlessness or chest pain, which would mean a repeat chest X-ray'],
    updatedAt: on(9, 19, 22, 30),
    updatedBy: 'Emergency team',
    ai: {
      text: 'A chest infection without pneumonia so far. A fever into day 4 is the reason to examine him again today.',
      drivers: ['White cells 11.8 ×10⁹/L and CRP 28 mg/L', 'Chest X-ray with no consolidation', 'Platelets 212 ×10⁹/L and dengue NS1 negative'],
      band: 'MED',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-40',
    status: 'Stable',
    headline: 'Type 2 diabetes above target and hypertension on telmisartan with hydrochlorothiazide',
    summary:
      'Her HbA1c has risen at each check this year, to 7.9%, and glimepiride was added in June. Hydrochlorothiazide was added in June for her blood pressure, and her sodium has fallen from 138 to 132 since then. Her kidney function is normal.',
    watch: ['Sodium 132 mmol/L since hydrochlorothiazide was started', 'Low sugars on glimepiride, at her age', 'HbA1c 7.9%, against her target of 7.5%'],
    updatedAt: on(9, 14, 12, 0),
    updatedBy: 'Dr. Rajsrinivas',
    ai: {
      text: 'Giddiness today, with a triage blood pressure of 172/98, on a falling sodium and a new sulphonylurea. Check her capillary glucose and sodium before anything else.',
      drivers: ['BP 172/98 at triage today', 'Sodium 138 → 132 mmol/L since June', 'Glimepiride 1 mg started in June'],
      band: 'MED',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-41',
    status: 'Improving',
    headline: 'Bronchial asthma, well controlled for over a year on budesonide-formoterol',
    summary:
      'Her asthma was stepped up in March 2025 after an attack and has been controlled since then, with no night waking and no oral steroids. Her September lung function is normal and her airway inflammation is low. She is allergic to aspirin.',
    watch: ['Asthma control after any step-down', 'Peak flow, now 420 L/min at her best', 'No aspirin or other NSAIDs'],
    updatedAt: on(9, 18, 12, 0),
    updatedBy: 'Dr. Rajsrinivas',
    ai: {
      text: 'Over a year of control and normal lung function make a step-down reasonable today.',
      drivers: ['FEV1 68 → 88% predicted since March 2025', 'FeNO 18 ppb', 'Eosinophils 0.62 → 0.28 ×10⁹/L'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-42',
    status: 'Stable',
    headline: 'COPD, GOLD 2, on glycopyrronium with formoterol, one admission this year',
    summary:
      'He smoked for 30 years and stopped in 2021. He was admitted in January with an exacerbation and has had none since. His lung function has fallen a little over the year and he walks less far than last year.',
    watch: ['FEV1 54% predicted, down 3 points in a year', 'Six-minute walk 380 m, with saturation down to 90%', 'Pulmonary rehabilitation and the flu vaccine before winter'],
    updatedAt: on(9, 18, 12, 30),
    updatedBy: 'Dr. Rajsrinivas',
    ai: {
      text: 'A slow decline with one exacerbation this year. Rehabilitation matters more than another inhaler.',
      drivers: ['FEV1 60 → 54% predicted over two years', 'Admitted 12 January with an exacerbation', 'Eosinophils 0.18 ×10⁹/L'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-43',
    status: 'Stable',
    headline: 'Recurrent epigastric pain with a positive H. pylori stool antigen',
    summary:
      'He has had burning pain in the upper abdomen on and off for three months, worse when he is hungry. He came to Emergency on 13 September with a bad attack. His heart, pancreas and liver blood tests were normal, the ultrasound showed only a fatty liver and the stool antigen came back positive. He is on pantoprazole and is better.',
    watch: ['Alarm features: vomiting, black stools, weight loss or difficulty swallowing', 'Eradication therapy, then a test of cure', 'Fatty liver on the ultrasound, with a normal ALT'],
    updatedAt: on(9, 15, 12, 0),
    updatedBy: 'Dr. Rajsrinivas',
    ai: {
      text: 'H. pylori gastritis with no alarm features. Eradication therapy is the item for today.',
      drivers: ['H. pylori stool antigen positive', 'Ultrasound: fatty liver, gallbladder normal', 'Lipase and troponin normal'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-44',
    status: 'Stable',
    headline: 'Seropositive rheumatoid arthritis, in low activity on methotrexate and hydroxychloroquine',
    summary:
      'Her January flare has settled since methotrexate went up to 15 mg weekly, and her ESR has come down. Her ALT has risen at each check since then, to 48, and her haemoglobin has drifted down. She is allergic to sulfasalazine.',
    watch: ['ALT 48 U/L, rising on methotrexate', 'Haemoglobin 11.4 g/dL', 'Yearly eye screening on hydroxychloroquine'],
    updatedAt: on(9, 18, 12, 0),
    updatedBy: 'Dr. Rajsrinivas',
    ai: {
      text: 'The joints are controlled, but the liver test is rising. The methotrexate dose and alcohol are the questions for today.',
      drivers: ['ALT 24 → 48 U/L in eight months', 'ESR 52 → 28 mm/h', 'White cells 6.8 → 5.6 ×10⁹/L'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-45',
    status: 'Stable',
    headline: 'Chronic kidney disease stage 3a with gout, on febuxostat and telmisartan',
    summary:
      'His kidney function has fallen slowly over a year, to an eGFR of 52. Albumin in the urine has come down on telmisartan. His uric acid has come down on febuxostat but is not yet at target, and he has had no gout attack since January.',
    watch: ['eGFR 52, down 6 in a year', 'Uric acid 7.4 mg/dL, against a target below 6.0', 'Potassium 4.9 mmol/L on telmisartan', 'No NSAIDs for gout pain'],
    updatedAt: on(9, 17, 12, 0),
    updatedBy: 'Dr. Rajsrinivas',
    ai: {
      text: 'A slow decline in kidney function and a uric acid still above target. The febuxostat dose can go up today.',
      drivers: ['eGFR 58 → 52 over a year', 'Uric acid 9.8 → 7.4 mg/dL on febuxostat 40 mg', 'Urine albumin 82 → 64 mg/g'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
]

// ─────────────────────────────────────────────────────────── Earlier notes

export const OPD_PAST_NOTES: PastNote[] = [
  // SD-P-39 · Thangavel Palanisamy
  {
    id: 'PN-3901',
    patientId: 'SD-P-39',
    at: on(2, 8, 10, 30, 2025),
    by: 'Health check physician',
    kind: 'Consultation',
    setting: 'Preventive health check',
    subjective: 'A yearly check arranged by his employer. He supervises a transport depot. He has never smoked and drinks rarely. No complaints.',
    objective: 'BP 132/84, pulse 76, weight 75 kg, BMI 26.0. Chest clear. Fasting glucose 98 mg/dL, HbA1c 5.6%, white cells 7.2, haemoglobin 15.1.',
    assessment: 'Well. Overweight, with blood pressure at the upper limit of normal.',
    plan: 'Walk 30 minutes a day and eat less salt. Repeat the health check in a year.',
  },
  {
    id: 'PN-3902',
    patientId: 'SD-P-39',
    at: on(9, 19, 22, 20),
    by: 'Emergency team',
    kind: 'Emergency note',
    setting: 'Emergency · Fever desk',
    subjective: 'Fever with chills since yesterday and a dry cough. Body aches. No breathlessness, chest pain, rash or bleeding. No travel. Two people at his depot have had a similar illness.',
    objective: 'Temp 38.6, pulse 104, BP 130/82, SpO₂ 97% on air, respiratory rate 20. Scattered wheeze at both bases. White cells 11.8, CRP 28, platelets 212. Dengue NS1 and malaria antigen negative. Chest X-ray: no consolidation.',
    assessment: 'Acute febrile illness with cough, most likely acute bronchitis. No pneumonia.',
    plan: 'Paracetamol for fever, plenty of fluids and rest. No antibiotic for now. Come to the General Medicine OPD if the fever lasts beyond day 4, or at once with breathlessness.',
  },
  // SD-P-40 · Saraswathi Chinnasamy
  {
    id: 'PN-4001',
    patientId: 'SD-P-40',
    at: on(3, 16, 10, 15),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Feels well. Takes her medicines regularly with her daughter’s help. Walks to the temple each evening.',
    objective: 'BP 148/88, pulse 78, weight 69 kg. Feet: sensation and pulses normal. HbA1c 7.4%, sodium 139, creatinine 82.',
    assessment: 'Type 2 diabetes just above target. Hypertension above target on telmisartan 40 mg.',
    plan: 'Continue metformin and telmisartan. Less salt, and a home blood pressure log. Retinal photographs today. Bloods in three months.',
  },
  {
    id: 'PN-4002',
    patientId: 'SD-P-40',
    at: on(6, 15, 10, 15),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Her home readings are 150 to 160 systolic. No chest pain or breathlessness. No low sugars.',
    objective: 'BP 152/90, pulse 80, weight 68.5 kg. HbA1c 7.6%, fasting glucose 142 mg/dL, sodium 138, potassium 4.2.',
    assessment: 'Hypertension and type 2 diabetes, both above target.',
    plan: 'Change telmisartan to telmisartan with hydrochlorothiazide 40/12.5 mg. Add glimepiride 1 mg before breakfast and explain low sugars to her and her daughter. Sodium, potassium and HbA1c in three months.',
  },
  // SD-P-41 · Nithya Sekar
  {
    id: 'PN-4101',
    patientId: 'SD-P-41',
    at: on(3, 10, 11, 0, 2025),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Admitted overnight on 2 March with an asthma attack after a cold, and finishing her prednisolone. Before that, a month of wheeze and night cough, using her salbutamol inhaler four times a day and woken most nights.',
    objective: 'Peak flow 290 L/min, SpO₂ 96%. Widespread wheeze. FEV1 68% predicted with 18% reversibility. Eosinophils 0.62.',
    assessment: 'Bronchial asthma, uncontrolled, after a viral trigger.',
    plan: 'Step up to budesonide-formoterol 400/12 mcg, one inhalation twice daily and as a reliever. Add montelukast. An asthma action plan was written with her. Review in six months with spirometry.',
  },
  {
    id: 'PN-4102',
    patientId: 'SD-P-41',
    at: on(9, 15, 11, 0, 2025),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'No night waking since April. Uses the reliever puff once or twice a week. Asthma Control Test score 22.',
    objective: 'Peak flow 360 L/min, chest clear. FEV1 79% predicted.',
    assessment: 'Bronchial asthma, well controlled on step 4.',
    plan: 'Step down to budesonide-formoterol 200/6 mcg, one inhalation twice daily and as a reliever. Continue montelukast. Review in six months.',
  },
  {
    id: 'PN-4103',
    patientId: 'SD-P-41',
    at: on(3, 16, 11, 0),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Still well on the lower dose. No attacks, no steroid courses and no time off work. Asthma Control Test score 24.',
    objective: 'Peak flow 400 L/min, chest clear. FEV1 85% predicted, eosinophils 0.41.',
    assessment: 'Bronchial asthma, controlled for a year.',
    plan: 'Continue the same for six more months. Spirometry and FeNO in September, then consider stopping montelukast and a further step-down.',
  },
  // SD-P-42 · Arumugam Velusamy
  {
    id: 'PN-4201',
    patientId: 'SD-P-42',
    at: on(1, 12, 6, 40),
    by: 'Emergency team',
    kind: 'Emergency note',
    setting: 'Emergency',
    subjective: 'Three days of more breathlessness and cough with green sputum after a cold. Breathless walking to the bathroom. Stopped smoking in 2021 after 30 years.',
    objective: 'SpO₂ 88% on air, respiratory rate 28, pulse 104, temp 37.8. Wheeze throughout. Chest X-ray: hyperinflated, no consolidation. Blood gas: no carbon dioxide retention.',
    assessment: 'Exacerbation of COPD with a chest infection.',
    plan: 'Controlled oxygen to 88–92%, nebulised salbutamol and ipratropium, prednisolone 30 mg and co-amoxiclav. Admit to the ward.',
  },
  {
    id: 'PN-4202',
    patientId: 'SD-P-42',
    at: on(1, 16, 11, 0),
    by: 'Dr. Rajsrinivas',
    kind: 'Discharge summary',
    setting: 'Ward 4B · General Medicine',
    subjective: 'Breathing back to his usual. Walking on the ward without oxygen.',
    objective: 'SpO₂ 93% on air, respiratory rate 20. Inhaler technique checked and corrected.',
    assessment: 'COPD exacerbation, recovered.',
    plan: 'Finish the five days of prednisolone and co-amoxiclav. Start glycopyrronium with formoterol twice daily. Salbutamol as needed. Review in OPD in three months, then yearly spirometry.',
  },
  {
    id: 'PN-4203',
    patientId: 'SD-P-42',
    at: on(4, 20, 10, 30),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'No further attacks. Breathless after one flight of stairs. Uses the salbutamol two or three times a week.',
    objective: 'SpO₂ 95%, respiratory rate 18, weight 61.5 kg. Prolonged expiration, no wheeze.',
    assessment: 'COPD, GOLD 2, stable since the January exacerbation.',
    plan: 'Continue glycopyrronium with formoterol. Spirometry and a six-minute walk in September. Flu vaccine in October.',
  },
  // SD-P-43 · Karthik Shanmugam
  {
    id: 'PN-4301',
    patientId: 'SD-P-43',
    at: on(6, 10, 10, 0, 2024),
    by: 'Health check physician',
    kind: 'Consultation',
    setting: 'Pre-employment health check',
    subjective: 'Joining a textile mill as a machine operator. No illnesses. Does not smoke or drink.',
    objective: 'BP 118/76, pulse 72, weight 65 kg, BMI 21.9. Abdomen soft. Haemoglobin 14.6, ALT 24.',
    assessment: 'Fit for work.',
    plan: 'No follow-up needed.',
  },
  {
    id: 'PN-4302',
    patientId: 'SD-P-43',
    at: on(9, 13, 22, 40),
    by: 'Emergency team',
    kind: 'Emergency note',
    setting: 'Emergency',
    subjective: 'Burning pain in the upper abdomen for three hours, after a late dinner on a night shift. Similar milder pain on and off for three months, worse when hungry, eased by antacids. No vomiting, black stools, weight loss or trouble swallowing. Takes no painkillers.',
    objective: 'Pulse 92, BP 126/78, afebrile. Tender in the epigastrium, no guarding. ECG normal. Troponin, lipase and liver tests normal. Haemoglobin 13.9.',
    assessment: 'Dyspepsia, likely gastritis. Not cardiac and not pancreatitis.',
    plan: 'IV pantoprazole here, then pantoprazole 40 mg daily for four weeks. Stool H. pylori antigen and an ultrasound of the abdomen. General Medicine OPD with the results.',
  },
  // SD-P-44 · Jayanthi Ravichandran
  {
    id: 'PN-4401',
    patientId: 'SD-P-44',
    at: on(1, 10, 10, 45),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Painful, swollen knuckles and wrists for three weeks, with an hour of morning stiffness. Takes methotrexate 10 mg every Sunday without missing a dose.',
    objective: 'Six swollen and eight tender joints. DAS28-ESR 5.1. ESR 52, ALT 24, haemoglobin 12.2. Hand X-rays in November: one early erosion, no new damage.',
    assessment: 'Rheumatoid arthritis flare on methotrexate 10 mg weekly.',
    plan: 'Increase methotrexate to 15 mg weekly. A short course of prednisolone, tapering over four weeks. Continue hydroxychloroquine and folic acid. Bloods every three months. No sulfasalazine, which gave her a rash.',
  },
  {
    id: 'PN-4402',
    patientId: 'SD-P-44',
    at: on(6, 15, 10, 45),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Joints much better. Twenty minutes of morning stiffness. Some tiredness. Does not drink alcohol.',
    objective: 'One swollen and two tender joints. DAS28-ESR 3.1. ESR 30, ALT 34, haemoglobin 11.6, white cells 6.1.',
    assessment: 'Rheumatoid arthritis in low activity. ALT a little up and haemoglobin a little down on methotrexate.',
    plan: 'Continue methotrexate 15 mg weekly and folic acid. Repeat liver tests and blood count in three months. Reduce the dose if the ALT keeps rising.',
  },
  // SD-P-45 · Prabhu Natarajan
  {
    id: 'PN-4501',
    patientId: 'SD-P-45',
    at: on(1, 12, 11, 0),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'A painful, swollen right big toe for four days, his third attack in a year. Took ibuprofen from the pharmacy for two days. Runs a tea shop and drinks beer at weekends.',
    objective: 'Hot, swollen right first toe joint. BP 146/90, weight 86 kg. Creatinine 134, eGFR 56, uric acid 9.8, urine albumin-creatinine ratio 82.',
    assessment: 'Acute gout of the right first toe joint. Chronic kidney disease stage 3a with albumin in the urine.',
    plan: 'Colchicine for the attack, and no more ibuprofen. Start telmisartan 40 mg. Start febuxostat once the attack settles, with colchicine cover for six months. Ultrasound of the kidneys. Cut down beer and red meat.',
  },
  {
    id: 'PN-4502',
    patientId: 'SD-P-45',
    at: on(5, 18, 11, 0),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'No gout attack since January. Stopped beer. Takes all three medicines.',
    objective: 'BP 140/88, weight 85 kg. Creatinine 138, eGFR 54, uric acid 8.1, potassium 4.7, urine albumin-creatinine ratio 70. Ultrasound: kidneys of normal size with mildly raised echogenicity.',
    assessment: 'Chronic kidney disease stage 3a, stable. Gout without attacks, uric acid above target.',
    plan: 'Continue febuxostat 40 mg, telmisartan 40 mg and colchicine. Bloods in four months, then consider febuxostat 80 mg. Dietitian for a low-purine, low-salt diet.',
  },
]

// ─────────────────────────────────────────────────────────── Prescriptions

export const OPD_PRESCRIPTIONS: PrescriptionRecord[] = [
  {
    id: 'RX-3901',
    patientId: 'SD-P-39',
    at: on(9, 19, 22, 30),
    by: 'Emergency team',
    context: 'Emergency',
    items: [
      { drug: 'Paracetamol', dose: '650 mg', route: 'Oral', frequency: 'Six-hourly as needed for fever', duration: '5 days', status: 'Active' },
      { drug: 'Levocetirizine', dose: '5 mg', route: 'Oral', frequency: 'At night', duration: '5 days', status: 'Active' },
    ],
  },
  {
    id: 'RX-4000',
    patientId: 'SD-P-40',
    at: on(3, 16, 10, 30),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Metformin', dose: '1 g', route: 'Oral', frequency: 'Twice daily with meals', duration: '3 months', status: 'Completed', note: 'Carried on in June.' },
      { drug: 'Telmisartan', dose: '40 mg', route: 'Oral', frequency: 'Once daily', duration: '3 months', status: 'Stopped', note: 'Changed to telmisartan with hydrochlorothiazide in June.' },
      { drug: 'Atorvastatin', dose: '10 mg', route: 'Oral', frequency: 'At night', duration: '3 months', status: 'Completed', note: 'Carried on in June.' },
    ],
  },
  {
    id: 'RX-4001',
    patientId: 'SD-P-40',
    at: on(6, 15, 10, 30),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Metformin', dose: '1 g', route: 'Oral', frequency: 'Twice daily with meals', duration: '3 months', status: 'Active' },
      { drug: 'Glimepiride', dose: '1 mg', route: 'Oral', frequency: 'Once daily, before breakfast', duration: '3 months', status: 'Active', note: 'New in June. HbA1c 7.6%. Watch for low sugars.' },
      { drug: 'Telmisartan with hydrochlorothiazide', dose: '40/12.5 mg', route: 'Oral', frequency: 'Once daily', duration: '3 months', status: 'Active', note: 'Sodium 132 in September.' },
      { drug: 'Atorvastatin', dose: '10 mg', route: 'Oral', frequency: 'At night', duration: '3 months', status: 'Active' },
    ],
  },
  {
    id: 'RX-4100',
    patientId: 'SD-P-41',
    at: on(3, 10, 11, 15, 2025),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Budesonide-formoterol inhaler', dose: '400/12 mcg', route: 'Inhaled', frequency: 'One inhalation twice daily and as needed', duration: '6 months', status: 'Stopped', note: 'Stepped down to 200/6 mcg in September 2025.' },
      { drug: 'Montelukast', dose: '10 mg', route: 'Oral', frequency: 'At night', duration: '6 months', status: 'Completed', note: 'Carried on in September 2025 and March 2026.' },
    ],
  },
  {
    id: 'RX-4101',
    patientId: 'SD-P-41',
    at: on(3, 16, 11, 15),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Budesonide-formoterol inhaler', dose: '200/6 mcg', route: 'Inhaled', frequency: 'One inhalation twice daily and as needed', duration: '6 months', status: 'Active', note: 'The next step-down is reviewed today.' },
      { drug: 'Montelukast', dose: '10 mg', route: 'Oral', frequency: 'At night', duration: '6 months', status: 'Active' },
    ],
  },
  {
    id: 'RX-4200',
    patientId: 'SD-P-42',
    at: on(1, 16, 11, 15),
    by: 'Dr. Rajsrinivas',
    context: 'Discharge',
    items: [
      { drug: 'Prednisolone', dose: '30 mg', route: 'Oral', frequency: 'Once daily, after breakfast', duration: '5 days', status: 'Completed' },
      { drug: 'Amoxicillin-clavulanate', dose: '625 mg', route: 'Oral', frequency: 'Three times daily', duration: '5 days', status: 'Completed' },
    ],
  },
  {
    id: 'RX-4201',
    patientId: 'SD-P-42',
    at: on(4, 20, 10, 45),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Glycopyrronium and formoterol inhaler', dose: '12.5/12 mcg', route: 'Inhaled', frequency: 'Twice daily', duration: '6 months', status: 'Active' },
      { drug: 'Salbutamol inhaler with spacer', dose: '100 mcg', route: 'Inhaled', frequency: 'Two puffs as needed', duration: '6 months', status: 'Active' },
    ],
  },
  {
    id: 'RX-4301',
    patientId: 'SD-P-43',
    at: on(9, 13, 23, 30),
    by: 'Emergency team',
    context: 'Emergency',
    items: [
      { drug: 'Pantoprazole', dose: '40 mg', route: 'Oral', frequency: 'Once daily, before breakfast', duration: '4 weeks', status: 'Active' },
      { drug: 'Aluminium hydroxide and magnesium hydroxide gel', dose: '10 mL', route: 'Oral', frequency: 'As needed for pain', duration: '1 week', status: 'Completed' },
    ],
  },
  {
    id: 'RX-4400',
    patientId: 'SD-P-44',
    at: on(1, 10, 11, 0),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Methotrexate', dose: '10 mg', route: 'Oral', frequency: 'Once weekly, on Sundays', duration: 'Ongoing', status: 'Stopped', note: 'Increased to 15 mg weekly for the January flare.' },
      { drug: 'Prednisolone', dose: '10 mg, tapering', route: 'Oral', frequency: 'Once daily, after breakfast', duration: '4 weeks', status: 'Completed' },
    ],
  },
  {
    id: 'RX-4401',
    patientId: 'SD-P-44',
    at: on(6, 15, 11, 0),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Methotrexate', dose: '15 mg', route: 'Oral', frequency: 'Once weekly, on Sundays', duration: 'Ongoing', status: 'Active', note: 'ALT 48 in September. The dose is reviewed today.' },
      { drug: 'Folic acid', dose: '5 mg', route: 'Oral', frequency: 'Once weekly, on Wednesdays', duration: 'Ongoing', status: 'Active', note: 'Never on the methotrexate day.' },
      { drug: 'Hydroxychloroquine', dose: '200 mg', route: 'Oral', frequency: 'Once daily', duration: 'Ongoing', status: 'Active' },
    ],
  },
  {
    id: 'RX-4500',
    patientId: 'SD-P-45',
    at: on(1, 12, 11, 15),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Colchicine', dose: '0.5 mg', route: 'Oral', frequency: 'Twice daily', duration: '1 week', status: 'Completed', note: 'For the attack. Ibuprofen stopped.' },
      { drug: 'Ibuprofen', dose: '—', route: '—', frequency: '—', duration: '—', status: 'Stopped', note: 'Bought over the counter. Stopped because of his kidneys.' },
      { drug: 'Telmisartan', dose: '40 mg', route: 'Oral', frequency: 'Once daily', duration: '4 months', status: 'Completed', note: 'Carried on in May.' },
      { drug: 'Febuxostat', dose: '40 mg', route: 'Oral', frequency: 'Once daily, from when the attack settled', duration: '4 months', status: 'Completed', note: 'Carried on in May.' },
    ],
  },
  {
    id: 'RX-4501',
    patientId: 'SD-P-45',
    at: on(5, 18, 11, 15),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Febuxostat', dose: '40 mg', route: 'Oral', frequency: 'Once daily', duration: '4 months', status: 'Active', note: 'Uric acid 7.4 in September, above the 6.0 target.' },
      { drug: 'Telmisartan', dose: '40 mg', route: 'Oral', frequency: 'Once daily', duration: '4 months', status: 'Active' },
      { drug: 'Colchicine', dose: '0.5 mg', route: 'Oral', frequency: 'Once daily', duration: 'Until July', status: 'Completed', note: 'Cover for the first six months of febuxostat.' },
    ],
  },
]

// ─────────────────────────────────────────────────────────── Appointments

const OPD_ROOM = 'Room 4, OPD block'

export const OPD_APPOINTMENTS: Appointment[] = [
  // SD-P-39 · Thangavel Palanisamy: a walk-in today, so nothing booked for today
  { id: 'AP-3901', patientId: 'SD-P-39', at: on(2, 8, 9, 0, 2025), kind: 'Review', status: 'Completed', clinic: 'Preventive health check', with: 'Health check physician', purpose: 'Yearly health check from his employer' },
  { id: 'AP-3902', patientId: 'SD-P-39', at: on(9, 19, 21, 0), kind: 'Review', status: 'Completed', clinic: 'Emergency', with: 'Emergency team', purpose: 'Fever and dry cough' },
  { id: 'AP-3903', patientId: 'SD-P-39', at: on(9, 19, 21, 50), kind: 'Investigation', status: 'Completed', clinic: 'Radiology', with: 'Radiography', purpose: 'Chest X-ray' },
  { id: 'AP-3904', patientId: 'SD-P-39', at: on(2, 10, 9, 0, 2027), kind: 'Review', status: 'Booked', clinic: 'Preventive health check', with: 'Health check physician', purpose: 'Yearly health check', prepare: ['Fast from 10 PM the night before'] },
  // SD-P-40 · Saraswathi Chinnasamy: a walk-in today, so nothing booked for today
  { id: 'AP-4001', patientId: 'SD-P-40', at: on(3, 16, 10, 0), kind: 'Follow-up', status: 'Completed', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'Diabetes and blood pressure review' },
  { id: 'AP-4002', patientId: 'SD-P-40', at: on(6, 15, 10, 0), kind: 'Follow-up', status: 'Completed', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'Diabetes and blood pressure review' },
  { id: 'AP-4003', patientId: 'SD-P-40', at: on(9, 14, 10, 15), kind: 'Investigation', status: 'Completed', clinic: 'Laboratory', with: 'Phlebotomy', purpose: 'HbA1c, fasting glucose, sodium, potassium, creatinine and lipids' },
  { id: 'AP-4004', patientId: 'SD-P-40', at: on(10, 5, 15, 0), kind: 'Review', status: 'Booked', clinic: 'Diabetes clinic', with: 'Diabetes educator', purpose: 'Foot care, and how to spot and treat a low sugar', prepare: ['Bring the glucose meter and the home blood pressure log'] },
  // SD-P-41 · Nithya Sekar
  { id: 'AP-4101', patientId: 'SD-P-41', at: on(3, 16, 10, 50), kind: 'Follow-up', status: 'Completed', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'Asthma review' },
  { id: 'AP-4102', patientId: 'SD-P-41', at: on(9, 18, 9, 30), kind: 'Investigation', status: 'Completed', clinic: 'Pulmonary function laboratory', with: 'Respiratory technician', purpose: 'Spirometry with reversibility, and FeNO' },
  { id: 'AP-4103', patientId: 'SD-P-41', at: AT_0920, kind: 'Follow-up', status: 'Today', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'Asthma review: inhaler step-down with the September spirometry', location: OPD_ROOM },
  { id: 'AP-4104', patientId: 'SD-P-41', at: on(10, 19, 16, 0), kind: 'Review', status: 'Booked', clinic: 'Asthma clinic', with: 'Asthma nurse educator', purpose: 'Inhaler technique and the action plan after the step-down', prepare: ['Bring both inhalers and the peak flow diary'] },
  // SD-P-42 · Arumugam Velusamy
  { id: 'AP-4201', patientId: 'SD-P-42', at: on(4, 20, 10, 15), kind: 'Follow-up', status: 'Completed', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'Review three months after the January admission' },
  { id: 'AP-4202', patientId: 'SD-P-42', at: on(9, 18, 10, 0), kind: 'Investigation', status: 'Completed', clinic: 'Pulmonary function laboratory', with: 'Respiratory technician', purpose: 'Spirometry and a six-minute walk' },
  { id: 'AP-4203', patientId: 'SD-P-42', at: AT_0930, kind: 'Follow-up', status: 'Today', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'COPD review with the September spirometry', location: OPD_ROOM },
  { id: 'AP-4204', patientId: 'SD-P-42', at: on(10, 7, 10, 0), kind: 'Review', status: 'Booked', clinic: 'Pulmonary rehabilitation', with: 'Physiotherapist', purpose: 'The first of eight rehabilitation sessions', prepare: ['Wear comfortable shoes', 'Bring the salbutamol inhaler'] },
  // SD-P-43 · Karthik Shanmugam
  { id: 'AP-4301', patientId: 'SD-P-43', at: on(6, 10, 9, 0, 2024), kind: 'Review', status: 'Completed', clinic: 'Preventive health check', with: 'Health check physician', purpose: 'Pre-employment health check' },
  { id: 'AP-4302', patientId: 'SD-P-43', at: on(9, 13, 22, 10), kind: 'Review', status: 'Completed', clinic: 'Emergency', with: 'Emergency team', purpose: 'Upper abdominal pain' },
  { id: 'AP-4303', patientId: 'SD-P-43', at: on(9, 14, 9, 30), kind: 'Investigation', status: 'Completed', clinic: 'Radiology', with: 'Ultrasonography', purpose: 'Ultrasound of the abdomen', prepare: ['Fast for six hours before'] },
  { id: 'AP-4304', patientId: 'SD-P-43', at: AT_1400, kind: 'Review', status: 'Today', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'New consultation: recurrent epigastric pain with a positive H. pylori stool antigen', location: OPD_ROOM },
  // SD-P-44 · Jayanthi Ravichandran
  { id: 'AP-4401', patientId: 'SD-P-44', at: on(6, 15, 10, 30), kind: 'Follow-up', status: 'Completed', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'Rheumatoid arthritis review' },
  { id: 'AP-4402', patientId: 'SD-P-44', at: on(9, 18, 10, 45), kind: 'Investigation', status: 'Completed', clinic: 'Laboratory', with: 'Phlebotomy', purpose: 'Liver tests, blood count, ESR and creatinine on methotrexate' },
  { id: 'AP-4403', patientId: 'SD-P-44', at: AT_1420, kind: 'Follow-up', status: 'Today', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'Rheumatoid arthritis review: the rising ALT on methotrexate', location: OPD_ROOM },
  { id: 'AP-4404', patientId: 'SD-P-44', at: on(11, 16, 10, 0), kind: 'Review', status: 'Booked', clinic: 'Ophthalmology', with: 'Optometrist', purpose: 'Yearly eye screening on hydroxychloroquine', prepare: ['Do not drive yourself: the drops blur vision for a few hours'] },
  // SD-P-45 · Prabhu Natarajan
  { id: 'AP-4501', patientId: 'SD-P-45', at: on(5, 18, 10, 30), kind: 'Follow-up', status: 'Completed', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'Kidney function and gout review' },
  { id: 'AP-4502', patientId: 'SD-P-45', at: on(9, 17, 10, 45), kind: 'Investigation', status: 'Completed', clinic: 'Laboratory', with: 'Phlebotomy', purpose: 'Creatinine, eGFR, uric acid, potassium and urine albumin' },
  { id: 'AP-4503', patientId: 'SD-P-45', at: AT_1440, kind: 'Follow-up', status: 'Today', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'Kidney function and uric acid review', location: OPD_ROOM },
  { id: 'AP-4504', patientId: 'SD-P-45', at: on(10, 8, 11, 0), kind: 'Review', status: 'Booked', clinic: 'Dietitian', with: 'Clinical dietitian', purpose: 'A low-purine, low-salt diet for the kidneys and gout', prepare: ['Bring a food diary for three days'] },
]

// ─────────────────────────────────────────────────────────────── Imaging

/** Report-only where no open image fits, so the viewer shows the report and says so. */
export const OPD_IMAGING: ImagingStudy[] = [
  {
    id: 'ST-9391',
    patientId: 'SD-P-39',
    modality: 'X-ray',
    description: 'Chest X-ray PA',
    acquiredAt: on(9, 19, 21, 55),
    priority: 'Urgent',
    status: 'Reported',
    reportedBy: 'Dr. Logesh',
    impression: 'No consolidation, collapse or effusion. Mild peribronchial thickening at both bases. Normal heart size.',
  },
  {
    id: 'ST-9411',
    patientId: 'SD-P-41',
    modality: 'X-ray',
    description: 'Chest X-ray PA',
    acquiredAt: on(3, 2, 23, 0, 2025),
    priority: 'Urgent',
    status: 'Reported',
    reportedBy: 'Dr. Logesh',
    impression: 'Mildly hyperinflated lungs during the attack. No consolidation or pneumothorax. Normal heart size.',
  },
  {
    id: 'ST-9421',
    patientId: 'SD-P-42',
    modality: 'X-ray',
    description: 'Chest X-ray PA',
    acquiredAt: on(1, 12, 7, 10),
    priority: 'Urgent',
    status: 'Reported',
    reportedBy: 'Dr. Logesh',
    impression: 'Hyperinflated lungs with flat diaphragms, in keeping with COPD. No consolidation or pneumothorax.',
  },
  {
    id: 'ST-9431',
    patientId: 'SD-P-43',
    modality: 'Ultrasound',
    description: 'Ultrasound of the abdomen',
    acquiredAt: on(9, 14, 9, 40),
    imageKey: 'us-2101',
    priority: 'Routine',
    status: 'Reported',
    reportedBy: 'Dr. Logesh',
    impression: 'Fatty liver: the liver is brighter than the right kidney, with no focal lesion. Gallbladder without stones. Pancreas, spleen and kidneys normal. No free fluid.',
    findings: ['The retained image is the right upper quadrant, liver beside the right kidney. The stomach and duodenum are not assessed by ultrasound.'],
  },
  {
    id: 'ST-9441',
    patientId: 'SD-P-44',
    modality: 'X-ray',
    description: 'X-ray of both hands',
    acquiredAt: on(11, 10, 11, 30, 2025),
    priority: 'Routine',
    status: 'Reported',
    reportedBy: 'Dr. Logesh',
    impression: 'Osteopenia around the knuckle joints. One small erosion at the right second knuckle, unchanged since 2024. No new erosions.',
  },
  {
    id: 'ST-9451',
    patientId: 'SD-P-45',
    modality: 'Ultrasound',
    description: 'Ultrasound of the kidneys',
    acquiredAt: on(1, 20, 10, 0),
    priority: 'Routine',
    status: 'Reported',
    reportedBy: 'Dr. Logesh',
    impression: 'Both kidneys of normal size, right 10.2 cm and left 10.4 cm, with mildly raised echogenicity. No stones or hydronephrosis.',
  },
]

// ─────────────────────────────────────────────────────────────── Documents

export const OPD_DOCUMENTS: RecordReport[] = [
  { id: 'DOC-3902', patientId: 'SD-P-39', at: on(9, 19, 22, 0), kind: 'ECG', title: '12-lead ECG', by: 'Emergency', summary: 'Sinus tachycardia 102, with the fever. No ST change.' },
  { id: 'DOC-3901', patientId: 'SD-P-39', at: on(2, 8, 9, 45, 2025), kind: 'ECG', title: '12-lead ECG', by: 'Health check', summary: 'Sinus rhythm 74. Normal axis. No abnormality.' },
  { id: 'DOC-4101', patientId: 'SD-P-41', at: on(3, 3, 12, 0, 2025), kind: 'Discharge summary', title: 'Discharge summary, overnight admission', by: 'Dr. Rajsrinivas', summary: 'Acute asthma attack after a cold, treated with nebulised salbutamol and ipratropium and oral prednisolone. Home on prednisolone for five days, with an OPD review in a week. Aspirin allergy noted.' },
  { id: 'DOC-4001', patientId: 'SD-P-40', at: on(6, 15, 10, 10), kind: 'ECG', title: '12-lead ECG', by: 'OPD nursing', summary: 'Sinus rhythm 80. Left ventricular hypertrophy by voltage criteria. No ischaemic change.' },
  { id: 'DOC-4002', patientId: 'SD-P-40', at: on(3, 16, 11, 0), kind: 'Clinical photographs', title: 'Retinal photographs, both eyes', by: 'Ophthalmology', summary: 'Mild non-proliferative diabetic retinopathy in the right eye. None in the left. Repeat in a year.' },
  { id: 'DOC-4201', patientId: 'SD-P-42', at: on(1, 12, 6, 50), kind: 'ECG', title: '12-lead ECG', by: 'Emergency', summary: 'Sinus tachycardia 104. P pulmonale. No ischaemic change.' },
  { id: 'DOC-4202', patientId: 'SD-P-42', at: on(1, 16, 11, 0), kind: 'Discharge summary', title: 'Discharge summary, ward 4B', by: 'Dr. Rajsrinivas', summary: 'COPD exacerbation with a chest infection, treated with steroids, antibiotics and controlled oxygen. Home on glycopyrronium with formoterol.' },
  { id: 'DOC-4301', patientId: 'SD-P-43', at: on(9, 13, 22, 30), kind: 'ECG', title: '12-lead ECG', by: 'Emergency', summary: 'Sinus rhythm 90. Normal ECG.' },
  { id: 'DOC-4401', patientId: 'SD-P-44', at: on(11, 20, 10, 0, 2025), kind: 'Clinical photographs', title: 'Retinal OCT, both eyes', by: 'Ophthalmology', summary: 'No hydroxychloroquine retinopathy. Repeat in a year.' },
  { id: 'DOC-4501', patientId: 'SD-P-45', at: on(5, 18, 10, 40), kind: 'ECG', title: '12-lead ECG', by: 'OPD nursing', summary: 'Sinus rhythm 72. No left ventricular hypertrophy. Normal T waves.' },
]

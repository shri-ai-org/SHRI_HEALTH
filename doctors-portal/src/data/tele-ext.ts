/**
 * Three more video visits for today, so the teleconsult list is not only
 * Fatima and Arjun: Kamala Devi's levothyroxine dose review at 10:15, Vignesh
 * Ramalingam's HbA1c review at 10:25 and Ananya Iyer's wound check, 10 days
 * after a laparoscopic appendectomy, at 10:30. Each one's whole record is here
 * (the patient, the visit, the problems, results with their series, vitals
 * with their history, the condition, earlier notes, prescriptions,
 * appointments and documents), merged into the shared lists by `kit.ts`,
 * `clinical.ts`, `vitals-history.ts` and `record.ts`, so every screen reads
 * one list.
 *
 * Only types come from those files, so nothing here imports a file that
 * imports it back.
 *
 * The rules the other record files keep, kept here too:
 *   · a result's series ends on its row's own value, at its row's own time;
 *   · a vitals series ends on the snapshot, at the snapshot's time;
 *   · every result came back before today and was reviewed then, so none of
 *     them adds to the morning brief's "results changed";
 *   · the notes, the medicines and the results agree with one another.
 */

import type { Encounter, Problem, ResultRow, TeleRow } from './clinical'
import { minutesAhead } from './format'
import type { Patient } from './kit'
import type { Appointment, ConditionSummary, PastNote, PrescriptionRecord, RecordReport } from './record'
import type { VitalRow, VitalSeries } from './vitals-history'

function on(month: number, day: number, h = 10, m = 0, year = 2026): Date {
  return new Date(year, month - 1, day, h, m)
}

// ───────────────────────────────────────────────────────────── The patients

export const TELE_PATIENTS: Patient[] = [
  {
    id: 'SD-P-36',
    name: 'Kamala Devi',
    nameNative: 'கமலா தேவி',
    age: 58,
    sex: 'F',
    uhid: 'ISH-0044303',
    scenario: 'Teleconsult, endocrinology follow-up',
    payer: 'CGHS',
    abha: 'kamala.devi@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: null,
    facilityCode: 'ISH',
    consultant: 'Dr. Rajsrinivas',
    weightKg: 66,
  },
  {
    id: 'SD-P-37',
    name: 'Vignesh Ramalingam',
    nameNative: 'விக்னேஷ் ராமலிங்கம்',
    age: 45,
    sex: 'M',
    uhid: 'ISH-0044304',
    scenario: 'Teleconsult, diabetes follow-up',
    payer: 'Self-pay (card)',
    abha: 'vignesh.ramalingam@abdm',
    abhaStatus: 'Linked',
    allergies: [],
    bed: null,
    facilityCode: 'ISH',
    consultant: 'Dr. Rajsrinivas',
    weightKg: 82,
  },
  {
    id: 'SD-P-38',
    name: 'Ananya Iyer',
    nameNative: 'அனன்யா ஐயர்',
    age: 31,
    sex: 'F',
    uhid: 'ISH-0044305',
    scenario: 'Teleconsult, surgical follow-up',
    payer: 'TPA cashless',
    abha: 'ananya.iyer@abdm',
    abhaStatus: 'Linked',
    /** A rash all over after diclofenac in 2023. */
    allergies: ['Diclofenac'],
    bed: null,
    facilityCode: 'ISH',
    consultant: 'Dr. Rajsrinivas',
    weightKg: 56,
  },
]

// ──────────────────────────────────────────────────── Today's video visits

export const TELE_QUEUE_EXT: TeleRow[] = [
  {
    id: 'E-118461',
    patientId: 'SD-P-36',
    scheduledAt: minutesAhead(95),
    reason: 'Hypothyroidism, levothyroxine dose review',
    videoReady: true,
    rankReason: 'On time, video tested, and her September thyroid results are already on file',
  },
  {
    id: 'E-118462',
    patientId: 'SD-P-37',
    scheduledAt: minutesAhead(105),
    reason: 'Type 2 diabetes, HbA1c review on metformin',
    videoReady: true,
    rankReason: 'On time, video tested, and his HbA1c and fasting glucose are already on file',
  },
  {
    id: 'E-118463',
    patientId: 'SD-P-38',
    scheduledAt: minutesAhead(110),
    reason: 'Wound check, 10 days after laparoscopic appendectomy',
    videoReady: true,
    rankReason: 'On time, video tested, and photographs of the wound were uploaded last night',
  },
]

export const TELE_ENCOUNTERS: Encounter[] = [
  { id: 'E-118461', encounterNo: 'OP/26-27/118461', patientId: 'SD-P-36', type: 'TELE', startedAt: minutesAhead(95), consultantStaffId: 'SD-S-01', department: 'Endocrinology' },
  { id: 'E-118462', encounterNo: 'OP/26-27/118462', patientId: 'SD-P-37', type: 'TELE', startedAt: minutesAhead(105), consultantStaffId: 'SD-S-01', department: 'General Medicine' },
  { id: 'E-118463', encounterNo: 'OP/26-27/118463', patientId: 'SD-P-38', type: 'TELE', startedAt: minutesAhead(110), consultantStaffId: 'SD-S-01', department: 'General Surgery' },
]

// ─────────────────────────────────────────────────────────────── Problems

export const TELE_PROBLEMS: Problem[] = [
  { id: 'PR-31', patientId: 'SD-P-36', label: 'Hypothyroidism', icd10: 'E03.9', snomed: '40930008', onset: '2021', status: 'Open', leaf: true },
  { id: 'PR-32', patientId: 'SD-P-36', label: 'Essential hypertension', icd10: 'I10', snomed: '59621000', onset: '2018', status: 'Open', leaf: true },
  { id: 'PR-33', patientId: 'SD-P-37', label: 'Type 2 diabetes with hyperglycaemia', icd10: 'E11.65', snomed: '44054006', onset: '2022', status: 'Open', leaf: true },
  { id: 'PR-34', patientId: 'SD-P-37', label: 'Hyperlipidaemia', icd10: 'E78.5', snomed: '55822004', onset: '2023', status: 'Open', leaf: true },
  { id: 'PR-35', patientId: 'SD-P-38', label: 'Acute appendicitis, removed laparoscopically on 11-Sep-2026', icd10: 'K35.8', snomed: '85189001', onset: '10-Sep-2026', status: 'Resolved', leaf: true },
  { id: 'PR-36', patientId: 'SD-P-38', label: 'Iron deficiency anaemia', icd10: 'D50.9', snomed: '87522002', onset: '12-Sep-2026', status: 'Open', leaf: true },
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

export const TELE_RESULTS: ResultRow[] = [
  // ── SD-P-36 · Kamala Devi, bloods drawn on Friday for today's review
  seen('R-93601', 'SD-P-36', 'TSH', '6.8', 'mIU/L', '0.4 – 4.0', '↑ High', on(9, 18, 11, 0), 'Above range and up from 5.2 in March, on the same 75 mcg dose', { priorValue: '5.2', delta: '+1.6 in 6 months', refLow: 0.4, refHigh: 4 }),
  seen('R-93602', 'SD-P-36', 'Free T4', '0.9', 'ng/dL', '0.8 – 1.8', 'Normal', on(9, 18, 11, 0), 'Within range, at the low end', { refLow: 0.8, refHigh: 1.8 }),
  seen('R-93603', 'SD-P-36', 'Serum creatinine', '68', 'µmol/L', '45 – 90', 'Normal', on(9, 18, 11, 0), 'Within range on telmisartan', { priorValue: '66', refLow: 45, refHigh: 90 }),
  seen('R-93604', 'SD-P-36', 'Serum potassium', '4.4', 'mmol/L', '3.5 – 5.1', 'Normal', on(9, 18, 11, 0), 'Within range on telmisartan', { refLow: 3.5, refHigh: 5.1 }),

  // ── SD-P-37 · Vignesh Ramalingam, three-monthly diabetes bloods
  seen('R-93701', 'SD-P-37', 'HbA1c', '7.6', '%', '4.0 – 5.6', '↑ High', on(9, 19, 10, 30), 'Above range and above his 7.0% target, up from 7.3 in June on metformin 1 g twice daily', { priorValue: '7.3', delta: '+0.3 in 3 months', refLow: 4, refHigh: 5.6 }),
  seen('R-93702', 'SD-P-37', 'Fasting plasma glucose', '148', 'mg/dL', '70 – 100', '↑ High', on(9, 19, 10, 30), 'Above range, up from 136 in June', { priorValue: '136', refLow: 70, refHigh: 100 }),
  seen('R-93703', 'SD-P-37', 'Serum creatinine', '84', 'µmol/L', '62 – 106', 'Normal', on(9, 19, 10, 30), 'Within range, so metformin can continue at full dose', { refLow: 62, refHigh: 106 }),
  seen('R-93704', 'SD-P-37', 'LDL cholesterol', '96', 'mg/dL', '< 100', 'Normal', on(9, 19, 10, 30), 'Within range on atorvastatin 10 mg', { priorValue: '128', refLow: 0, refHigh: 100 }),
  seen('R-93705', 'SD-P-37', 'Urine albumin-creatinine ratio', '18', 'mg/g', '< 30', 'Normal', on(9, 19, 10, 30), 'Within range, no sign of kidney damage from diabetes', { refLow: 0, refHigh: 30 }),

  // ── SD-P-38 · Ananya Iyer, at admission and the day after surgery
  seen('R-93801', 'SD-P-38', 'Urine pregnancy test', 'Negative', '', 'Negative', 'Normal', on(9, 10, 20, 30), 'Negative before surgery'),
  seen('R-93802', 'SD-P-38', 'C-reactive protein', '64', 'mg/L', '< 10', '↑ High', on(9, 10, 20, 50), 'Above range at admission, with the appendicitis', { refLow: 0, refHigh: 10 }),
  seen('R-93803', 'SD-P-38', 'White cell count', '7.8', '×10⁹/L', '4.0 – 11.0', 'Normal', on(9, 12, 7, 0), 'Back within range the day after surgery, down from 14.6 at admission', { priorValue: '14.6', delta: '−6.8 in 34h', refLow: 4, refHigh: 11 }),
  seen('R-93804', 'SD-P-38', 'Haemoglobin', '11.1', 'g/dL', '12.0 – 15.5', '↓ Low', on(9, 12, 7, 0), 'Below range, down from 11.6 at admission', { priorValue: '11.6', refLow: 12, refHigh: 15.5 }),
  seen('R-93805', 'SD-P-38', 'Ferritin', '12', 'ng/mL', '15 – 150', '↓ Low', on(9, 12, 7, 0), 'Below range: iron deficiency behind the low haemoglobin', { refLow: 15, refHigh: 150 }),
]

/** The series behind the results above, each ending on its row's value and time. */
export const TELE_RESULT_TRENDS: Record<string, { at: Date; value: number }[]> = {
  // SD-P-36: TSH creeping up on an unchanged 75 mcg
  'R-93601': [
    { at: on(3, 14, 11, 0, 2025), value: 3.2 },
    { at: on(9, 12, 11, 0, 2025), value: 4.1 },
    { at: on(3, 13, 11, 0), value: 5.2 },
    { at: on(9, 18, 11, 0), value: 6.8 },
  ],
  'R-93602': [
    { at: on(3, 13, 11, 0), value: 1.1 },
    { at: on(9, 18, 11, 0), value: 0.9 },
  ],
  'R-93603': [
    { at: on(9, 12, 11, 0, 2025), value: 64 },
    { at: on(3, 13, 11, 0), value: 66 },
    { at: on(9, 18, 11, 0), value: 68 },
  ],
  // SD-P-37: HbA1c every three months, and glucose
  'R-93701': [
    { at: on(9, 12, 10, 30, 2025), value: 6.8 },
    { at: on(12, 12, 10, 30, 2025), value: 7.0 },
    { at: on(3, 13, 10, 30), value: 7.1 },
    { at: on(6, 12, 10, 30), value: 7.3 },
    { at: on(9, 19, 10, 30), value: 7.6 },
  ],
  'R-93702': [
    { at: on(3, 13, 10, 30), value: 132 },
    { at: on(6, 12, 10, 30), value: 136 },
    { at: on(9, 19, 10, 30), value: 148 },
  ],
  'R-93704': [
    { at: on(6, 12, 10, 30, 2025), value: 128 },
    { at: on(3, 13, 10, 30), value: 104 },
    { at: on(9, 19, 10, 30), value: 96 },
  ],
  // SD-P-38: the infection settling, and the haemoglobin
  'R-93803': [
    { at: on(9, 10, 20, 50), value: 14.6 },
    { at: on(9, 11, 6, 0), value: 12.2 },
    { at: on(9, 12, 7, 0), value: 7.8 },
  ],
  'R-93804': [
    { at: on(9, 10, 20, 50), value: 11.6 },
    { at: on(9, 12, 7, 0), value: 11.1 },
  ],
}

// ──────────────────────────────────────────────────────────────── Vitals

const BP = { label: 'BP', unit: 'mmHg systolic', low: 90, high: 140 }
const PULSE = { label: 'Pulse', unit: 'bpm', low: 60, high: 100 }
const TEMP = { label: 'Temperature', unit: '°C', low: 36.1, high: 37.9 }
const WEIGHT = { label: 'Weight', unit: 'kg' }

/** The last readings taken in person: at the laboratory visit, or at discharge. */
export const TELE_VITALS: Record<string, VitalRow[]> = {
  // Kamala: by the nurse when her bloods were drawn on Friday
  'SD-P-36': [
    { label: 'BP', value: '138/86 mmHg', flag: 'Normal', at: on(9, 18, 10, 50) },
    { label: 'Pulse', value: '64 bpm', flag: 'Normal', at: on(9, 18, 10, 50) },
    { label: 'Weight', value: '66 kg', flag: 'Normal', at: on(9, 18, 10, 50) },
    { label: 'BMI', value: '27.5 kg/m²', flag: '↑ High', at: on(9, 18, 10, 50) },
    { label: 'Temperature', value: '36.6 °C', flag: 'Normal', at: on(9, 18, 10, 50) },
  ],
  // Vignesh: by the nurse when his bloods were drawn on Saturday
  'SD-P-37': [
    { label: 'BP', value: '132/84 mmHg', flag: 'Normal', at: on(9, 19, 10, 20) },
    { label: 'Pulse', value: '78 bpm', flag: 'Normal', at: on(9, 19, 10, 20) },
    { label: 'Weight', value: '82 kg', flag: 'Normal', at: on(9, 19, 10, 20) },
    { label: 'BMI', value: '27.7 kg/m²', flag: '↑ High', at: on(9, 19, 10, 20) },
    { label: 'Temperature', value: '36.7 °C', flag: 'Normal', at: on(9, 19, 10, 20) },
  ],
  // Ananya: on the morning she went home
  'SD-P-38': [
    { label: 'BP', value: '112/72 mmHg', flag: 'Normal', at: on(9, 12, 9, 30) },
    { label: 'Pulse', value: '80 bpm', flag: 'Normal', at: on(9, 12, 9, 30) },
    { label: 'Weight', value: '56 kg', flag: 'Normal', at: on(9, 12, 9, 30) },
    { label: 'BMI', value: '21.9 kg/m²', flag: 'Normal', at: on(9, 12, 9, 30) },
    { label: 'Temperature', value: '36.8 °C', flag: 'Normal', at: on(9, 12, 9, 30) },
  ],
}

export const TELE_VITALS_HISTORY: Record<string, VitalSeries[]> = {
  'SD-P-36': [
    {
      ...BP,
      points: [
        { at: on(3, 14, 10, 40, 2025), value: 146 },
        { at: on(9, 15, 10, 40, 2025), value: 140 },
        { at: on(3, 16, 10, 40), value: 136 },
        { at: on(9, 18, 10, 50), value: 138 },
      ],
    },
    {
      ...WEIGHT,
      points: [
        { at: on(9, 15, 10, 40, 2025), value: 63.5 },
        { at: on(3, 16, 10, 40), value: 64.5 },
        { at: on(9, 18, 10, 50), value: 66 },
      ],
    },
    {
      ...PULSE,
      points: [
        { at: on(9, 15, 10, 40, 2025), value: 70 },
        { at: on(3, 16, 10, 40), value: 66 },
        { at: on(9, 18, 10, 50), value: 64 },
      ],
    },
  ],
  'SD-P-37': [
    {
      ...WEIGHT,
      points: [
        { at: on(9, 15, 10, 0, 2025), value: 79 },
        { at: on(3, 16, 10, 0), value: 80.5 },
        { at: on(6, 15, 10, 0), value: 81 },
        { at: on(9, 19, 10, 20), value: 82 },
      ],
    },
    {
      ...BP,
      points: [
        { at: on(9, 15, 10, 0, 2025), value: 128 },
        { at: on(3, 16, 10, 0), value: 130 },
        { at: on(6, 15, 10, 0), value: 134 },
        { at: on(9, 19, 10, 20), value: 132 },
      ],
    },
  ],
  'SD-P-38': [
    {
      ...TEMP,
      points: [
        { at: on(9, 10, 20, 30), value: 38.1 },
        { at: on(9, 11, 14, 0), value: 37.4 },
        { at: on(9, 12, 9, 30), value: 36.8 },
      ],
    },
    {
      ...PULSE,
      points: [
        { at: on(9, 10, 20, 30), value: 104 },
        { at: on(9, 11, 14, 0), value: 88 },
        { at: on(9, 12, 9, 30), value: 80 },
      ],
    },
    {
      ...BP,
      points: [
        { at: on(9, 10, 20, 30), value: 118 },
        { at: on(9, 11, 14, 0), value: 110 },
        { at: on(9, 12, 9, 30), value: 112 },
      ],
    },
  ],
}

// ───────────────────────────────────────────────────────────── Condition

export const TELE_CONDITIONS: ConditionSummary[] = [
  {
    patientId: 'SD-P-36',
    status: 'Stable',
    headline: 'Hypothyroidism, under-replaced on levothyroxine 75 mcg, with controlled hypertension',
    summary:
      'Her TSH has risen at every check for 18 months on the same dose, and she has gained 2.5 kg in a year. Her blood pressure is controlled on telmisartan and her kidney function and potassium are normal.',
    watch: ['TSH 6.8 mIU/L, so the dose is due to go up today', 'Thyroid function six weeks after any change', 'Home blood pressure readings, below 140/90'],
    updatedAt: on(9, 18, 12, 0),
    updatedBy: 'Dr. Rajsrinivas',
    ai: {
      text: 'Thyroid replacement is no longer enough on 75 mcg. Blood pressure is not the issue today.',
      drivers: ['TSH 3.2 → 6.8 mIU/L over 18 months', 'Free T4 0.9 ng/dL, at the low end of range', 'BP 138/86 on telmisartan 40 mg'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-37',
    status: 'Stable',
    headline: 'Type 2 diabetes above target on metformin 1 g twice daily',
    summary:
      'His HbA1c has risen at each check this year, to 7.6%, although the metformin dose went up in June. His kidneys and urine albumin are normal and his LDL is on target on atorvastatin.',
    watch: ['HbA1c 7.6%, against a target of 7.0%', 'Weight up 3 kg in a year', 'Kidney function before any second medicine'],
    updatedAt: on(9, 19, 12, 0),
    updatedBy: 'Dr. Rajsrinivas',
    ai: {
      text: 'Glucose control is drifting despite the full metformin dose, so a second medicine is worth discussing today.',
      drivers: ['HbA1c 6.8 → 7.6% over a year', 'Fasting glucose 148 mg/dL', 'Creatinine 84 µmol/L and urine albumin normal'],
      band: 'HIGH',
      model: 'AI-105 v1.6.0',
    },
  },
  {
    patientId: 'SD-P-38',
    status: 'Improving',
    headline: 'Ten days after a laparoscopic appendectomy, recovering at home',
    summary:
      'A non-perforated appendix was removed on 11 September and she went home the next day. The infection has settled. She has mild iron deficiency anaemia and is on oral iron. She is allergic to diclofenac.',
    watch: ['Port sites: redness, discharge or fever', 'Haemoglobin 11.1 g/dL, on iron', 'Back to work and lifting after two weeks'],
    updatedAt: on(9, 12, 11, 0),
    updatedBy: 'Dr. Rajsrinivas',
    ai: {
      text: 'An uncomplicated recovery so far. The wound check by video is the item for today.',
      drivers: ['White cells 14.6 → 7.8 ×10⁹/L', 'Afebrile since 11 September', 'Ferritin 12 ng/mL'],
      band: 'MED',
      model: 'AI-105 v1.6.0',
    },
  },
]

// ─────────────────────────────────────────────────────────── Earlier notes

export const TELE_PAST_NOTES: PastNote[] = [
  // SD-P-36 · Kamala Devi
  {
    id: 'PN-3601',
    patientId: 'SD-P-36',
    at: on(9, 15, 11, 0, 2025),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Feels well. Takes levothyroxine before breakfast and telmisartan in the morning.',
    objective: 'BP 140/88, pulse 70, weight 63.5 kg. No goitre. TSH 4.1 mIU/L.',
    assessment: 'Hypothyroidism adequately replaced on 75 mcg. Hypertension at the upper limit of target.',
    plan: 'Continue levothyroxine 75 mcg and telmisartan 40 mg. Less salt. Thyroid function in six months.',
  },
  {
    id: 'PN-3602',
    patientId: 'SD-P-36',
    at: on(3, 16, 11, 0),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'More tired in the afternoons and feels the cold. Has not missed a dose. Takes her calcium tablet at night, away from the levothyroxine.',
    objective: 'BP 136/84, pulse 66, weight 64.5 kg. Dry skin. TSH 5.2 mIU/L, free T4 1.1 ng/dL.',
    assessment: 'Hypothyroidism, borderline under-replaced. Blood pressure at target.',
    plan: 'Keep 75 mcg for now and recheck thyroid function in six months. Increase the dose if the TSH is still rising.',
  },
  // SD-P-37 · Vignesh Ramalingam
  {
    id: 'PN-3701',
    patientId: 'SD-P-37',
    at: on(3, 16, 10, 0),
    by: 'Dr. Rajsrinivas',
    kind: 'Teleconsult',
    setting: 'Teleconsult · General Medicine',
    subjective: 'Works shifts at a textile mill and eats late at night. Walks twice a week. Takes metformin 500 mg twice daily without stomach upset.',
    objective: 'On video: well. HbA1c 7.1%, fasting glucose 132 mg/dL, LDL 104 mg/dL.',
    assessment: 'Type 2 diabetes just above target on metformin 500 mg twice daily.',
    plan: 'Diet advice for shift work, with the evening meal before 9 PM. Walk 30 minutes a day. Recheck HbA1c in three months.',
  },
  {
    id: 'PN-3702',
    patientId: 'SD-P-37',
    at: on(6, 15, 10, 0),
    by: 'Dr. Rajsrinivas',
    kind: 'Consultation',
    setting: 'OPD · General Medicine',
    subjective: 'Walking more, but still eating late on night shifts. No thirst or weight loss.',
    objective: 'BP 134/82, weight 81 kg, BMI 27.4. Feet: sensation and pulses normal. HbA1c 7.3%, fasting glucose 136 mg/dL.',
    assessment: 'Type 2 diabetes above target and rising.',
    plan: 'Increase metformin to 1 g twice daily with meals. Continue atorvastatin 10 mg. Retinal photographs today. HbA1c in three months.',
  },
  // SD-P-38 · Ananya Iyer
  {
    id: 'PN-3801',
    patientId: 'SD-P-38',
    at: on(9, 10, 20, 40),
    by: 'Emergency team',
    kind: 'Emergency note',
    setting: 'Emergency',
    subjective: 'Pain around the navel since the morning, moving to the right lower abdomen by the afternoon. Vomited twice. Last period two weeks ago. Allergic to diclofenac, which gave her a rash.',
    objective: 'Temp 38.1, pulse 104, BP 118/76. Tender in the right iliac fossa with rebound. White cells 14.6, CRP 64. Urine pregnancy test negative. Ultrasound: inflamed appendix, 9 mm, no collection.',
    assessment: 'Acute appendicitis, Alvarado score 8.',
    plan: 'Nothing by mouth, IV fluids, ceftriaxone and metronidazole. Paracetamol for pain, no NSAIDs. Laparoscopic appendectomy in the morning.',
  },
  {
    id: 'PN-3802',
    patientId: 'SD-P-38',
    at: on(9, 11, 11, 30),
    by: 'General surgeon',
    kind: 'Procedure note',
    setting: 'OT-2 · General Surgery',
    subjective: 'Consented for laparoscopic appendectomy, with the chance of converting to open surgery explained.',
    objective: 'Three ports. Inflamed appendix, not perforated, no pus in the pelvis. Appendix removed and sent for histopathology. Blood loss under 20 mL.',
    assessment: 'Laparoscopic appendectomy for acute appendicitis, uncomplicated.',
    plan: 'Diet as tolerated from the evening. Two more doses of IV antibiotics. Home tomorrow if eating and afebrile.',
  },
  {
    id: 'PN-3803',
    patientId: 'SD-P-38',
    at: on(9, 12, 11, 0),
    by: 'Dr. Rajsrinivas',
    kind: 'Discharge summary',
    setting: 'Surgical ward',
    subjective: 'Eating and walking, pain controlled on paracetamol.',
    objective: 'Afebrile since yesterday, pulse 80, BP 112/72. Port sites clean and dry. White cells 7.8. Haemoglobin 11.1, ferritin 12.',
    assessment: 'Recovering well after laparoscopic appendectomy. Iron deficiency anaemia.',
    plan: 'Paracetamol as needed for five days. Oral iron for three months. Keep the dressings dry. Wound check by video on day 10. Return at once with fever, spreading redness or discharge.',
  },
]

// ─────────────────────────────────────────────────────────── Prescriptions

export const TELE_PRESCRIPTIONS: PrescriptionRecord[] = [
  {
    id: 'RX-3600',
    patientId: 'SD-P-36',
    at: on(9, 15, 11, 15, 2025),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Levothyroxine', dose: '75 mcg', route: 'Oral', frequency: 'Once daily, before breakfast', duration: '6 months', status: 'Completed', note: 'Carried on by the March 2026 prescription.' },
      { drug: 'Telmisartan', dose: '40 mg', route: 'Oral', frequency: 'Once daily', duration: '6 months', status: 'Completed', note: 'Carried on by the March 2026 prescription.' },
    ],
  },
  {
    id: 'RX-3601',
    patientId: 'SD-P-36',
    at: on(3, 16, 11, 15),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Levothyroxine', dose: '75 mcg', route: 'Oral', frequency: 'Once daily, before breakfast', duration: '6 months', status: 'Active', note: 'The dose is reviewed today against a TSH of 6.8.' },
      { drug: 'Telmisartan', dose: '40 mg', route: 'Oral', frequency: 'Once daily', duration: '6 months', status: 'Active' },
      { drug: 'Calcium carbonate with vitamin D3', dose: '500 mg', route: 'Oral', frequency: 'At night', duration: 'Ongoing', status: 'Active', note: 'Four hours apart from the levothyroxine' },
    ],
  },
  {
    id: 'RX-3700',
    patientId: 'SD-P-37',
    at: on(3, 16, 10, 20),
    by: 'Dr. Rajsrinivas',
    context: 'Teleconsult',
    items: [
      { drug: 'Metformin', dose: '500 mg', route: 'Oral', frequency: 'Twice daily with meals', duration: '3 months', status: 'Completed', note: 'Increased to 1 g in June.' },
      { drug: 'Atorvastatin', dose: '10 mg', route: 'Oral', frequency: 'At night', duration: '3 months', status: 'Completed', note: 'Carried on in June.' },
    ],
  },
  {
    id: 'RX-3701',
    patientId: 'SD-P-37',
    at: on(6, 15, 10, 20),
    by: 'Dr. Rajsrinivas',
    context: 'OPD visit',
    items: [
      { drug: 'Metformin', dose: '1 g', route: 'Oral', frequency: 'Twice daily with meals', duration: '3 months', status: 'Active', note: 'Up from 500 mg. HbA1c 7.3%.' },
      { drug: 'Atorvastatin', dose: '10 mg', route: 'Oral', frequency: 'At night', duration: '3 months', status: 'Active' },
    ],
  },
  {
    id: 'RX-3800',
    patientId: 'SD-P-38',
    at: on(9, 10, 21, 0),
    by: 'Emergency team',
    context: 'Inpatient chart',
    items: [
      { drug: 'Ceftriaxone', dose: '1 g', route: 'IV', frequency: 'Once daily', duration: '2 days', status: 'Completed', note: 'Around surgery' },
      { drug: 'Metronidazole', dose: '500 mg', route: 'IV', frequency: '8-hourly', duration: '2 days', status: 'Completed', note: 'Around surgery' },
      { drug: 'Diclofenac', dose: '—', route: '—', frequency: '—', duration: '—', status: 'Stopped', note: 'Not given because of her diclofenac allergy. Paracetamol instead.' },
    ],
  },
  {
    id: 'RX-3801',
    patientId: 'SD-P-38',
    at: on(9, 12, 11, 15),
    by: 'Dr. Rajsrinivas',
    context: 'Discharge',
    items: [
      { drug: 'Paracetamol', dose: '650 mg', route: 'Oral', frequency: 'Six-hourly as needed', duration: '5 days', status: 'Completed' },
      { drug: 'Ferrous ascorbate', dose: '100 mg elemental iron', route: 'Oral', frequency: 'Once daily, an hour before lunch', duration: '3 months', status: 'Active', note: 'Ferritin 12. Recheck haemoglobin in December.' },
    ],
  },
]

// ─────────────────────────────────────────────────────────── Appointments

export const TELE_APPOINTMENTS: Appointment[] = [
  // SD-P-36 · Kamala Devi
  { id: 'AP-3601', patientId: 'SD-P-36', at: on(3, 16, 10, 30), kind: 'Follow-up', status: 'Completed', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'Thyroid and blood pressure review' },
  { id: 'AP-3602', patientId: 'SD-P-36', at: on(9, 18, 10, 45), kind: 'Investigation', status: 'Completed', clinic: 'Laboratory', with: 'Phlebotomy', purpose: 'Thyroid function, creatinine and potassium' },
  { id: 'AP-3603', patientId: 'SD-P-36', at: on(9, 21, 10, 15), kind: 'Teleconsult', status: 'Today', clinic: 'Teleconsult', with: 'Dr. Rajsrinivas', purpose: 'Levothyroxine dose review with the September results', location: 'Video' },
  { id: 'AP-3604', patientId: 'SD-P-36', at: on(11, 2, 9, 0), kind: 'Investigation', status: 'Booked', clinic: 'Laboratory', with: 'Phlebotomy', purpose: 'Thyroid function six weeks after the dose review', prepare: ['Take the levothyroxine after the blood test that morning'] },
  // SD-P-37 · Vignesh Ramalingam
  { id: 'AP-3701', patientId: 'SD-P-37', at: on(6, 15, 10, 0), kind: 'Follow-up', status: 'Completed', clinic: 'General Medicine OPD', with: 'Dr. Rajsrinivas', purpose: 'Diabetes review' },
  { id: 'AP-3702', patientId: 'SD-P-37', at: on(9, 19, 10, 15), kind: 'Investigation', status: 'Completed', clinic: 'Laboratory', with: 'Phlebotomy', purpose: 'HbA1c, fasting glucose, lipids, creatinine and urine albumin' },
  { id: 'AP-3703', patientId: 'SD-P-37', at: on(9, 21, 10, 25), kind: 'Teleconsult', status: 'Today', clinic: 'Teleconsult', with: 'Dr. Rajsrinivas', purpose: 'HbA1c review on metformin', location: 'Video' },
  { id: 'AP-3704', patientId: 'SD-P-37', at: on(10, 6, 16, 0), kind: 'Review', status: 'Booked', clinic: 'Diabetes clinic', with: 'Diabetes educator', purpose: 'Meal plan for night shifts', prepare: ['Bring a food diary for three working days'] },
  { id: 'AP-3705', patientId: 'SD-P-37', at: on(12, 19, 9, 0), kind: 'Investigation', status: 'Booked', clinic: 'Laboratory', with: 'Phlebotomy', purpose: 'HbA1c and fasting glucose', prepare: ['Fast from 10 PM the night before'] },
  // SD-P-38 · Ananya Iyer
  { id: 'AP-3801', patientId: 'SD-P-38', at: on(9, 10, 20, 0), kind: 'Review', status: 'Completed', clinic: 'Emergency', with: 'Emergency team', purpose: 'Right lower abdominal pain' },
  { id: 'AP-3802', patientId: 'SD-P-38', at: on(9, 11, 9, 30), kind: 'Procedure', status: 'Completed', clinic: 'OT-2', with: 'General surgeon', purpose: 'Laparoscopic appendectomy' },
  { id: 'AP-3803', patientId: 'SD-P-38', at: on(9, 21, 10, 30), kind: 'Teleconsult', status: 'Today', clinic: 'Teleconsult', with: 'Dr. Rajsrinivas', purpose: 'Wound check, 10 days after laparoscopic appendectomy', location: 'Video' },
  { id: 'AP-3804', patientId: 'SD-P-38', at: on(12, 14, 9, 0), kind: 'Investigation', status: 'Booked', clinic: 'Laboratory', with: 'Phlebotomy', purpose: 'Haemoglobin and ferritin after three months of iron', prepare: ['No fasting needed'] },
]

// ─────────────────────────────────────────────────────────────── Documents

export const TELE_DOCUMENTS: RecordReport[] = [
  { id: 'DOC-3601', patientId: 'SD-P-36', at: on(9, 18, 11, 10), kind: 'ECG', title: '12-lead ECG', by: 'OPD nursing', summary: 'Sinus rhythm 64. Normal axis. No left ventricular hypertrophy.' },
  { id: 'DOC-3602', patientId: 'SD-P-36', at: on(5, 10, 10, 0, 2021), kind: 'Ultrasound', title: 'Ultrasound of the thyroid', by: 'Radiology', summary: 'Diffusely heterogeneous gland of normal size, with no nodules. In keeping with thyroiditis.' },
  { id: 'DOC-3701', patientId: 'SD-P-37', at: on(6, 15, 11, 0), kind: 'Clinical photographs', title: 'Retinal photographs, both eyes', by: 'Ophthalmology', summary: 'No diabetic retinopathy in either eye. Repeat in a year.' },
  { id: 'DOC-3702', patientId: 'SD-P-37', at: on(6, 15, 10, 10), kind: 'ECG', title: '12-lead ECG', by: 'OPD nursing', summary: 'Sinus rhythm 76. No ischaemic change.' },
  { id: 'DOC-3801', patientId: 'SD-P-38', at: on(9, 10, 20, 15), kind: 'Ultrasound', title: 'Ultrasound of the abdomen and pelvis', by: 'Radiology', summary: 'Non-compressible appendix, 9 mm, with fat stranding around it and no collection. Both ovaries normal.' },
  { id: 'DOC-3802', patientId: 'SD-P-38', at: on(9, 11, 11, 0), kind: 'Operative note', title: 'Laparoscopic appendectomy, operative note', by: 'General surgeon', summary: 'Three ports. Inflamed appendix, not perforated, removed. No pus in the pelvis. Uncomplicated.' },
  {
    id: 'DOC-3803',
    patientId: 'SD-P-38',
    at: on(9, 20, 19, 40),
    kind: 'Clinical photographs',
    title: 'Teleconsult photographs of the wound, three port sites',
    by: 'Uploaded by the patient',
    summary: 'The navel and both lower port sites in daylight, for today’s day-10 wound check. Kept in the teleconsult store and not shown in this demo.',
  },
]

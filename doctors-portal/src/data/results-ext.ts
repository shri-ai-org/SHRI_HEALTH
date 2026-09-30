/**
 * M-09 · the later results — more blood tests for the fifteen on the record,
 * the series behind results already there, and microbiology: cultures with
 * their sensitivities, sputum microscopy and GeneXpert. Merged into
 * `RESULTS` and `RESULT_TRENDS` by `clinical.ts`, so the record, the results
 * inbox and the critical-acknowledgement gate read one list.
 *
 * The rules every value keeps:
 *   · it sits inside its reference range or is flagged against it, and is
 *     critical only past a critical limit;
 *   · a series ends on its row's own value, at its row's own time;
 *   · it agrees with the diagnosis, the notes, the vitals and the medicines —
 *     a culture's sensitivities with the antibiotic the patient is on;
 *   · a normal result is filed as reviewed; an abnormal one from today waits
 *     to be reviewed; an earlier one was reviewed when it came back;
 *   · the reason line says what the value is against its range and its last
 *     value — a description, never a prediction.
 * The first results are in `clinical.ts`.
 */

import type { ConfidenceBand } from '@/atlas/confidence'

import type { ResultRow } from './clinical'
import { minutesAgo } from './format'

type Flag = ResultRow['flag']

/** One result row, in the table's order: who, what, the value against its range, when, and whether it has been seen. */
function row(
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
  const band: ConfidenceBand = 'HIGH'
  return {
    id,
    patientId,
    test,
    value,
    unit,
    refRange,
    flag,
    reportedAt,
    critical: flag.includes('Critical'),
    acknowledged: flag === 'Normal',
    aiReason: reason,
    band,
    ...extra,
  }
}

const d = (m: number, day: number, h: number, min = 0, y = 2026) => new Date(y, m - 1, day, h, min)
/** Reviewed when it came back — an earlier visit's result. */
const seen = { acknowledged: true }

export const RESULTS_EXT: ResultRow[] = [
  // ── SD-P-01 · Meera Krishnan — hypothyroid, iron deficiency
  row('R-90101', 'SD-P-01', 'Anti-TPO antibodies', '210', 'IU/mL', '< 34', '↑ High', d(3, 16, 10, 0), 'Well above range — the antibody behind the thyroiditis on the March ultrasound', { ...seen, refLow: 0, refHigh: 34 }),
  row('R-90102', 'SD-P-01', 'Vitamin B12', '412', 'pg/mL', '200 – 900', 'Normal', d(9, 18, 11, 20), 'Within range', { refLow: 200, refHigh: 900 }),

  // ── SD-P-02 · Abdul Rahman Sheikh — day 2 after CABG ×3
  row('R-90201', 'SD-P-02', 'HbA1c', '7.2', '%', '4.0 – 5.6', '↑ High', d(9, 12, 9, 30), 'Above range at the pre-operative assessment, on metformin', { ...seen, refLow: 4, refHigh: 5.6 }),
  row('R-90202', 'SD-P-02', 'Serum creatinine', '98', 'µmol/L', '62 – 106', 'Normal', minutesAgo(150), 'Within range after bypass', { refLow: 62, refHigh: 106 }),
  row('R-90203', 'SD-P-02', 'Serum lactate', '1.3', 'mmol/L', '0.5 – 2.0', 'Normal', d(9, 20, 6, 0), 'Within range', { refLow: 0.5, refHigh: 2 }),
  row('R-90204', 'SD-P-02', 'INR', '1.1', '', '0.8 – 1.2', 'Normal', minutesAgo(150), 'Within range', { refLow: 0.8, refHigh: 1.2 }),

  // ── SD-P-03 · R. Lakshmanan — pneumonia, 72 h of antibiotics, deteriorating
  row('R-90301', 'SD-P-03', 'Serum sodium', '131', 'mmol/L', '135 – 145', '↓ Low', minutesAgo(120), 'Below range and down 5 since admission', { priorValue: '133', delta: '−2 in 24h', refLow: 135, refHigh: 145 }),
  row('R-90302', 'SD-P-03', 'Serum lactate', '2.6', 'mmol/L', '0.5 – 2.0', '↑ High', minutesAgo(120), 'Above range for the first time this admission', { priorValue: '1.9', delta: '+0.7 in 24h', refLow: 0.5, refHigh: 2 }),
  row('R-90303', 'SD-P-03', 'Procalcitonin', '3.8', 'ng/mL', '< 0.5', '↑ High', minutesAgo(120), 'Up again after falling to 1.2 on day 2', { priorValue: '1.2', delta: '+2.6 in 48h', refLow: 0, refHigh: 0.5 }),

  // ── SD-P-04 · Sunita Devi — 32 weeks, gestational diabetes
  row('R-90401', 'SD-P-04', 'HbA1c', '5.9', '%', '4.0 – 5.6', '↑ High', d(9, 19, 10, 0), 'Above range, drawn with the glucose tolerance test', { refLow: 4, refHigh: 5.6 }),
  row('R-90402', 'SD-P-04', 'TSH', '2.1', 'mIU/L', '0.3 – 3.0 (third trimester)', 'Normal', d(9, 19, 10, 0), 'Within the third-trimester range', { refLow: 0.3, refHigh: 3 }),

  // ── SD-P-05 · Vikram Malhotra — left MCA occlusion, thrombolysed at the spoke
  row('R-90501', 'SD-P-05', 'Serum creatinine', '88', 'µmol/L', '62 – 106', 'Normal', d(9, 21, 2, 30), 'Within range before contrast', { refLow: 62, refHigh: 106 }),
  row('R-90502', 'SD-P-05', 'APTT', '29', 's', '25 – 35', 'Normal', d(9, 21, 2, 30), 'Within range before thrombolysis', { refLow: 25, refHigh: 35 }),
  row('R-90503', 'SD-P-05', 'Troponin I (hs)', '9', 'ng/L', '< 34', 'Normal', d(9, 21, 2, 30), 'Within range', { refLow: 0, refHigh: 34 }),
  row('R-90504', 'SD-P-05', 'Serum sodium', '139', 'mmol/L', '135 – 145', 'Normal', d(9, 21, 2, 30), 'Within range', { refLow: 135, refHigh: 145 }),
  row('R-90505', 'SD-P-05', 'LDL cholesterol', '3.8', 'mmol/L', '< 2.6', '↑ High', d(9, 21, 6, 0), 'Above the secondary-prevention target', { refLow: 0, refHigh: 2.6 }),
  row('R-90506', 'SD-P-05', 'HbA1c', '6.3', '%', '4.0 – 5.6', '↑ High', d(9, 21, 6, 0), 'Above range — no diabetes on record', { refLow: 4, refHigh: 5.6 }),

  // ── SD-P-06 · Kavya Reddy — 6 years, febrile illness
  row('R-90601', 'SD-P-06', 'Platelets', '190', '×10⁹/L', '150 – 410', 'Normal', d(9, 20, 9, 0), 'Within range, up from 160 the evening before', { priorValue: '160', delta: '+30 in 15h', refLow: 150, refHigh: 410 }),
  row('R-90602', 'SD-P-06', 'White cell count', '4.2', '×10⁹/L', '5.0 – 14.5 (age 6)', '↓ Low', d(9, 20, 9, 0), 'Below the range for her age', { refLow: 5, refHigh: 14.5 }),
  row('R-90603', 'SD-P-06', 'Haemoglobin', '11.8', 'g/dL', '11.5 – 15.5 (age 6)', 'Normal', d(9, 20, 9, 0), 'Within the range for her age', { refLow: 11.5, refHigh: 15.5 }),
  row('R-90604', 'SD-P-06', 'Urine routine', 'No pus cells · protein nil', '', 'No pus cells · nil', 'Normal', d(9, 19, 13, 0), 'No sign of a urinary infection'),

  // ── SD-P-07 · Joseph Mathew — septic shock from a urinary source, day 7
  row('R-90701', 'SD-P-07', 'Serum lactate', '2.9', 'mmol/L', '0.5 – 2.0', '↑ High', minutesAgo(95), 'Up from 2.2 yesterday, after falling from 5.8 on admission', { priorValue: '2.2', delta: '+0.7 in 26h', refLow: 0.5, refHigh: 2 }),
  row('R-90702', 'SD-P-07', 'White cell count', '21.4', '×10⁹/L', '4.0 – 11.0', '↑ High', minutesAgo(95), 'Up from 16.9 two days ago', { priorValue: '16.9', delta: '+4.5 in 48h', refLow: 4, refHigh: 11 }),
  row('R-90703', 'SD-P-07', 'Serum sodium', '146', 'mmol/L', '135 – 145', '↑ High', minutesAgo(95), 'Just above range', { refLow: 135, refHigh: 145 }),

  // ── SD-P-09 · Fatima Bi — end-stage kidney disease, thrice-weekly dialysis
  row('R-90901', 'SD-P-09', 'Serum albumin', '3.2', 'g/dL', '3.5 – 5.0', '↓ Low', d(9, 19, 7, 0), 'Below range on the monthly dialysis bloods', { ...seen, refLow: 3.5, refHigh: 5 }),
  row('R-90902', 'SD-P-09', 'Intact PTH', '486', 'pg/mL', '15 – 65', '↑ High', d(9, 19, 7, 0), 'Above range, with the phosphate also high', { ...seen, refLow: 15, refHigh: 65 }),
  row('R-90903', 'SD-P-09', 'Blood urea (pre-dialysis)', '24.6', 'mmol/L', '2.5 – 7.8', '↑ High', d(9, 19, 7, 0), 'Pre-dialysis value, as expected between sessions', { ...seen, refLow: 2.5, refHigh: 7.8 }),
  row('R-90904', 'SD-P-09', 'Hepatitis B surface antigen', 'Negative', '', 'Negative', 'Normal', d(9, 19, 7, 0), 'The dialysis unit’s quarterly screen'),
  row('R-90905', 'SD-P-09', 'Hepatitis C antibody', 'Negative', '', 'Negative', 'Normal', d(9, 19, 7, 0), 'The dialysis unit’s quarterly screen'),
  row('R-90906', 'SD-P-09', 'HIV 1 and 2 antibodies', 'Non-reactive', '', 'Non-reactive', 'Normal', d(9, 19, 7, 0), 'The dialysis unit’s quarterly screen'),

  // ── SD-P-10 · Arjun Nair — isotretinoin, week 6 bloods
  row('R-91001', 'SD-P-10', 'AST', '26', 'U/L', '10 – 40', 'Normal', d(9, 12, 9, 30), 'Within range', { refLow: 10, refHigh: 40 }),
  row('R-91002', 'SD-P-10', 'Total cholesterol', '172', 'mg/dL', '< 200', 'Normal', d(9, 12, 9, 30), 'Within range, up from 158 before treatment', { priorValue: '158', refLow: 0, refHigh: 200 }),

  // ── SD-P-11 · Selvi Murugan — three weeks after subdural evacuation
  row('R-91101', 'SD-P-11', 'Platelets', '212', '×10⁹/L', '150 – 410', 'Normal', minutesAgo(60), 'Within range', { refLow: 150, refHigh: 410 }),

  // ── SD-P-12 · Kumar Subramanian — left thalamic haemorrhage, day 3
  row('R-91201', 'SD-P-12', 'Capillary glucose', '132', 'mg/dL', '70 – 140', 'Normal', minutesAgo(130), 'Within range, down from 168 on arrival', { priorValue: '140', refLow: 70, refHigh: 140 }),
  row('R-91202', 'SD-P-12', 'Serum sodium', '138', 'mmol/L', '135 – 145', 'Normal', minutesAgo(130), 'Within range', { refLow: 135, refHigh: 145 }),
  row('R-91203', 'SD-P-12', 'Platelets', '256', '×10⁹/L', '150 – 410', 'Normal', d(9, 18, 23, 10), 'Within range', { refLow: 150, refHigh: 410 }),
  row('R-91204', 'SD-P-12', 'APTT', '31', 's', '25 – 35', 'Normal', d(9, 18, 23, 10), 'Within range', { refLow: 25, refHigh: 35 }),

  // ── SD-P-13 · Priya Raman — large right MCA infarct, on hypertonic saline
  row('R-91301', 'SD-P-13', 'Serum osmolality', '276', 'mOsm/kg', '275 – 295', 'Normal', minutesAgo(90), 'Within range', { refLow: 275, refHigh: 295 }),
  row('R-91302', 'SD-P-13', 'HbA1c', '7.8', '%', '4.0 – 5.6', '↑ High', d(9, 21, 6, 0), 'Above range — no diabetes on record', { refLow: 4, refHigh: 5.6 }),
  row('R-91303', 'SD-P-13', 'LDL cholesterol', '3.4', 'mmol/L', '< 2.6', '↑ High', d(9, 21, 6, 0), 'Above the secondary-prevention target', { refLow: 0, refHigh: 2.6 }),
  row('R-91304', 'SD-P-13', 'INR', '1.0', '', '0.8 – 1.2', 'Normal', d(9, 20, 18, 20), 'Within range', { refLow: 0.8, refHigh: 1.2 }),

  // ── SD-P-14 · Santhosh Babu — basal ganglia haemorrhage on warfarin
  row('R-91401', 'SD-P-14', 'APTT', '42', 's', '25 – 35', '↑ High', d(9, 21, 2, 40), 'Above range, on warfarin', { refLow: 25, refHigh: 35 }),
  row('R-91402', 'SD-P-14', 'Platelets', '198', '×10⁹/L', '150 – 410', 'Normal', d(9, 21, 2, 40), 'Within range', { refLow: 150, refHigh: 410 }),
  row('R-91403', 'SD-P-14', 'Serum creatinine', '102', 'µmol/L', '62 – 106', 'Normal', d(9, 21, 2, 40), 'Within range', { refLow: 62, refHigh: 106 }),
  row('R-91404', 'SD-P-14', 'Blood group and antibody screen', 'B positive · screen negative', '', '—', 'Normal', d(9, 21, 2, 55), 'Grouped for reversal and theatre'),

  // ── SD-P-16 · Rahul Verma — minor head injury, the bloods in Emergency
  row('R-91601', 'SD-P-16', 'Capillary glucose', '104', 'mg/dL', '70 – 140', 'Normal', d(9, 14, 23, 5), 'Within range', { refLow: 70, refHigh: 140 }),
  row('R-91602', 'SD-P-16', 'Platelets', '248', '×10⁹/L', '150 – 410', 'Normal', d(9, 14, 23, 30), 'Within range', { refLow: 150, refHigh: 410 }),

  // ── SD-P-15 · Lakshmi Narayanan — migraine
  row('R-91501', 'SD-P-15', 'TSH', '1.8', 'mIU/L', '0.4 – 4.0', 'Normal', d(9, 9, 10, 0), 'Within range', { refLow: 0.4, refHigh: 4 }),
]

/** The series behind these results, and behind results in `clinical.ts` that had none — never replacing one it had. Each ends on its row. */
export const RESULT_TRENDS_EXT: Record<string, { at: Date; value: number }[]> = {
  // SD-P-01 — haemoglobin, March to now
  'R-89020': [
    { at: d(3, 16, 10, 0), value: 12.2 },
    { at: d(9, 18, 11, 20), value: 11.9 },
  ],
  // SD-P-02 — haemoglobin across surgery
  'R-89030': [
    { at: d(9, 12, 9, 30), value: 13.4 },
    { at: d(9, 19, 18, 0), value: 10.9 },
    { at: d(9, 20, 6, 10), value: 10.4 },
    { at: minutesAgo(150), value: 9.8 },
  ],
  // SD-P-03
  'R-90301': [
    { at: d(9, 17, 15, 0), value: 136 },
    { at: d(9, 19, 6, 30), value: 134 },
    { at: d(9, 20, 6, 30), value: 133 },
    { at: minutesAgo(120), value: 131 },
  ],
  'R-90302': [
    { at: d(9, 17, 15, 0), value: 1.8 },
    { at: d(9, 20, 6, 30), value: 1.9 },
    { at: minutesAgo(120), value: 2.6 },
  ],
  'R-90303': [
    { at: d(9, 17, 15, 0), value: 2.1 },
    { at: d(9, 19, 6, 30), value: 1.2 },
    { at: minutesAgo(120), value: 3.8 },
  ],
  // SD-P-04 — haemoglobin on iron, from the booking visit
  'R-89040': [
    { at: d(7, 20, 10, 0), value: 10.4 },
    { at: d(9, 19, 10, 0), value: 10.6 },
  ],
  // SD-P-06
  'R-90601': [
    { at: d(9, 19, 17, 30), value: 160 },
    { at: d(9, 20, 9, 0), value: 190 },
  ],
  // SD-P-07 — lactate, white cells and platelets since admission
  'R-90701': [
    { at: d(9, 15, 4, 0), value: 5.8 },
    { at: d(9, 16, 6, 0), value: 3.6 },
    { at: d(9, 18, 6, 0), value: 2.4 },
    { at: d(9, 20, 5, 0), value: 2.2 },
    { at: minutesAgo(95), value: 2.9 },
  ],
  'R-90702': [
    { at: d(9, 15, 4, 0), value: 24.8 },
    { at: d(9, 17, 6, 0), value: 18.2 },
    { at: d(9, 19, 7, 5), value: 16.9 },
    { at: minutesAgo(95), value: 21.4 },
  ],
  'R-89002': [
    { at: d(9, 15, 4, 0), value: 196 },
    { at: d(9, 17, 6, 0), value: 142 },
    { at: d(9, 19, 6, 0), value: 124 },
    { at: d(9, 20, 7, 5), value: 112 },
    { at: minutesAgo(95), value: 84 },
  ],
  // SD-P-09 — monthly dialysis bloods
  'R-89071': [
    { at: d(7, 18, 7, 0), value: 9.8 },
    { at: d(8, 19, 7, 0), value: 9.4 },
    { at: d(9, 19, 7, 0), value: 9.1 },
  ],
  'R-89072': [
    { at: d(7, 18, 7, 0), value: 1.6 },
    { at: d(8, 19, 7, 0), value: 1.8 },
    { at: d(9, 19, 7, 0), value: 1.9 },
  ],
  // SD-P-10 — baseline before isotretinoin, and week 6
  'R-89080': [
    { at: d(7, 28, 9, 30), value: 24 },
    { at: d(9, 12, 9, 30), value: 28 },
  ],
  'R-89081': [
    { at: d(7, 28, 9, 30), value: 112 },
    { at: d(9, 12, 9, 30), value: 138 },
  ],
  // SD-P-10 — cholesterol before treatment and at week 6
  'R-91002': [
    { at: d(7, 28, 9, 30), value: 158 },
    { at: d(9, 12, 9, 30), value: 172 },
  ],
  // SD-P-15 — ESR, March and September
  'R-89150': [
    { at: d(3, 10, 10, 0), value: 10 },
    { at: d(9, 9, 10, 0), value: 12 },
  ],
  // SD-P-11 — haemoglobin since the evacuation
  'R-89111': [
    { at: d(8, 31, 22, 0), value: 9.6 },
    { at: d(9, 7, 10, 0), value: 10.1 },
    { at: minutesAgo(60), value: 11.2 },
  ],
  // SD-P-12 — glucose on the stroke unit
  'R-91201': [
    { at: d(9, 18, 22, 50), value: 168 },
    { at: d(9, 19, 6, 0), value: 148 },
    { at: d(9, 20, 6, 0), value: 140 },
    { at: minutesAgo(130), value: 132 },
  ],
  // SD-P-13 — glucose rising on the stroke unit
  'R-89131': [
    { at: d(9, 20, 18, 10), value: 148 },
    { at: d(9, 21, 1, 10), value: 162 },
    { at: minutesAgo(90), value: 188 },
  ],
  // SD-P-15
  'R-89151': [
    { at: d(3, 10, 10, 0), value: 12.4 },
    { at: d(9, 9, 10, 0), value: 12.9 },
  ],
}

// ──────────────────────────────────────────────────────────────── Microbiology

export type Susceptibility = 'S' | 'I' | 'R'

export interface MicroResult {
  id: string
  patientId: string
  /** "Blood culture — set 1 of 2", "Sputum Gram stain and culture", "Sputum GeneXpert MTB/RIF". */
  test: string
  specimen: 'Blood' | 'Urine' | 'Sputum' | 'Tracheal aspirate' | 'Wound swab' | 'Screening swab' | 'CSF'
  collectedAt: Date
  reportedAt: Date
  status: 'Preliminary' | 'Final'
  /** The microscopy, where there is one. */
  gram?: string
  /** What grew — an organism, "No growth at 5 days", or a molecular result. */
  growth: string
  /** Colony count, where the lab reports one. */
  count?: string
  /** Susceptibility by drug, as the lab reports it. */
  sensitivities?: { drug: string; result: Susceptibility }[]
  /** Anything the lab added. */
  comment?: string
}

/** The ESBL E. coli from SD-P-07's urine and blood — the same organism, the same pattern. */
const ESBL_ECOLI_BLOOD: { drug: string; result: Susceptibility }[] = [
  { drug: 'Meropenem', result: 'S' },
  { drug: 'Amikacin', result: 'S' },
  { drug: 'Piperacillin-tazobactam', result: 'I' },
  { drug: 'Ceftriaxone', result: 'R' },
  { drug: 'Ciprofloxacin', result: 'R' },
  { drug: 'Co-trimoxazole', result: 'R' },
]

export const MICRO_RESULTS: MicroResult[] = [
  // SD-P-03 — pneumonia with no organism yet, as the record says
  {
    id: 'M-7301',
    patientId: 'SD-P-03',
    test: 'Sputum Gram stain and culture',
    specimen: 'Sputum',
    collectedAt: d(9, 17, 18, 0),
    reportedAt: d(9, 20, 9, 0),
    status: 'Final',
    gram: 'Many pus cells, few epithelial cells. Mixed Gram-positive and Gram-negative organisms.',
    growth: 'Normal upper respiratory flora only — no pathogen isolated',
  },
  {
    id: 'M-7302',
    patientId: 'SD-P-03',
    test: 'Sputum GeneXpert MTB/RIF',
    specimen: 'Sputum',
    collectedAt: d(9, 18, 7, 0),
    reportedAt: d(9, 18, 16, 0),
    status: 'Final',
    growth: 'MTB not detected',
    comment: 'Rifampicin resistance not applicable.',
  },
  // SD-P-02 — the screen before cardiac surgery
  {
    id: 'M-7201',
    patientId: 'SD-P-02',
    test: 'MRSA screen — nose and groin',
    specimen: 'Screening swab',
    collectedAt: d(9, 12, 9, 30),
    reportedAt: d(9, 13, 16, 0),
    status: 'Final',
    growth: 'MRSA not detected',
  },
  // SD-P-04 — the booking visit's screen for bacteria in the urine
  {
    id: 'M-7401',
    patientId: 'SD-P-04',
    test: 'Urine culture (antenatal screen)',
    specimen: 'Urine',
    collectedAt: d(7, 20, 10, 30),
    reportedAt: d(7, 22, 11, 0),
    status: 'Final',
    growth: 'No growth',
  },
  // SD-P-06 — the fever work-up; five days before it is final
  {
    id: 'M-7601',
    patientId: 'SD-P-06',
    test: 'Blood culture',
    specimen: 'Blood',
    collectedAt: d(9, 19, 11, 30),
    reportedAt: d(9, 21, 7, 30),
    status: 'Preliminary',
    growth: 'No growth at 48 hours',
    comment: 'Final report at 5 days.',
  },
  // SD-P-07 — the urinary source, and the same organism in both blood-culture sets
  {
    id: 'M-7701',
    patientId: 'SD-P-07',
    test: 'Urine culture',
    specimen: 'Urine',
    collectedAt: d(9, 15, 3, 30),
    reportedAt: d(9, 17, 10, 0),
    status: 'Final',
    gram: 'Pus cells > 50 per high-power field. Gram-negative bacilli.',
    growth: 'Escherichia coli, ESBL-producing',
    count: '> 10⁵ CFU/mL',
    sensitivities: [...ESBL_ECOLI_BLOOD.slice(0, 2), { drug: 'Nitrofurantoin', result: 'S' }, ...ESBL_ECOLI_BLOOD.slice(2)],
  },
  {
    id: 'M-7702',
    patientId: 'SD-P-07',
    test: 'Blood culture — set 1 of 2',
    specimen: 'Blood',
    collectedAt: d(9, 15, 3, 20),
    reportedAt: d(9, 17, 14, 0),
    status: 'Final',
    gram: 'Gram-negative bacilli seen at 14 hours.',
    growth: 'Escherichia coli, ESBL-producing',
    sensitivities: ESBL_ECOLI_BLOOD,
  },
  {
    id: 'M-7703',
    patientId: 'SD-P-07',
    test: 'Blood culture — set 2 of 2',
    specimen: 'Blood',
    collectedAt: d(9, 15, 3, 25),
    reportedAt: d(9, 17, 14, 0),
    status: 'Final',
    gram: 'Gram-negative bacilli seen at 16 hours.',
    growth: 'Escherichia coli, ESBL-producing',
    sensitivities: ESBL_ECOLI_BLOOD,
    comment: 'Same organism and pattern as set 1 and the urine.',
  },
]

/** Newest first. */
export function microFor(patientId: string): MicroResult[] {
  return MICRO_RESULTS.filter((m) => m.patientId === patientId).sort((a, b) => b.reportedAt.getTime() - a.reportedAt.getTime())
}

/**
 * The allergy on the record that a drug in a sensitivity list belongs to —
 * shown beside the drug, so a "sensitive" is never read as a choice for a
 * patient who cannot have it.
 */
const ALLERGY_CLASS: Record<string, string> = {
  'Co-trimoxazole': 'Sulfa',
  'Piperacillin-tazobactam': 'Penicillin',
  Amoxicillin: 'Penicillin',
  'Amoxicillin-clavulanate': 'Penicillin',
  Penicillin: 'Penicillin',
  Ampicillin: 'Penicillin',
}

export function allergyFor(drug: string, allergies: string[]): string | undefined {
  const cls = ALLERGY_CLASS[drug]
  return cls && allergies.some((a) => a.toLowerCase() === cls.toLowerCase()) ? cls : undefined
}

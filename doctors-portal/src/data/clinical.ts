/**
 * Clinical records derived from the §8 cast. Every value traces to a screen
 * spec's "Sample data" line — nothing here is invented (§8.6).
 *
 * The three that carry the demo:
 *   S-06-01  "SD-S-01 at 08:40 — 18 in clinic, 6 inpatients (SD-P-03 risk
 *             HIGH), 3 results to review, 2 co-signs pending."
 *   S-06-03  "SD-P-01 thyroid follow-up with SD-S-01; four sections drafted,
 *             one at MED confidence."
 *   S-06-07  "SD-P-03, documented penicillin allergy, co-amoxiclav 1.2g IV
 *             proposed → hard stop, three alternatives offered."
 */

import type { ConfidenceBand } from '@/atlas/confidence'
import type { Gate } from '@/atlas/gates'

import { minutesAgo, minutesAhead } from './format'

// ───────────────────────────────────────────────────────────────── Encounters

export type EncounterType = 'OP' | 'IP' | 'ED' | 'TELE'

export interface Encounter {
  id: string
  /** M-06.8 — display format `OP/{fy}/{seq}`. FY 26-27. */
  encounterNo: string
  patientId: string
  type: EncounterType
  startedAt: Date
  consultantStaffId: string
  department: string
  /** OP queue token, where there is one. */
  token?: string
  ward?: string
}

export const ENCOUNTERS: Encounter[] = [
  {
    id: 'E-118402',
    encounterNo: 'OP/26-27/118402',
    patientId: 'SD-P-01',
    type: 'OP',
    startedAt: minutesAgo(6),
    consultantStaffId: 'SD-S-01',
    department: 'General Medicine',
    token: 'MED-042',
  },
  {
    id: 'E-118366',
    encounterNo: 'IP/26-27/118366',
    patientId: 'SD-P-03',
    type: 'IP',
    startedAt: new Date(2026, 8, 17, 14, 20),
    consultantStaffId: 'SD-S-01',
    department: 'General Medicine',
    ward: '4B',
  },
  {
    id: 'E-118201',
    encounterNo: 'IP/26-27/118201',
    patientId: 'SD-P-07',
    type: 'IP',
    startedAt: new Date(2026, 8, 15, 3, 10),
    consultantStaffId: 'SD-S-01',
    department: 'Critical Care',
    ward: 'ICU-1',
  },
  {
    id: 'E-118380',
    encounterNo: 'IP/26-27/118380',
    patientId: 'SD-P-02',
    type: 'IP',
    startedAt: new Date(2026, 8, 19, 9, 0),
    consultantStaffId: 'SD-S-01',
    department: 'Cardiothoracic Surgery',
    ward: '2A',
  },
  {
    id: 'E-118421',
    encounterNo: 'ED/26-27/118421',
    patientId: 'SD-P-05',
    type: 'ED',
    startedAt: minutesAgo(34),
    consultantStaffId: 'SD-S-03',
    department: 'Emergency',
    ward: 'ED',
  },
  {
    id: 'E-118430',
    encounterNo: 'OP/26-27/118430',
    patientId: 'SD-P-10',
    type: 'TELE',
    startedAt: minutesAhead(25),
    consultantStaffId: 'SD-S-01',
    department: 'Dermatology',
  },
  // ── The CT patients.
  {
    id: 'E-118455',
    encounterNo: 'OP/26-27/118455',
    patientId: 'SD-P-11',
    type: 'OP',
    startedAt: minutesAgo(14),
    consultantStaffId: 'SD-S-01',
    department: 'General Medicine',
    token: 'MED-045',
  },
  {
    id: 'E-118340',
    encounterNo: 'IP/26-27/118340',
    patientId: 'SD-P-12',
    type: 'IP',
    startedAt: new Date(2026, 8, 18, 22, 25),
    consultantStaffId: 'SD-S-01',
    department: 'Neurology (stroke unit)',
    ward: '4B',
  },
  {
    id: 'E-118415',
    encounterNo: 'IP/26-27/118415',
    patientId: 'SD-P-13',
    type: 'IP',
    startedAt: new Date(2026, 8, 20, 17, 45),
    consultantStaffId: 'SD-S-01',
    department: 'Neurology (stroke unit)',
    ward: '4B',
  },
  {
    id: 'E-118436',
    encounterNo: 'ED/26-27/118436',
    patientId: 'SD-P-14',
    type: 'ED',
    startedAt: new Date(2026, 8, 21, 2, 16),
    consultantStaffId: 'SD-S-02',
    department: 'Emergency (Tiruppur)',
    ward: 'ICU-2',
  },
  {
    id: 'E-118460',
    encounterNo: 'OP/26-27/118460',
    patientId: 'SD-P-15',
    type: 'OP',
    startedAt: minutesAhead(22),
    consultantStaffId: 'SD-S-01',
    department: 'General Medicine',
    token: 'MED-046',
  },
  {
    id: 'E-118398',
    encounterNo: 'OP/26-27/118398',
    patientId: 'SD-P-16',
    type: 'OP',
    startedAt: minutesAgo(70),
    consultantStaffId: 'SD-S-01',
    department: 'General Medicine',
    token: 'MED-036',
  },
]

const encountersById = new Map(ENCOUNTERS.map((e) => [e.id, e]))

export function encounter(id: string): Encounter {
  const e = encountersById.get(id)
  if (!e) throw new Error(`Unknown encounter ${id}`)
  return e
}

export function maybeEncounter(id: string | undefined): Encounter | undefined {
  return id ? encountersById.get(id) : undefined
}

export function encounterForPatient(patientId: string): Encounter | undefined {
  return ENCOUNTERS.find((e) => e.patientId === patientId)
}

// ─────────────────────────────────────────── Note sections (AIP-01 ghost text)

export type SectionKey = 'subjective' | 'objective' | 'assessment' | 'plan'

export interface NoteSectionSeed {
  key: SectionKey
  label: string
  /** Which capability drafted it. */
  ai: string
  gate: Gate
  /** The ghost text, as the model produced it. */
  draft: string
  confidence: number
  band: ConfidenceBand
  /**
   * AI-101's explainability is stronger than the default: "the transcript span
   * behind each sentence". This is what the Why? drawer shows.
   */
  transcriptSpan: string
  /** C-42 panel 2 — "What it used", each clickable back to its source record. */
  inputs: { label: string; source: string }[]
}

/**
 * S-06-03 · SD-P-01 thyroid follow-up with SD-S-01.
 * Four sections drafted, one at MED confidence — drawn expanded and unselected
 * per §4.5, because MED must never arrive pre-selected.
 */
export const NOTE_DRAFT_SD_P_01: NoteSectionSeed[] = [
  {
    key: 'subjective',
    label: 'Subjective',
    ai: 'AI-101',
    gate: 'G2',
    draft:
      'Attends for routine review of primary hypothyroidism, diagnosed 2019. Reports good adherence to levothyroxine 75 mcg once daily on an empty stomach. Fatigue has improved substantially since the last visit; no cold intolerance, constipation or hoarseness. Weight stable. Menstrual cycles regular. No palpitations, tremor or heat intolerance to suggest over-replacement.',
    confidence: 0.93,
    band: 'HIGH',
    transcriptSpan:
      '"…so the tiredness is much better than last time, I take the tablet first thing before breakfast, never missed it…"',
    inputs: [
      { label: 'Dictated transcript, 06:12 of session', source: 'AI-101 session 08:34' },
      { label: 'Prior consultation 14-Mar-2026', source: 'NOTE/117204/01' },
      { label: 'Active medication list', source: 'RX/25-26/498210' },
    ],
  },
  {
    key: 'objective',
    label: 'Objective',
    ai: 'AI-103',
    gate: 'G2',
    draft:
      'Alert, comfortable. Pulse 76 regular, BP 118/74, temperature 36.8 °C, SpO₂ 99% on air, weight 58 kg. No periorbital puffiness. Thyroid not palpably enlarged, no nodule, no bruit. Reflexes normal with no delayed relaxation phase. Cardiovascular and respiratory examination unremarkable.',
    confidence: 0.88,
    band: 'HIGH',
    transcriptSpan: '"…pulse is seventy-six, pressure one-eighteen over seventy-four, no goitre…"',
    inputs: [
      { label: 'Vitals captured 08:31 by Sr. Lalitha Raman', source: 'Vitals 21-Sep-2026 08:31' },
      { label: 'Dictated transcript, 09:40 of session', source: 'AI-101 session 08:34' },
    ],
  },
  {
    /**
     * The MED-confidence section. §4.5: delivered expanded with NO
     * pre-selection. The drawing note for S-06-03 asks for exactly one.
     */
    key: 'assessment',
    label: 'Assessment',
    ai: 'AI-103',
    gate: 'G2',
    draft:
      'Primary hypothyroidism, clinically and biochemically euthyroid on the current dose. TSH 2.4 mIU/L on 18-Sep-2026, within target. Symptom improvement is consistent with adequate replacement rather than a dose change being required.',
    confidence: 0.71,
    band: 'MED',
    transcriptSpan: '"…I think she is euthyroid now, the TSH came back at two point four…"',
    inputs: [
      { label: 'TSH 2.4 mIU/L, 18-Sep-2026', source: 'Result R-88210' },
      { label: 'Free T4 14.2 pmol/L, 18-Sep-2026', source: 'Result R-88211' },
      { label: 'Dictated transcript, 11:02 of session', source: 'AI-101 session 08:34' },
    ],
  },
  {
    key: 'plan',
    label: 'Plan',
    ai: 'AI-103',
    gate: 'G2',
    draft:
      'Continue levothyroxine 75 mcg once daily, unchanged. Repeat TSH and free T4 in six months. Advised to maintain a consistent four-hour gap from calcium and iron supplements. Review in six months, or sooner if symptoms recur. Written instructions issued in English and Kannada.',
    confidence: 0.9,
    band: 'HIGH',
    transcriptSpan: '"…keep the same dose, repeat thyroid function in six months, see me then…"',
    inputs: [
      { label: 'Current medication list', source: 'RX/25-26/498210' },
      { label: 'Departmental follow-up interval protocol', source: 'Endocrine SOP v3.1' },
    ],
  },
]

/** S-08-04 · SD-P-03 ward-round note, drafted by the AI-102 round scribe. */
export const NOTE_DRAFT_SD_P_03: NoteSectionSeed[] = [
  {
    key: 'subjective',
    label: 'Subjective',
    ai: 'AI-102',
    gate: 'G2',
    draft:
      'Day 4 of admission for community-acquired pneumonia. Breathlessness worse overnight; required increased oxygen from 2 L to 4 L via nasal cannula at 04:20. Productive cough continues with rust-coloured sputum. Slept poorly. Appetite poor, taking only sips.',
    confidence: 0.89,
    band: 'HIGH',
    transcriptSpan: '"…he was more breathless from about four this morning, nurses went up to four litres…"',
    inputs: [
      { label: 'Nursing note 04:25', source: 'Nursing 21-Sep-2026 04:25' },
      { label: 'Oxygen delivery record', source: 'Flowsheet 21-Sep-2026' },
    ],
  },
  {
    key: 'objective',
    label: 'Objective',
    ai: 'AI-103',
    gate: 'G2',
    draft:
      'Ill-looking, using accessory muscles. Respiratory rate 26, SpO₂ 92% on 4 L, pulse 108, BP 104/62, temperature 38.4 °C. NEWS2 7, rising over the last four hours. Coarse crackles and bronchial breathing at the right base with reduced air entry. Heart sounds normal. No peripheral oedema.',
    confidence: 0.91,
    band: 'HIGH',
    transcriptSpan: '"…respiratory rate is twenty-six, saturations ninety-two on four litres, still febrile…"',
    inputs: [
      { label: 'Vitals 21-Sep-2026 07:50', source: 'Flowsheet 07:50' },
      { label: 'AI-201 deterioration score, NEWS2 7', source: 'AI-201 21-Sep-2026 07:52' },
    ],
  },
  {
    key: 'assessment',
    label: 'Assessment',
    ai: 'AI-103',
    gate: 'G2',
    draft:
      'Community-acquired pneumonia (J18.9), right lower lobe, not responding adequately to current therapy at 72 hours. Rising NEWS2 and increasing oxygen requirement indicate clinical deterioration. Differential includes empyema, resistant organism and a secondary hospital-acquired process.',
    confidence: 0.68,
    band: 'MED',
    transcriptSpan: '"…he is not turning the corner at seventy-two hours, I want to rethink the cover…"',
    inputs: [
      { label: 'CRP 184 mg/L, 21-Sep-2026 06:40', source: 'Result R-88402' },
      { label: 'Blood culture, no growth at 48h', source: 'Result R-88310' },
      { label: 'Chest X-ray PA 19-Sep-2026', source: 'Study ST-4471' },
    ],
  },
  {
    key: 'plan',
    label: 'Plan',
    ai: 'AI-103',
    gate: 'G2',
    draft:
      'Escalate antimicrobial cover after review of the allergy record. Repeat chest imaging today to exclude an effusion or empyema. Repeat CBC, CRP and renal function. Continue oxygen titrated to SpO₂ 94–96%. Hourly observations and a further senior review at 14:00. Discuss ceiling of care with the family if no improvement by tomorrow.',
    confidence: 0.79,
    band: 'MED',
    transcriptSpan: '"…broaden the antibiotics, repeat the film, bloods, keep him on hourly obs…"',
    inputs: [
      { label: 'Documented allergy: Penicillin', source: 'Allergy record SD-P-03' },
      { label: 'Antimicrobial stewardship policy', source: 'ASP guideline v6' },
    ],
  },
]

/**
 * The four sections for a patient with no drafted seed of their own — the
 * same labels and capabilities, and nothing written. A patient must never
 * open onto another patient's draft.
 */
const BLANK_SEEDS: NoteSectionSeed[] = NOTE_DRAFT_SD_P_01.map((sec) => ({
  ...sec,
  draft: '',
  transcriptSpan: '',
  inputs: [],
  confidence: 0,
  band: 'LOW',
}))

/** The note seeds for THIS patient: their own draft where the kit has one, blank otherwise. */
export function noteSeedsFor(patientId: string): NoteSectionSeed[] {
  if (patientId === 'SD-P-03') return NOTE_DRAFT_SD_P_03
  if (patientId === 'SD-P-01') return NOTE_DRAFT_SD_P_01
  return BLANK_SEEDS
}

// ─────────────────────────────────────────── Discharge summary (AI-106, G3)

export interface DischargeSectionSeed {
  key: 'reason' | 'course' | 'diagnosis' | 'meds' | 'followup' | 'redflags'
  label: string
  required: boolean
  /** AI-106's draft, shown only when the clinician asks for it. */
  draft: string
}

/** S-13-02 · SD-P-03's discharge summary, six sections, drafted on request. */
export const DISCHARGE_DRAFT_SD_P_03: DischargeSectionSeed[] = [
  {
    key: 'reason',
    label: 'Reason for admission',
    required: true,
    draft:
      'Admitted on 17-Sep-2026 with a four-day history of productive cough, fever and progressive breathlessness. Chest imaging confirmed right lower lobe consolidation. Treated as community-acquired pneumonia.',
  },
  {
    key: 'course',
    label: 'Course in hospital',
    required: true,
    draft:
      'Started on piperacillin-tazobactam 4.5g IV 8-hourly on admission. Blood cultures were taken before antibiotics and showed no growth at 48 hours. Oxygen requirement rose from 2 L to 4 L overnight on 20/21-Sep with a NEWS2 of 7; CRP rose from 96 to 184 mg/L. Antibiotic cover was escalated after review of the documented penicillin allergy. Creatinine rose to 212 µmol/L, meeting stage 2 acute kidney injury, and the enoxaparin dose was renally adjusted. He improved from 22-Sep with weaning of oxygen to room air by 24-Sep.',
  },
  {
    key: 'diagnosis',
    label: 'Discharge diagnosis',
    required: true,
    draft: 'Community-acquired pneumonia, right lower lobe (J18.9). Acute kidney injury, stage 2, resolved. Type 2 diabetes (E11.9), pre-existing.',
  },
  {
    key: 'meds',
    label: 'Medication on discharge',
    required: true,
    draft:
      'Levofloxacin 750 mg orally once daily for a further 3 days. Atorvastatin 40 mg at night, continued. Metformin 500 mg twice daily, restarted 23-Sep after renal function recovered. Enoxaparin stopped on discharge.',
  },
  {
    key: 'followup',
    label: 'Follow-up',
    required: true,
    draft:
      'Chest clinic in 6 weeks with a repeat chest X-ray beforehand. Serum creatinine and electrolytes in 1 week at the local laboratory. General medicine review with Dr. Iyer in 4 weeks.',
  },
  {
    key: 'redflags',
    label: 'When to come back',
    required: true,
    draft:
      'Return immediately if breathlessness worsens, fever returns above 38 °C, you cough up blood, or you become confused or unusually drowsy. Attend the emergency department rather than waiting for the clinic appointment.',
  },
]

// ──────────────────────────────────────────────────────────── Problem list

export interface Problem {
  id: string
  patientId: string
  label: string
  icd10: string
  snomed: string
  onset: string
  /** VOCABULARY: Open, never Active — Active is reserved for stroke cases. */
  status: 'Open' | 'Resolved'
  /** Set where AI-501 proposed the code and it awaits a G2 disposition. */
  aiSuggested?: boolean
  confidence?: number
  band?: ConfidenceBand
  /** AI-204 flags a diagnosis the charted evidence does not support. */
  consistencyFlag?: string
  /** AI-501 blocks parent-only codes; leaf codes only. */
  leaf: boolean
}

export const PROBLEMS: Problem[] = [
  {
    id: 'PR-01',
    patientId: 'SD-P-01',
    label: 'Hypothyroidism',
    icd10: 'E03.9',
    snomed: '40930008',
    onset: '2019',
    status: 'Open',
    aiSuggested: true,
    confidence: 0.94,
    band: 'HIGH',
    leaf: true,
  },
  {
    id: 'PR-02',
    patientId: 'SD-P-03',
    label: 'Community-acquired pneumonia',
    icd10: 'J18.9',
    snomed: '385093006',
    onset: '17-Sep-2026',
    status: 'Open',
    aiSuggested: true,
    confidence: 0.91,
    band: 'HIGH',
    leaf: true,
  },
  {
    id: 'PR-03',
    patientId: 'SD-P-03',
    label: 'Type 2 diabetes',
    icd10: 'E11.9',
    snomed: '44054006',
    onset: '2014',
    status: 'Open',
    leaf: true,
  },
  {
    id: 'PR-04',
    patientId: 'SD-P-07',
    label: 'Septic shock',
    icd10: 'R65.21',
    snomed: '76571007',
    onset: '15-Sep-2026',
    status: 'Open',
    aiSuggested: true,
    confidence: 0.58,
    band: 'LOW',
    consistencyFlag:
      'Lactate has not been charted in the last 12 hours. Septic shock coding needs a lactate > 2 mmol/L with vasopressor support documented.',
    leaf: true,
  },
  {
    id: 'PR-05',
    patientId: 'SD-P-05',
    label: 'Acute ischaemic stroke',
    icd10: 'I63.9',
    snomed: '422504002',
    onset: '21-Sep-2026',
    status: 'Open',
    aiSuggested: true,
    confidence: 0.96,
    band: 'HIGH',
    leaf: true,
  },
  // ── The rest of the record, so every chart has a problem list.
  { id: 'PR-06', patientId: 'SD-P-02', label: 'Coronary artery disease, triple vessel', icd10: 'I25.10', snomed: '53741008', onset: '2025', status: 'Open', leaf: true },
  { id: 'PR-07', patientId: 'SD-P-02', label: 'Type 2 diabetes', icd10: 'E11.9', snomed: '44054006', onset: '2018', status: 'Open', leaf: true },
  { id: 'PR-08', patientId: 'SD-P-04', label: 'Gestational diabetes', icd10: 'O24.41', snomed: '11687002', onset: '19-Sep-2026', status: 'Open', aiSuggested: true, confidence: 0.86, band: 'MED', leaf: true },
  { id: 'PR-09', patientId: 'SD-P-04', label: 'Anaemia of pregnancy', icd10: 'O99.01', snomed: '199244000', onset: '2026', status: 'Open', leaf: true },
  { id: 'PR-10', patientId: 'SD-P-06', label: 'Acute viral fever', icd10: 'B34.9', snomed: '34014006', onset: '19-Sep-2026', status: 'Open', leaf: true },
  { id: 'PR-11', patientId: 'SD-P-09', label: 'End-stage kidney disease on haemodialysis', icd10: 'N18.6', snomed: '46177005', onset: '2022', status: 'Open', leaf: true },
  { id: 'PR-12', patientId: 'SD-P-09', label: 'Hypertension', icd10: 'I10', snomed: '38341003', onset: '2012', status: 'Open', leaf: true },
  { id: 'PR-13', patientId: 'SD-P-10', label: 'Acne vulgaris, moderate', icd10: 'L70.0', snomed: '88616000', onset: '2025', status: 'Open', leaf: true },
  { id: 'PR-14', patientId: 'SD-P-11', label: 'Subdural haematoma, right — evacuated', icd10: 'S06.5', snomed: '35486000', onset: '31-Aug-2026', status: 'Open', leaf: true },
  { id: 'PR-15', patientId: 'SD-P-11', label: 'Atrial fibrillation', icd10: 'I48.91', snomed: '49436004', onset: '2021', status: 'Open', leaf: true },
  { id: 'PR-16', patientId: 'SD-P-12', label: 'Intracerebral haemorrhage, left thalamus', icd10: 'I61.0', snomed: '274100004', onset: '18-Sep-2026', status: 'Open', aiSuggested: true, confidence: 0.93, band: 'HIGH', leaf: true },
  { id: 'PR-17', patientId: 'SD-P-12', label: 'Essential hypertension', icd10: 'I10', snomed: '59621000', onset: '2016', status: 'Open', leaf: true },
  { id: 'PR-18', patientId: 'SD-P-13', label: 'Cerebral infarction, right MCA territory', icd10: 'I63.9', snomed: '422504002', onset: '20-Sep-2026', status: 'Open', aiSuggested: true, confidence: 0.84, band: 'MED', leaf: true },
  { id: 'PR-19', patientId: 'SD-P-13', label: 'Cerebral oedema', icd10: 'G93.6', snomed: '2032001', onset: '20-Sep-2026', status: 'Open', leaf: true },
  { id: 'PR-20', patientId: 'SD-P-14', label: 'Intracerebral haemorrhage with intraventricular extension', icd10: 'I61.5', snomed: '274100004', onset: '21-Sep-2026', status: 'Open', aiSuggested: true, confidence: 0.95, band: 'HIGH', leaf: true },
  { id: 'PR-21', patientId: 'SD-P-14', label: 'Anticoagulant-associated coagulopathy (warfarin)', icd10: 'D68.32', snomed: '64779008', onset: '21-Sep-2026', status: 'Open', leaf: true },
  { id: 'PR-22', patientId: 'SD-P-14', label: 'Atrial fibrillation', icd10: 'I48.91', snomed: '49436004', onset: '2019', status: 'Open', leaf: true },
  { id: 'PR-23', patientId: 'SD-P-15', label: 'Migraine without aura', icd10: 'G43.009', snomed: '56097005', onset: '2019', status: 'Open', leaf: true },
  { id: 'PR-24', patientId: 'SD-P-16', label: 'Concussion without loss of consciousness', icd10: 'S06.0X0', snomed: '110030002', onset: '14-Sep-2026', status: 'Open', leaf: true },
]

export function problemsFor(patientId: string): Problem[] {
  return PROBLEMS.filter((p) => p.patientId === patientId)
}

/**
 * AI-501 code suggestions. The parent-only entry exists so the screen can show
 * a blocked code: "Blocks parent-only codes; manual search always available."
 */
export const CODE_SUGGESTIONS = [
  { icd10: 'J18.9', label: 'Pneumonia, unspecified organism', leaf: true, confidence: 0.91 },
  { icd10: 'J18', label: 'Pneumonia, unspecified organism (category)', leaf: false, confidence: 0.86 },
  { icd10: 'J15.9', label: 'Unspecified bacterial pneumonia', leaf: true, confidence: 0.64 },
  { icd10: 'J13', label: 'Pneumonia due to Streptococcus pneumoniae', leaf: true, confidence: 0.41 },
]

// ────────────────────────────────────────── Prescriptions and the hard stop

export interface RxLine {
  id: string
  drug: string
  dose: string
  route: string
  frequency: string
  durationDays: number
  indication?: string
  substitutionAllowed: boolean
  instructions?: string
  /** AI-206 renal/hepatic adjustment proposal, awaiting a G2 disposition. */
  doseAdjustment?: {
    proposed: string
    reason: string
    confidence: number
    band: ConfidenceBand
  }
  /** AI-305 completeness gap. */
  completenessGap?: string
  /** Set when AI-205's deterministic rule blocks this line. */
  hardStop?: HardStop
}

/**
 * S-06-07's hard stop. The atlas is emphatic on two points, and both are
 * modelled here:
 *   "Hard stop is DETERMINISTIC" — it is a rule, not the model's opinion, so it
 *   fires identically in AI-OFF.
 *   "Override needs a reason AND a second consultant" — a G4 dual signature.
 */
export interface HardStop {
  rule: string
  /** Why it fired, in the clinician's language. */
  finding: string
  severity: 'contraindicated'
  deterministic: true
  documentedAt: string
  documentedBy: string
  alternatives: {
    drug: string
    dose: string
    route: string
    frequency: string
    rationale: string
    /** Whether the alternative itself carries any caution. */
    caution?: string
  }[]
  auditEvent: string
}

export const PENICILLIN_HARD_STOP: HardStop = {
  rule: 'Allergy cross-reactivity — beta-lactam class',
  finding:
    'Co-amoxiclav is a beta-lactam. R. Lakshmanan has a documented penicillin allergy with a recorded reaction of urticaria and facial swelling.',
  severity: 'contraindicated',
  deterministic: true,
  documentedAt: '11-Aug-2021',
  documentedBy: 'Dr. Ananya Iyer',
  alternatives: [
    {
      drug: 'Levofloxacin',
      dose: '750 mg',
      route: 'IV',
      frequency: 'once daily',
      rationale:
        'Respiratory fluoroquinolone. Covers typical and atypical community-acquired pathogens with no beta-lactam cross-reactivity.',
      caution: 'QT prolongation — review the ECG from 19-Sep-2026 before starting.',
    },
    {
      drug: 'Teicoplanin + Levofloxacin',
      dose: '400 mg + 750 mg',
      route: 'IV',
      frequency: '12-hourly loading, then daily',
      rationale: 'Adds Gram-positive cover where a resistant organism is suspected at 72 hours.',
    },
    {
      drug: 'Clarithromycin',
      dose: '500 mg',
      route: 'IV',
      frequency: '12-hourly',
      rationale: 'Macrolide monotherapy. Narrower cover; suitable only if atypical infection is the working diagnosis.',
      caution: 'Interacts with atorvastatin, which is on the active list.',
    },
  ],
  auditEvent: 'AI.SAF.HARD_STOP_OVERRIDDEN',
}

/** The proposed basket for SD-P-03 — deck beat #8. */
export const RX_BASKET_SD_P_03: RxLine[] = [
  {
    id: 'RX-L-01',
    drug: 'Co-amoxiclav 1.2g IV',
    dose: '1.2 g',
    route: 'IV',
    frequency: '8-hourly',
    durationDays: 7,
    indication: 'Community-acquired pneumonia (J18.9)',
    substitutionAllowed: true,
    hardStop: PENICILLIN_HARD_STOP,
  },
  {
    id: 'RX-L-02',
    drug: 'Enoxaparin 40mg SC',
    dose: '40 mg',
    route: 'SC',
    frequency: 'once daily',
    durationDays: 7,
    indication: 'VTE prophylaxis',
    substitutionAllowed: false,
    doseAdjustment: {
      proposed: '20 mg once daily',
      reason:
        'eGFR 28 mL/min/1.73m² on 21-Sep-2026. Enoxaparin accumulates below eGFR 30; halve the prophylactic dose.',
      confidence: 0.87,
      band: 'HIGH',
    },
  },
  {
    id: 'RX-L-03',
    drug: 'Paracetamol 1g IV',
    dose: '1 g',
    route: 'IV',
    frequency: '6-hourly as required',
    durationDays: 3,
    indication: 'Fever and pleuritic pain',
    substitutionAllowed: true,
    completenessGap: 'No maximum daily dose stated. Add a 24-hour ceiling (CMP-NABH-05).',
  },
]

/** SD-P-01's outpatient prescription — no hard stop, the routine path. */
export const RX_BASKET_SD_P_01: RxLine[] = [
  {
    id: 'RX-L-11',
    drug: 'Levothyroxine 75 mcg',
    dose: '75 mcg',
    route: 'Oral',
    frequency: 'once daily before food',
    durationDays: 180,
    indication: 'Hypothyroidism (E03.9)',
    substitutionAllowed: true,
    instructions: 'Take on an empty stomach, 30 minutes before breakfast. Keep a four-hour gap from calcium or iron.',
  },
]

/**
 * The formulary the typeahead searches. NLEM-listed drugs are prompted as a
 * substitution per CMP-DRUG-03.
 */
export const FORMULARY = [
  { drug: 'Co-amoxiclav 1.2g IV', nlem: true, ceilingPrice: 148, betaLactam: true },
  { drug: 'Piperacillin-tazobactam 4.5g IV', nlem: true, ceilingPrice: 412, betaLactam: true },
  { drug: 'Levofloxacin 750mg IV', nlem: true, ceilingPrice: 186, betaLactam: false },
  { drug: 'Clarithromycin 500mg IV', nlem: false, ceilingPrice: 298, betaLactam: false },
  { drug: 'Teicoplanin 400mg IV', nlem: false, ceilingPrice: 1240, betaLactam: false },
  { drug: 'Enoxaparin 40mg SC', nlem: true, ceilingPrice: 342, betaLactam: false },
  { drug: 'Atorvastatin 40mg', nlem: true, ceilingPrice: 62, betaLactam: false },
  { drug: 'Clopidogrel 75mg', nlem: true, ceilingPrice: 48, betaLactam: false },
  { drug: 'Metformin 500mg', nlem: true, ceilingPrice: 18, betaLactam: false },
  { drug: 'Paracetamol 1g IV', nlem: true, ceilingPrice: 34, betaLactam: false },
  { drug: 'Levothyroxine 75 mcg', nlem: true, ceilingPrice: 96, betaLactam: false },
  { drug: 'Tenecteplase 25mg', nlem: false, ceilingPrice: 42000, betaLactam: false },
]

// ───────────────────────────────────────────────────────── Results (M-09)

export interface ResultRow {
  id: string
  patientId: string
  test: string
  value: string
  unit: string
  refRange: string
  /**
   * §5.3 — colour is never the only carrier. An abnormal result reads
   * "↑ High", not a red cell, so the flag carries the word.
   */
  flag: 'Normal' | '↑ High' | '↓ Low' | '↑↑ Critical high' | '↓↓ Critical low'
  reportedAt: Date
  priorValue?: string
  /** AI-212 delta check. */
  delta?: string
  critical: boolean
  acknowledged: boolean
  /** AI-212's one-line ranking reason, shown as a per-row reason chip. */
  aiReason: string
  band: ConfidenceBand
  /** Minutes a critical result has gone unacknowledged, for the escalation clock. */
  unackMinutes?: number
  /** Numeric reference bounds, for the trend chart's band. Absent for a qualitative test. */
  refLow?: number
  refHigh?: number
  /** AI-109's narrative on S-09-05 — the finding, then what follows from it. */
  narrative?: string[]
  /** Who acknowledged it, where someone already has. */
  acknowledgedBy?: string
}

export const RESULTS: ResultRow[] = [
  {
    /** The critical one. W-06-3 s2! — interrupts a NAMED clinician. */
    id: 'R-88410',
    patientId: 'SD-P-07',
    test: 'Serum potassium',
    value: '6.8',
    unit: 'mmol/L',
    refRange: '3.5 – 5.1',
    flag: '↑↑ Critical high',
    reportedAt: minutesAgo(12),
    priorValue: '5.4',
    delta: '+1.4 in 9h',
    critical: true,
    acknowledged: false,
    aiReason: 'Critical potassium, rising 1.4 in 9h, on a ventilated patient with AKI',
    band: 'HIGH',
    unackMinutes: 12,
    refLow: 3.5,
    refHigh: 5.1,
    narrative: [
      'Severe hyperkalaemia at 6.8 mmol/L, risen from 5.4 nine hours earlier. In the context of acute kidney injury and a ventilated septic patient this is an immediate cardiac risk.',
      'Urgent ECG and treatment are indicated; a repeat sample to exclude haemolysis should not delay treatment at this level.',
    ],
  },
  {
    id: 'R-88402',
    patientId: 'SD-P-03',
    test: 'CRP',
    value: '184',
    unit: 'mg/L',
    refRange: '< 5',
    flag: '↑ High',
    reportedAt: minutesAgo(120),
    priorValue: '96',
    delta: '+88 in 48h',
    critical: false,
    acknowledged: false,
    aiReason: 'Nearly doubled at 72h of antibiotics — treatment failure pattern',
    band: 'HIGH',
    refLow: 0,
    refHigh: 5,
    narrative: [
      'CRP has risen from 96 to 184 mg/L over 48 hours on unchanged antibiotic cover.',
      'Taken with the increased oxygen requirement, this is a treatment-failure pattern rather than the expected downward trajectory at 72 hours.',
    ],
  },
  {
    id: 'R-88405',
    patientId: 'SD-P-03',
    test: 'Serum creatinine',
    value: '212',
    unit: 'µmol/L',
    refRange: '62 – 106',
    flag: '↑ High',
    reportedAt: minutesAgo(120),
    priorValue: '148',
    delta: '+64 in 24h',
    critical: false,
    acknowledged: false,
    aiReason: 'AKI stage 2 by creatinine criteria; affects two active prescriptions',
    band: 'HIGH',
    refLow: 62,
    refHigh: 106,
    narrative: [
      'Creatinine has risen 64 µmol/L in 24 hours, meeting stage 2 acute kidney injury by the KDIGO creatinine criterion.',
      'Two active prescriptions require renal dose adjustment.',
    ],
  },
  {
    id: 'R-88210',
    patientId: 'SD-P-01',
    test: 'TSH',
    value: '2.4',
    unit: 'mIU/L',
    refRange: '0.4 – 4.0',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 18, 11, 20),
    priorValue: '3.1',
    delta: '−0.7 in 6 months',
    critical: false,
    acknowledged: true,
    aiReason: 'Within target; no dose change indicated',
    band: 'HIGH',
    refLow: 0.4,
    refHigh: 4.0,
    narrative: [
      'TSH is within the target range on unchanged replacement, consistent with adequate dosing. No change is indicated; repeat in six months.',
    ],
  },
  {
    id: 'R-88211',
    patientId: 'SD-P-01',
    test: 'Free T4',
    value: '14.2',
    unit: 'pmol/L',
    refRange: '9.0 – 19.0',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 18, 11, 20),
    critical: false,
    acknowledged: true,
    aiReason: 'Stable, consistent with adequate replacement',
    band: 'HIGH',
    refLow: 9.0,
    refHigh: 19.0,
  },
  {
    id: 'R-88310',
    patientId: 'SD-P-03',
    test: 'Blood culture',
    value: 'No growth at 48h',
    unit: '',
    refRange: 'No growth',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 20, 6, 40),
    critical: false,
    acknowledged: true,
    /**
     * AI-212 abstains here rather than scoring — §4.5: "a capability that
     * cannot produce a calibrated score shows AI-ABSTAIN, not LOW."
     */
    aiReason: 'Cannot assess: culture incomplete, final read due at 72h',
    band: 'LOW',
  },

  // ── SD-P-03 · the rest of the pneumonia work-up
  {
    id: 'R-89010',
    patientId: 'SD-P-03',
    test: 'White cell count',
    value: '16.8',
    unit: '×10⁹/L',
    refRange: '4.0 – 11.0',
    flag: '↑ High',
    reportedAt: minutesAgo(120),
    priorValue: '13.2',
    delta: '+3.6 in 48h',
    critical: false,
    acknowledged: false,
    aiReason: 'Rising alongside CRP — supports treatment failure over a lab artefact',
    band: 'HIGH',
    refLow: 4.0,
    refHigh: 11.0,
    narrative: [
      'Neutrophil-predominant leucocytosis has risen from 13.2 to 16.8 over 48 hours.',
      'Read with the CRP and the oxygen requirement, the infection is not yet controlled on the current cover.',
    ],
  },
  {
    id: 'R-89011',
    patientId: 'SD-P-03',
    test: 'HbA1c',
    value: '8.4',
    unit: '%',
    refRange: '4.0 – 5.6',
    flag: '↑ High',
    reportedAt: new Date(2026, 8, 17, 18, 0),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Suboptimal diabetes control over three months — not today’s decision',
    band: 'HIGH',
    refLow: 4.0,
    refHigh: 5.6,
  },

  // ── SD-P-07 · ICU
  {
    id: 'R-89001',
    patientId: 'SD-P-07',
    test: 'Serum creatinine',
    value: '268',
    unit: 'µmol/L',
    refRange: '62 – 106',
    flag: '↑ High',
    reportedAt: minutesAgo(95),
    priorValue: '231',
    delta: '+37 in 12h',
    critical: false,
    acknowledged: false,
    aiReason: 'AKI stage 3 trajectory with the potassium — filtration decision today',
    band: 'HIGH',
    refLow: 62,
    refHigh: 106,
    narrative: [
      'Creatinine continues to climb, now 2.5 times the upper limit, with falling urine output.',
      'With the potassium at 6.8, this supports the renal registrar’s review for filtration today.',
    ],
  },
  {
    id: 'R-89002',
    patientId: 'SD-P-07',
    test: 'Platelets',
    value: '84',
    unit: '×10⁹/L',
    refRange: '150 – 410',
    flag: '↓ Low',
    reportedAt: minutesAgo(95),
    priorValue: '112',
    delta: '−28 in 24h',
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Falling in sepsis — a coagulation screen would exclude DIC',
    band: 'MED',
    refLow: 150,
    refHigh: 410,
  },
  {
    id: 'R-89003',
    patientId: 'SD-P-07',
    test: 'Procalcitonin',
    value: '18.6',
    unit: 'ng/mL',
    refRange: '< 0.5',
    flag: '↑ High',
    reportedAt: new Date(2026, 8, 20, 22, 0),
    priorValue: '24.1',
    delta: '−5.5 in 24h',
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Falling from its peak — consistent with source control taking effect',
    band: 'MED',
    refLow: 0,
    refHigh: 0.5,
  },

  // ── SD-P-01 · thyroid clinic
  {
    id: 'R-89020',
    patientId: 'SD-P-01',
    test: 'Haemoglobin',
    value: '11.9',
    unit: 'g/dL',
    refRange: '12.0 – 15.5',
    flag: '↓ Low',
    reportedAt: new Date(2026, 8, 18, 11, 20),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Borderline low; read with the ferritin',
    band: 'MED',
    refLow: 12.0,
    refHigh: 15.5,
  },
  {
    id: 'R-89021',
    patientId: 'SD-P-01',
    test: 'Ferritin',
    value: '14',
    unit: 'ng/mL',
    refRange: '15 – 150',
    flag: '↓ Low',
    reportedAt: new Date(2026, 8, 18, 11, 20),
    critical: false,
    acknowledged: false,
    aiReason: 'Low iron stores — a likely cause of the borderline haemoglobin',
    band: 'HIGH',
    refLow: 15,
    refHigh: 150,
    narrative: [
      'Ferritin is just below range with a borderline haemoglobin — the pattern of early iron deficiency.',
      'Worth discussing today alongside the thyroid review; oral iron is usually enough.',
    ],
  },

  // ── SD-P-02 · day 2 after CABG
  {
    id: 'R-89030',
    patientId: 'SD-P-02',
    test: 'Haemoglobin',
    value: '9.8',
    unit: 'g/dL',
    refRange: '13.0 – 17.0',
    flag: '↓ Low',
    reportedAt: minutesAgo(150),
    priorValue: '10.4',
    delta: '−0.6 in 24h',
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Expected post-operative dilution; drains serous, no bleeding pattern',
    band: 'HIGH',
    refLow: 13.0,
    refHigh: 17.0,
  },
  {
    id: 'R-89031',
    patientId: 'SD-P-02',
    test: 'Troponin I (hs)',
    value: '1840',
    unit: 'ng/L',
    refRange: '< 34',
    flag: '↑ High',
    reportedAt: new Date(2026, 8, 20, 6, 0),
    priorValue: '3120',
    delta: '−1280 in 24h',
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Falling as expected after surgery — no new injury pattern',
    band: 'HIGH',
    refLow: 0,
    refHigh: 34,
  },
  {
    id: 'R-89032',
    patientId: 'SD-P-02',
    test: 'Serum potassium',
    value: '4.3',
    unit: 'mmol/L',
    refRange: '3.5 – 5.1',
    flag: 'Normal',
    reportedAt: minutesAgo(150),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Within range',
    band: 'HIGH',
    refLow: 3.5,
    refHigh: 5.1,
  },

  // ── SD-P-04 · 32 weeks
  {
    id: 'R-89040',
    patientId: 'SD-P-04',
    test: 'Haemoglobin',
    value: '10.6',
    unit: 'g/dL',
    refRange: '11.0 – 15.0',
    flag: '↓ Low',
    reportedAt: new Date(2026, 8, 19, 10, 0),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Mild anaemia of pregnancy, already on iron',
    band: 'HIGH',
    refLow: 11.0,
    refHigh: 15.0,
  },
  {
    id: 'R-89041',
    patientId: 'SD-P-04',
    test: 'Glucose, 2 h after 75 g load',
    value: '162',
    unit: 'mg/dL',
    refRange: '< 140',
    flag: '↑ High',
    reportedAt: new Date(2026, 8, 19, 12, 30),
    critical: false,
    acknowledged: false,
    aiReason: 'Meets the DIPSI threshold for gestational diabetes',
    band: 'HIGH',
    refLow: 0,
    refHigh: 140,
    narrative: [
      'The two-hour value of 162 mg/dL is above the 140 mg/dL DIPSI threshold, which confirms gestational diabetes at 32 weeks.',
      'Diet advice and home glucose monitoring are the first step; an obstetric review should be booked this week.',
    ],
  },
  {
    id: 'R-89042',
    patientId: 'SD-P-04',
    test: 'Urine protein',
    value: 'Negative',
    unit: '',
    refRange: 'Negative',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 19, 10, 0),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'No proteinuria — no pre-eclampsia signal',
    band: 'HIGH',
  },

  // ── SD-P-05 · code stroke bloods, 02:00
  {
    id: 'R-89050',
    patientId: 'SD-P-05',
    test: 'Capillary glucose',
    value: '142',
    unit: 'mg/dL',
    refRange: '70 – 140',
    flag: '↑ High',
    reportedAt: new Date(2026, 8, 21, 2, 18),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Priya Menon',
    aiReason: 'Not a hypoglycaemic mimic; no bar to thrombolysis',
    band: 'HIGH',
    refLow: 70,
    refHigh: 140,
  },
  {
    id: 'R-89051',
    patientId: 'SD-P-05',
    test: 'INR',
    value: '1.0',
    unit: '',
    refRange: '0.8 – 1.2',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 21, 2, 30),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Priya Menon',
    aiReason: 'No anticoagulant effect — no bar to thrombolysis',
    band: 'HIGH',
    refLow: 0.8,
    refHigh: 1.2,
  },
  {
    id: 'R-89052',
    patientId: 'SD-P-05',
    test: 'Platelets',
    value: '238',
    unit: '×10⁹/L',
    refRange: '150 – 410',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 21, 2, 30),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Priya Menon',
    aiReason: 'Above 100 — no bar to thrombolysis',
    band: 'HIGH',
    refLow: 150,
    refHigh: 410,
  },

  // ── SD-P-06 · day care
  {
    id: 'R-89060',
    patientId: 'SD-P-06',
    test: 'CRP',
    value: '18',
    unit: 'mg/L',
    refRange: '< 5',
    flag: '↑ High',
    reportedAt: new Date(2026, 8, 20, 9, 0),
    priorValue: '42',
    delta: '−24 in 24h',
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Falling — consistent with a resolving viral illness',
    band: 'HIGH',
    refLow: 0,
    refHigh: 5,
  },
  {
    id: 'R-89061',
    patientId: 'SD-P-06',
    test: 'Dengue NS1 antigen',
    value: 'Negative',
    unit: '',
    refRange: 'Negative',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 20, 9, 0),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Dengue excluded on day 2 of fever',
    band: 'HIGH',
  },

  // ── SD-P-09 · dialysis
  {
    id: 'R-89070',
    patientId: 'SD-P-09',
    test: 'Serum potassium',
    value: '5.6',
    unit: 'mmol/L',
    refRange: '3.5 – 5.1',
    flag: '↑ High',
    reportedAt: minutesAgo(200),
    priorValue: '5.2',
    delta: '+0.4 since last session',
    critical: false,
    acknowledged: false,
    aiReason: 'Pre-dialysis rise; today’s 14:00 session will correct it',
    band: 'MED',
    refLow: 3.5,
    refHigh: 5.1,
    narrative: [
      'A pre-dialysis potassium of 5.6 mmol/L is typical of the interdialytic interval and is below the level that needs treatment before the session.',
      'Dialysis at 14:00 should correct it; recheck only if the session is delayed.',
    ],
  },
  {
    id: 'R-89071',
    patientId: 'SD-P-09',
    test: 'Haemoglobin',
    value: '9.1',
    unit: 'g/dL',
    refRange: '12.0 – 15.5',
    flag: '↓ Low',
    reportedAt: new Date(2026, 8, 19, 7, 0),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Stable anaemia of kidney disease on erythropoietin',
    band: 'HIGH',
    refLow: 12.0,
    refHigh: 15.5,
  },
  {
    id: 'R-89072',
    patientId: 'SD-P-09',
    test: 'Serum phosphate',
    value: '1.9',
    unit: 'mmol/L',
    refRange: '0.8 – 1.5',
    flag: '↑ High',
    reportedAt: new Date(2026, 8, 19, 7, 0),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Above target; binder adherence worth asking about',
    band: 'MED',
    refLow: 0.8,
    refHigh: 1.5,
  },

  // ── SD-P-10 · isotretinoin baseline
  {
    id: 'R-89080',
    patientId: 'SD-P-10',
    test: 'ALT',
    value: '28',
    unit: 'U/L',
    refRange: '7 – 56',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 12, 9, 30),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Normal baseline before isotretinoin',
    band: 'HIGH',
    refLow: 7,
    refHigh: 56,
  },
  {
    id: 'R-89081',
    patientId: 'SD-P-10',
    test: 'Fasting triglycerides',
    value: '138',
    unit: 'mg/dL',
    refRange: '< 150',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 12, 9, 30),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Normal baseline before isotretinoin',
    band: 'HIGH',
    refLow: 0,
    refHigh: 150,
  },

  // ── SD-P-11 · three weeks after the subdural was evacuated
  {
    id: 'R-89110',
    patientId: 'SD-P-11',
    test: 'Serum sodium',
    value: '131',
    unit: 'mmol/L',
    refRange: '135 – 145',
    flag: '↓ Low',
    reportedAt: minutesAgo(60),
    priorValue: '134',
    delta: '−3 since discharge',
    critical: false,
    acknowledged: false,
    aiReason: 'Mild hyponatraemia — review fluids and the new levetiracetam',
    band: 'MED',
    refLow: 135,
    refHigh: 145,
    narrative: [
      'Sodium has drifted from 134 at discharge to 131 mmol/L. Mild, but in a 76-year-old after a subdural it raises fall and confusion risk.',
      'Worth checking fluid intake and whether any new medicine contributes; repeat in one week.',
    ],
  },
  {
    id: 'R-89111',
    patientId: 'SD-P-11',
    test: 'Haemoglobin',
    value: '11.2',
    unit: 'g/dL',
    refRange: '12.0 – 15.5',
    flag: '↓ Low',
    reportedAt: minutesAgo(60),
    priorValue: '10.1',
    delta: '+1.1 since discharge',
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Recovering after surgery',
    band: 'HIGH',
    refLow: 12.0,
    refHigh: 15.5,
  },
  {
    id: 'R-89112',
    patientId: 'SD-P-11',
    test: 'INR',
    value: '1.1',
    unit: '',
    refRange: '0.8 – 1.2',
    flag: 'Normal',
    reportedAt: minutesAgo(60),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Anticoagulant still held — no residual effect',
    band: 'HIGH',
    refLow: 0.8,
    refHigh: 1.2,
  },

  // ── SD-P-12 · left thalamic haemorrhage, day 3
  {
    id: 'R-89120',
    patientId: 'SD-P-12',
    test: 'INR',
    value: '1.0',
    unit: '',
    refRange: '0.8 – 1.2',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 18, 23, 10),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'No coagulopathy behind the bleed — a hypertensive cause is likelier',
    band: 'HIGH',
    refLow: 0.8,
    refHigh: 1.2,
  },
  {
    id: 'R-89121',
    patientId: 'SD-P-12',
    test: 'HbA1c',
    value: '6.1',
    unit: '%',
    refRange: '4.0 – 5.6',
    flag: '↑ High',
    reportedAt: new Date(2026, 8, 19, 6, 0),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Prediabetes range — a secondary-prevention target',
    band: 'MED',
    refLow: 4.0,
    refHigh: 5.6,
  },
  {
    id: 'R-89122',
    patientId: 'SD-P-12',
    test: 'LDL cholesterol',
    value: '3.9',
    unit: 'mmol/L',
    refRange: '< 2.6',
    flag: '↑ High',
    reportedAt: new Date(2026, 8, 19, 6, 0),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Above target; statins after an ICH need a specialist decision',
    band: 'HIGH',
    refLow: 0,
    refHigh: 2.6,
  },
  {
    id: 'R-89123',
    patientId: 'SD-P-12',
    test: 'Serum creatinine',
    value: '96',
    unit: 'µmol/L',
    refRange: '62 – 106',
    flag: 'Normal',
    reportedAt: minutesAgo(130),
    priorValue: '101',
    delta: '−5 in 48h',
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Kidneys tolerating the blood-pressure lowering',
    band: 'HIGH',
    refLow: 62,
    refHigh: 106,
  },

  // ── SD-P-13 · large right MCA infarct with oedema
  {
    id: 'R-89130',
    patientId: 'SD-P-13',
    test: 'Serum sodium',
    value: '133',
    unit: 'mmol/L',
    refRange: '135 – 145',
    flag: '↓ Low',
    reportedAt: minutesAgo(90),
    priorValue: '138',
    delta: '−5 in 12h',
    critical: false,
    acknowledged: false,
    aiReason: 'Falling sodium with cerebral oedema — hypotonic fluids worsen swelling',
    band: 'HIGH',
    refLow: 135,
    refHigh: 145,
    narrative: [
      'Sodium has fallen 5 mmol/L in 12 hours in a patient with a swollen infarct and midline shift.',
      'Avoiding hypotonic fluids and keeping sodium at or above 140 is the usual aim; consider hypertonic saline if the level or the conscious level falls further.',
    ],
  },
  {
    id: 'R-89131',
    patientId: 'SD-P-13',
    test: 'Capillary glucose',
    value: '188',
    unit: 'mg/dL',
    refRange: '70 – 140',
    flag: '↑ High',
    reportedAt: minutesAgo(90),
    priorValue: '162',
    delta: '+26 in 6h',
    critical: false,
    acknowledged: false,
    aiReason: 'Stress hyperglycaemia; above 180 worsens outcome after infarct',
    band: 'MED',
    refLow: 70,
    refHigh: 140,
  },
  {
    id: 'R-89132',
    patientId: 'SD-P-13',
    test: 'Troponin I (hs)',
    value: '12',
    unit: 'ng/L',
    refRange: '< 34',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 20, 19, 0),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'No cardiac injury with the stroke',
    band: 'HIGH',
    refLow: 0,
    refHigh: 34,
  },

  // ── SD-P-14 · the anticoagulated bleed
  {
    id: 'R-89140',
    patientId: 'SD-P-14',
    test: 'INR',
    value: '3.8',
    unit: '',
    refRange: '0.8 – 1.2',
    flag: '↑↑ Critical high',
    reportedAt: new Date(2026, 8, 21, 2, 40),
    priorValue: '2.6',
    delta: '+1.2 since the clinic check',
    critical: true,
    acknowledged: true,
    acknowledgedBy: 'Dr. Rohit Desai',
    aiReason: 'Supratherapeutic INR with an intracranial bleed — reverse now',
    band: 'HIGH',
    refLow: 0.8,
    refHigh: 1.2,
    narrative: [
      'An INR of 3.8 on warfarin, with a large intracerebral haemorrhage, is a medical emergency: the bleed will keep expanding until the anticoagulant effect is reversed.',
      'Prothrombin complex concentrate with intravenous vitamin K is the standard reversal; recheck the INR 30 minutes after.',
    ],
  },
  {
    id: 'R-89141',
    patientId: 'SD-P-14',
    test: 'Haemoglobin',
    value: '12.8',
    unit: 'g/dL',
    refRange: '13.0 – 17.0',
    flag: '↓ Low',
    reportedAt: new Date(2026, 8, 21, 2, 40),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Rohit Desai',
    aiReason: 'Near normal — no systemic bleed',
    band: 'HIGH',
    refLow: 13.0,
    refHigh: 17.0,
  },
  {
    id: 'R-89142',
    patientId: 'SD-P-14',
    test: 'Fibrinogen',
    value: '2.4',
    unit: 'g/L',
    refRange: '2.0 – 4.0',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 21, 2, 40),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Rohit Desai',
    aiReason: 'Normal — reversal needs PCC and vitamin K, not cryoprecipitate',
    band: 'HIGH',
    refLow: 2.0,
    refHigh: 4.0,
  },

  // ── SD-P-15 · migraine
  {
    id: 'R-89150',
    patientId: 'SD-P-15',
    test: 'ESR',
    value: '12',
    unit: 'mm/h',
    refRange: '0 – 20',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 9, 10, 0),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Normal — no inflammatory cause for the headache',
    band: 'HIGH',
    refLow: 0,
    refHigh: 20,
  },
  {
    id: 'R-89151',
    patientId: 'SD-P-15',
    test: 'Haemoglobin',
    value: '12.9',
    unit: 'g/dL',
    refRange: '12.0 – 15.5',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 9, 10, 0),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Within range',
    band: 'HIGH',
    refLow: 12.0,
    refHigh: 15.5,
  },

  // ── SD-P-16 · minor head injury
  {
    id: 'R-89160',
    patientId: 'SD-P-16',
    test: 'Haemoglobin',
    value: '14.6',
    unit: 'g/dL',
    refRange: '13.0 – 17.0',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 14, 23, 30),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Within range',
    band: 'HIGH',
    refLow: 13.0,
    refHigh: 17.0,
  },
  {
    id: 'R-89161',
    patientId: 'SD-P-16',
    test: 'Blood alcohol',
    value: 'Not detected',
    unit: '',
    refRange: 'Not detected',
    flag: 'Normal',
    reportedAt: new Date(2026, 8, 14, 23, 30),
    critical: false,
    acknowledged: true,
    acknowledgedBy: 'Dr. Ananya Iyer',
    aiReason: 'Recorded for the medico-legal file',
    band: 'HIGH',
  },
]

/** The trend series behind S-09-05, for the result detail chart. */
export const RESULT_TRENDS: Record<string, { at: Date; value: number }[]> = {
  'R-88410': [
    { at: new Date(2026, 8, 19, 6, 0), value: 4.4 },
    { at: new Date(2026, 8, 19, 18, 0), value: 4.9 },
    { at: new Date(2026, 8, 20, 6, 0), value: 5.1 },
    { at: new Date(2026, 8, 20, 23, 0), value: 5.4 },
    { at: minutesAgo(12), value: 6.8 },
  ],
  'R-88402': [
    { at: new Date(2026, 8, 17, 15, 0), value: 142 },
    { at: new Date(2026, 8, 18, 6, 30), value: 118 },
    { at: new Date(2026, 8, 19, 6, 30), value: 96 },
    { at: new Date(2026, 8, 20, 6, 30), value: 138 },
    { at: minutesAgo(120), value: 184 },
  ],
  'R-88405': [
    { at: new Date(2026, 8, 17, 15, 0), value: 102 },
    { at: new Date(2026, 8, 18, 6, 30), value: 118 },
    { at: new Date(2026, 8, 19, 6, 30), value: 131 },
    { at: new Date(2026, 8, 20, 6, 30), value: 148 },
    { at: minutesAgo(120), value: 212 },
  ],
  'R-88210': [
    { at: new Date(2025, 2, 18, 11, 0), value: 5.8 },
    { at: new Date(2025, 8, 18, 11, 0), value: 4.2 },
    { at: new Date(2026, 2, 18, 11, 0), value: 3.1 },
    { at: new Date(2026, 8, 18, 11, 20), value: 2.4 },
  ],
  'R-89010': [
    { at: new Date(2026, 8, 17, 15, 0), value: 14.1 },
    { at: new Date(2026, 8, 18, 6, 30), value: 12.6 },
    { at: new Date(2026, 8, 19, 6, 30), value: 13.2 },
    { at: new Date(2026, 8, 20, 6, 30), value: 14.9 },
    { at: minutesAgo(120), value: 16.8 },
  ],
  'R-89001': [
    { at: new Date(2026, 8, 18, 6, 0), value: 142 },
    { at: new Date(2026, 8, 19, 6, 0), value: 188 },
    { at: new Date(2026, 8, 20, 6, 0), value: 214 },
    { at: new Date(2026, 8, 20, 20, 0), value: 231 },
    { at: minutesAgo(95), value: 268 },
  ],
  'R-89021': [
    { at: new Date(2025, 8, 18, 11, 0), value: 38 },
    { at: new Date(2026, 2, 18, 11, 0), value: 22 },
    { at: new Date(2026, 8, 18, 11, 20), value: 14 },
  ],
  'R-89031': [
    { at: new Date(2026, 8, 19, 14, 0), value: 4210 },
    { at: new Date(2026, 8, 19, 22, 0), value: 3120 },
    { at: new Date(2026, 8, 20, 6, 0), value: 1840 },
  ],
  'R-89070': [
    { at: new Date(2026, 8, 15, 7, 0), value: 5.4 },
    { at: new Date(2026, 8, 17, 7, 0), value: 5.2 },
    { at: new Date(2026, 8, 19, 7, 0), value: 5.2 },
    { at: minutesAgo(200), value: 5.6 },
  ],
  'R-89110': [
    { at: new Date(2026, 7, 31, 6, 0), value: 138 },
    { at: new Date(2026, 8, 3, 6, 0), value: 136 },
    { at: new Date(2026, 8, 7, 6, 0), value: 134 },
    { at: minutesAgo(60), value: 131 },
  ],
  'R-89130': [
    { at: new Date(2026, 8, 20, 18, 45), value: 139 },
    { at: new Date(2026, 8, 20, 23, 0), value: 138 },
    { at: new Date(2026, 8, 21, 3, 0), value: 135 },
    { at: minutesAgo(90), value: 133 },
  ],
  'R-89140': [
    { at: new Date(2026, 7, 10, 10, 0), value: 2.4 },
    { at: new Date(2026, 8, 7, 10, 0), value: 2.6 },
    { at: new Date(2026, 8, 21, 2, 40), value: 3.8 },
  ],
  'R-89123': [
    { at: new Date(2026, 8, 18, 23, 10), value: 104 },
    { at: new Date(2026, 8, 19, 6, 0), value: 101 },
    { at: minutesAgo(130), value: 96 },
  ],
}

/**
 * A result's series as chart points, each flagged against the reference
 * range. The latest point takes `critical` where the result itself is
 * critical — the range alone cannot say that. Shaped as `TrendPoint`.
 */
export function trendPointsFor(r: ResultRow): { at: Date; value: number; flag?: 'high' | 'low' | 'critical' }[] {
  const series = RESULT_TRENDS[r.id] ?? []
  const bounded = r.refLow !== undefined && r.refHigh !== undefined
  return series.map((s, i) => ({
    at: s.at,
    value: s.value,
    flag:
      i === series.length - 1 && r.critical
        ? 'critical'
        : bounded && s.value > r.refHigh!
          ? 'high'
          : bounded && s.value < r.refLow!
            ? 'low'
            : undefined,
  }))
}

export function result(id: string): ResultRow {
  const r = RESULTS.find((x) => x.id === id)
  if (!r) throw new Error(`Unknown result ${id}`)
  return r
}

export function maybeResult(id: string | undefined): ResultRow | undefined {
  return id ? RESULTS.find((x) => x.id === id) : undefined
}

/** Newest first. */
export function resultsFor(patientId: string): ResultRow[] {
  return RESULTS.filter((r) => r.patientId === patientId).sort((a, b) => b.reportedAt.getTime() - a.reportedAt.getTime())
}

// ──────────────────────────────────────────────────────────────── Orders

export interface OrderRow {
  id: string
  patientId: string
  item: string
  category: 'Lab' | 'Imaging' | 'Medication' | 'Nursing' | 'Procedure'
  placedAt: Date
  placedBy: string
  status: 'Ordered' | 'Collected' | 'In progress' | 'Resulted' | 'Cancelled' | 'Overdue'
  /** AI-308 closed-loop chasing note. */
  chase?: string
  /** AI-304 duplicate / low-value flag, awaiting a G2 disposition. */
  duplicateOf?: string
  duplicateReason?: string
  confidence?: number
  band?: ConfidenceBand
}

export const ORDERS: OrderRow[] = [
  {
    id: 'O-5501',
    patientId: 'SD-P-03',
    item: 'Chest X-ray PA',
    category: 'Imaging',
    placedAt: minutesAgo(25),
    placedBy: 'Dr. Ananya Iyer',
    status: 'Ordered',
    chase: 'Porter not yet assigned — 25 min since order, target 30 min',
  },
  {
    id: 'O-5502',
    patientId: 'SD-P-03',
    item: 'CBC',
    category: 'Lab',
    placedAt: minutesAgo(140),
    placedBy: 'Dr. Ananya Iyer',
    status: 'Resulted',
  },
  {
    id: 'O-5503',
    patientId: 'SD-P-03',
    item: 'CRP',
    category: 'Lab',
    placedAt: minutesAgo(20),
    placedBy: 'Dr. Ananya Iyer',
    status: 'Ordered',
    duplicateOf: 'O-5504',
    duplicateReason:
      'CRP was resulted 2 hours ago at 184 mg/L. A repeat inside 24 hours changes management in under 3% of cases at this trajectory.',
    confidence: 0.82,
    band: 'MED',
  },
  {
    id: 'O-5504',
    patientId: 'SD-P-03',
    item: 'CRP',
    category: 'Lab',
    placedAt: minutesAgo(120),
    placedBy: 'Dr. Ananya Iyer',
    status: 'Resulted',
  },
  {
    id: 'O-5505',
    patientId: 'SD-P-03',
    item: 'Blood culture',
    category: 'Lab',
    placedAt: new Date(2026, 8, 18, 6, 10),
    placedBy: 'Dr. Ananya Iyer',
    status: 'In progress',
    chase: 'Final read due at 72h — 18:10 today',
  },
  {
    id: 'O-5510',
    patientId: 'SD-P-07',
    item: 'Serum potassium',
    category: 'Lab',
    placedAt: minutesAgo(70),
    placedBy: 'Dr. Ananya Iyer',
    status: 'Resulted',
  },
  {
    id: 'O-5511',
    patientId: 'SD-P-07',
    item: 'ECG',
    category: 'Procedure',
    placedAt: minutesAgo(10),
    placedBy: 'Dr. Ananya Iyer',
    status: 'Ordered',
    chase: 'Ordered in response to the critical potassium',
  },
]

export function ordersFor(patientId: string): OrderRow[] {
  return ORDERS.filter((o) => o.patientId === patientId)
}

/**
 * AI-301 order suggestions from clinical context, for the S-09-01 basket.
 * Each is a discrete rankable proposal (AIP-03) with an evidence line.
 */
export const ORDER_SUGGESTIONS = [
  {
    item: 'Chest X-ray PA',
    category: 'Imaging' as const,
    evidence: 'No imaging since 19-Sep and the oxygen requirement has doubled overnight',
    confidence: 0.9,
    band: 'HIGH' as ConfidenceBand,
  },
  {
    item: 'Serum creatinine',
    category: 'Lab' as const,
    evidence: 'Creatinine rose 64 µmol/L in 24h; two active drugs need renal dosing',
    confidence: 0.88,
    band: 'HIGH' as ConfidenceBand,
  },
  {
    item: 'Sputum culture and sensitivity',
    category: 'Lab' as const,
    evidence: 'Treatment failure at 72h with no organism identified',
    confidence: 0.74,
    band: 'MED' as ConfidenceBand,
  },
  {
    item: 'Arterial blood gas',
    category: 'Procedure' as const,
    evidence: 'SpO₂ 92% on 4 L with a respiratory rate of 26',
    confidence: 0.55,
    band: 'LOW' as ConfidenceBand,
  },
]

/** Order sets, for S-09-02 and S-06-10. */
export const ORDER_SETS = [
  {
    id: 'OS.CAP-ADULT',
    name: 'Community-acquired pneumonia — adult',
    scope: 'Facility-wide' as const,
    owner: 'Dr. Vivek Sharma',
    reviewDue: '31-Mar-2027',
    items: ['CBC', 'CRP', 'Serum creatinine', 'Blood culture', 'Chest X-ray PA', 'Sputum culture'],
    usedThisMonth: 142,
  },
  {
    id: 'OS.SEPSIS-1H',
    name: 'Sepsis bundle — first hour',
    scope: 'Facility-wide' as const,
    owner: 'Dr. Vivek Sharma',
    reviewDue: '30-Sep-2026',
    items: ['Blood culture', 'CBC', 'CRP', 'Serum creatinine', 'Lactate', 'Paracetamol 1g IV'],
    usedThisMonth: 88,
  },
  {
    id: 'OS.AIYER-THYROID',
    name: 'Thyroid follow-up — Dr. Iyer',
    scope: 'Personal' as const,
    owner: 'Dr. Ananya Iyer',
    reviewDue: '—',
    items: ['TSH', 'Free T4', 'HbA1c'],
    usedThisMonth: 34,
  },
  {
    id: 'OS.STROKE-CODE',
    name: 'Code stroke — activation bundle',
    scope: 'Facility-wide' as const,
    owner: 'Dr. Rohit Desai',
    reviewDue: '31-Dec-2026',
    items: ['NCCT head', 'CT angiogram', 'CT perfusion', 'CBC', 'Serum creatinine', 'ECG', 'Troponin I'],
    usedThisMonth: 19,
  },
]

// ─────────────────────────────────────────── Worklists (S-06-01, S-08-03)

export interface WorklistRow {
  patientId: string
  bed: string | null
  /** AI-201 deterioration band. */
  risk?: 'HIGH' | 'MODERATE' | 'LOW' | 'ABSTAIN'
  /** The per-row reason chip AIP-06/AIP-07 requires. */
  reason?: string
  /** What is waiting on the clinician. */
  pending: string[]
  coSignState?: 'Co-sign pending' | null
  /** Why AI-201 abstained, where it did. */
  abstainReason?: string
  /** Deterministic sort key, for the one-click reversal. */
  chronologicalAt: Date
}

/**
 * S-06-01's needs-attention group, pinned at the top with reason chips. The
 * atlas's wireframe names both rows and both reasons verbatim.
 */
export const NEEDS_ATTENTION: WorklistRow[] = [
  {
    patientId: 'SD-P-03',
    bed: '4B-12',
    risk: 'HIGH',
    reason: 'NEWS2 7, rising 4h',
    pending: ['Ward round note', 'Antibiotic review', '2 results'],
    chronologicalAt: minutesAgo(48),
  },
  {
    patientId: 'SD-P-07',
    bed: 'ICU-1',
    risk: 'HIGH',
    reason: 'Critical K+ 6.8, unacknowledged 12 min',
    pending: ['Acknowledge critical result', 'ECG review'],
    chronologicalAt: minutesAgo(12),
  },
]

/** The rest of the consultant's inpatient list — 7 inpatients in total. */
export const INPATIENTS: WorklistRow[] = [
  ...NEEDS_ATTENTION,
  {
    patientId: 'SD-P-02',
    bed: '2A-04',
    risk: 'MODERATE',
    reason: 'Day 2 post-CABG, drains in situ',
    pending: ['Progress note'],
    chronologicalAt: minutesAgo(180),
  },
  {
    patientId: 'SD-P-09',
    bed: '4B-06',
    risk: 'LOW',
    reason: 'Stable, dialysis today',
    pending: [],
    chronologicalAt: minutesAgo(200),
  },
  {
    patientId: 'SD-P-06',
    bed: '4B-19',
    risk: 'LOW',
    reason: 'Afebrile 18h, for discharge',
    pending: ['Discharge summary'],
    coSignState: null,
    chronologicalAt: minutesAgo(240),
  },
  {
    patientId: 'SD-P-13',
    bed: '4B-15',
    risk: 'HIGH',
    reason: 'GCS 15 → 13 overnight, 6 mm midline shift',
    pending: ['Neurosurgery review', 'Progress note', '2 results'],
    chronologicalAt: minutesAgo(70),
  },
  {
    patientId: 'SD-P-12',
    bed: '4B-08',
    risk: 'MODERATE',
    reason: 'Day 3 thalamic bleed, BP 148/88 on target',
    pending: ['Progress note', 'Repeat CT review'],
    chronologicalAt: minutesAgo(130),
  },
]

/**
 * The OP clinic's booked rows. Four of these patients are also in a bed
 * (`INPATIENTS`), and `opdRows` leaves them out, so today's OPD is six — the
 * next token MED-042.
 */
/**
 * Today's teleconsult queue (S-27-02). My Day lists these patients in OPD
 * with a video icon; the Telehealth screen ranks and opens them.
 */
export interface TeleRow {
  id: string
  patientId: string
  scheduledAt: Date
  reason: string
  videoReady: boolean
  rankReason: string
}

export const TELECONSULT_QUEUE: TeleRow[] = [
  {
    id: 'E-118430',
    patientId: 'SD-P-10',
    scheduledAt: minutesAhead(25),
    reason: 'Chronic plaque psoriasis, review after topical therapy',
    videoReady: true,
    rankReason: 'On time, video tested, photographs already uploaded',
  },
  {
    id: 'E-118441',
    patientId: 'SD-P-01',
    scheduledAt: minutesAhead(55),
    reason: 'Thyroid results discussion',
    videoReady: true,
    rankReason: 'Results are back and normal — likely a short consultation',
  },
  {
    id: 'E-118452',
    patientId: 'SD-P-09',
    scheduledAt: minutesAhead(85),
    reason: 'Dialysis access site concern',
    videoReady: false,
    rankReason: 'No video on the patient side — needs a telephone fallback arranged',
  },
]

export interface ClinicRow {
  token: string
  patientId: string
  bookedAt: Date
  arrivedAt?: Date
  status: 'Seen' | 'In room' | 'Waiting' | 'Not arrived'
  /** AI-607 wait-time prediction. */
  predictedWaitMin?: number
  band?: ConfidenceBand
}

export const CLINIC_LIST: ClinicRow[] = [
  { token: 'MED-038', patientId: 'SD-P-09', bookedAt: new Date(2026, 8, 21, 8, 0), arrivedAt: minutesAgo(55), status: 'Seen' },
  { token: 'MED-039', patientId: 'SD-P-04', bookedAt: new Date(2026, 8, 21, 8, 10), arrivedAt: minutesAgo(48), status: 'Seen' },
  { token: 'MED-040', patientId: 'SD-P-06', bookedAt: new Date(2026, 8, 21, 8, 20), arrivedAt: minutesAgo(40), status: 'Seen' },
  { token: 'MED-041', patientId: 'SD-P-10', bookedAt: new Date(2026, 8, 21, 8, 30), arrivedAt: minutesAgo(32), status: 'Seen' },
  {
    token: 'MED-042',
    patientId: 'SD-P-01',
    bookedAt: new Date(2026, 8, 21, 8, 40),
    arrivedAt: minutesAgo(18),
    status: 'Waiting',
    predictedWaitMin: 4,
    band: 'HIGH',
  },
  {
    token: 'MED-043',
    patientId: 'SD-P-02',
    bookedAt: new Date(2026, 8, 21, 8, 50),
    arrivedAt: minutesAgo(9),
    status: 'Waiting',
    predictedWaitMin: 16,
    band: 'HIGH',
  },
  {
    token: 'MED-044',
    patientId: 'SD-P-07',
    bookedAt: new Date(2026, 8, 21, 9, 0),
    status: 'Not arrived',
    predictedWaitMin: 28,
    band: 'MED',
  },
  // ── Follow-ups with a head CT on the record.
  { token: 'MED-036', patientId: 'SD-P-16', bookedAt: new Date(2026, 8, 21, 7, 40), arrivedAt: minutesAgo(75), status: 'Seen' },
  {
    token: 'MED-045',
    patientId: 'SD-P-11',
    bookedAt: new Date(2026, 8, 21, 9, 10),
    arrivedAt: minutesAgo(14),
    status: 'Waiting',
    predictedWaitMin: 24,
    band: 'HIGH',
  },
  {
    token: 'MED-046',
    patientId: 'SD-P-15',
    bookedAt: new Date(2026, 8, 21, 9, 20),
    status: 'Not arrived',
    predictedWaitMin: 38,
    band: 'MED',
  },
]

/** S-06-09 — 2 co-signs pending. */
export interface CoSignRow {
  id: string
  patientId: string
  documentKind: 'Consultation note' | 'Inpatient progress note' | 'Admission assessment' | 'Addendum'
  authoredBy: string
  authoredByPersona: string
  authoredAt: Date
  /** AI-114 documentation-quality findings on the entry. */
  qualityFlags: string[]
  kind: 'cosign' | 'amendment'
}

export const COSIGN_QUEUE: CoSignRow[] = [
  {
    id: 'CS-01',
    patientId: 'SD-P-02',
    documentKind: 'Inpatient progress note',
    authoredBy: 'Dr. Ananya Iyer',
    authoredByPersona: 'P-05 Resident',
    authoredAt: minutesAgo(95),
    qualityFlags: ['Banned abbreviation: "OD" — write "once daily"'],
    kind: 'cosign',
  },
  {
    id: 'CS-02',
    patientId: 'SD-P-09',
    documentKind: 'Admission assessment',
    authoredBy: 'Dr. Ananya Iyer',
    authoredByPersona: 'P-05 Resident',
    authoredAt: minutesAgo(210),
    qualityFlags: [],
    kind: 'cosign',
  },
]

/** S-05-06 — three referrals, one urgent cardiology ranked top. */
export interface ReferralRow {
  id: string
  fromDoctor: string
  fromFacility: string
  patientName: string
  speciality: string
  reason: string
  receivedAt: Date
  /** AI-609 triage band and reason chip. */
  triage: 'Urgent' | 'Routine' | 'Soon'
  reason609: string
  confidence: number
  band: ConfidenceBand
}

export const REFERRALS: ReferralRow[] = [
  {
    id: 'REF-01',
    fromDoctor: 'Dr. M. Venkatesh',
    fromFacility: 'Sunrise Clinic, Saibaba Colony',
    patientName: 'Abdul Rahman Sheikh',
    speciality: 'Cardiology',
    reason: 'Exertional chest pain, ECG shows lateral T-wave inversion',
    receivedAt: minutesAgo(55),
    triage: 'Urgent',
    reason609: 'Chest pain with ischaemic ECG changes — 48h target',
    confidence: 0.92,
    band: 'HIGH',
  },
  {
    id: 'REF-02',
    fromDoctor: 'Dr. S. Kamath',
    fromFacility: 'Indostates Tiruppur',
    patientName: 'Fatima Bi',
    speciality: 'Nephrology',
    reason: 'Vascular access planning for long-term haemodialysis',
    receivedAt: minutesAgo(190),
    triage: 'Soon',
    reason609: 'Access planning, no acute feature — 2 week target',
    confidence: 0.81,
    band: 'MED',
  },
  {
    id: 'REF-03',
    fromDoctor: 'Dr. L. Pereira',
    fromFacility: 'Pollachi General Practice',
    patientName: 'Arjun Nair',
    speciality: 'Dermatology',
    reason: 'Chronic plaque psoriasis, not responding to topical therapy',
    receivedAt: new Date(2026, 8, 20, 16, 30),
    triage: 'Routine',
    reason609: 'Chronic, stable, no red flags — routine list',
    confidence: 0.88,
    band: 'HIGH',
  },
]

/** S-13-01 discharge readiness — AI-610 predicts discharges at 07:00. */
export interface DischargeRow {
  patientId: string
  bed: string
  /** AI-610 band. */
  likelihood: 'Today' | 'Tomorrow' | 'Not yet'
  confidence: number
  band: ConfidenceBand
  blockers: string[]
  /** AI-514 financial clearance readiness. */
  financialClearance: 'Clear' | 'TPA approval pending' | 'Estimate unsigned'
  reason: string
}

export const DISCHARGE_BOARD: DischargeRow[] = [
  {
    patientId: 'SD-P-06',
    bed: '4B-19',
    likelihood: 'Today',
    confidence: 0.91,
    band: 'HIGH',
    blockers: ['Discharge summary unsigned'],
    financialClearance: 'Clear',
    reason: 'Afebrile 18h, oral intake established, no active orders',
  },
  {
    patientId: 'SD-P-09',
    bed: '4B-06',
    likelihood: 'Today',
    confidence: 0.78,
    band: 'MED',
    blockers: ['Dialysis session at 14:00', 'Transport not arranged'],
    financialClearance: 'Clear',
    reason: 'Routine chronic admission, dialysis completes at 16:30',
  },
  {
    patientId: 'SD-P-02',
    bed: '2A-04',
    likelihood: 'Tomorrow',
    confidence: 0.83,
    band: 'MED',
    blockers: ['Drains in situ', 'Physiotherapy sign-off'],
    financialClearance: 'TPA approval pending',
    reason: 'Day 2 post-CABG, on the standard 5-day pathway',
  },
  {
    patientId: 'SD-P-03',
    bed: '4B-12',
    likelihood: 'Not yet',
    confidence: 0.94,
    band: 'HIGH',
    blockers: ['Deteriorating — NEWS2 7', 'Antibiotics being escalated'],
    financialClearance: 'Estimate unsigned',
    reason: 'Rising oxygen requirement at 72h; not on a discharge trajectory',
  },
]

/** The record's audit trail, for the C-42 provenance panel and the timeline. */
export interface TimelineEvent {
  at: Date
  kind: 'note' | 'order' | 'result' | 'medication' | 'vitals' | 'admission' | 'imaging' | 'ai'
  label: string
  detail: string
  by: string
  /** Set where an AI touchpoint produced or influenced the entry. */
  ai?: string
}

export const TIMELINE: Record<string, TimelineEvent[]> = {
  'SD-P-03': [
    {
      at: new Date(2026, 8, 17, 14, 20),
      kind: 'admission',
      label: 'Admitted to 4B-12',
      detail: 'Community-acquired pneumonia. Transferred from Emergency after 3h 40m.',
      by: 'Dr. Ananya Iyer',
    },
    {
      at: new Date(2026, 8, 17, 15, 5),
      kind: 'order',
      label: 'Order set applied — CAP adult',
      detail: 'OS.CAP-ADULT · 6 orders placed',
      by: 'Dr. Ananya Iyer',
      ai: 'AI-302',
    },
    {
      at: new Date(2026, 8, 17, 16, 40),
      kind: 'medication',
      label: 'Piperacillin-tazobactam 4.5g IV started',
      detail: '8-hourly. Penicillin allergy override was NOT required — patient tolerated previously.',
      by: 'Dr. Ananya Iyer',
    },
    {
      at: new Date(2026, 8, 19, 10, 15),
      kind: 'imaging',
      label: 'Chest X-ray PA',
      detail: 'Right lower lobe consolidation, no effusion.',
      by: 'Dr. Neha Bhatt',
      ai: 'AI-402',
    },
    {
      at: new Date(2026, 8, 20, 6, 40),
      kind: 'result',
      label: 'Blood culture — no growth at 48h',
      detail: 'Final read due at 72h.',
      by: 'Laboratory',
    },
    {
      at: minutesAgo(170),
      kind: 'vitals',
      label: 'Oxygen increased 2 L → 4 L',
      detail: 'SpO₂ had fallen to 89% on 2 L.',
      by: 'Sr. Lalitha Raman',
    },
    {
      at: minutesAgo(48),
      kind: 'ai',
      label: 'Deterioration risk HIGH',
      detail: 'NEWS2 7, rising over 4 hours. Drivers: respiratory rate, SpO₂, temperature.',
      by: 'AI-201 v2.4.1',
      ai: 'AI-201',
    },
    {
      at: minutesAgo(120),
      kind: 'result',
      label: 'CRP 184 mg/L ↑ High',
      detail: 'Up from 96 mg/L. Treatment failure pattern at 72h.',
      by: 'Laboratory',
      ai: 'AI-212',
    },
  ],
  'SD-P-01': [
    {
      at: new Date(2026, 2, 14, 10, 30),
      kind: 'note',
      label: 'Consultation — thyroid review',
      detail: 'Levothyroxine continued at 75 mcg. Repeat TFT in 6 months.',
      by: 'Dr. Ananya Iyer',
    },
    {
      at: new Date(2026, 8, 18, 11, 20),
      kind: 'result',
      label: 'TSH 2.4 mIU/L · Free T4 14.2 pmol/L',
      detail: 'Both within reference range.',
      by: 'Laboratory',
      ai: 'AI-212',
    },
    {
      at: minutesAgo(18),
      kind: 'admission',
      label: 'Arrived, ABHA Scan & Share',
      detail: 'Token MED-042. Demographics pulled from ABHA; nothing typed.',
      by: 'Front office',
      ai: 'AI-702',
    },
  ],
  'SD-P-11': [
    {
      at: new Date(2026, 7, 31, 19, 10),
      kind: 'admission',
      label: 'Admitted after a fall at home',
      detail: 'Confused and drowsy for two days. On apixaban for atrial fibrillation.',
      by: 'Dr. Ananya Iyer',
    },
    {
      at: new Date(2026, 7, 31, 19, 40),
      kind: 'imaging',
      label: 'CT head — right subdural haematoma',
      detail: 'Mixed-density collection over the right convexity with midline shift.',
      by: 'Dr. Neha Bhatt',
      ai: 'AI-402',
    },
    {
      at: new Date(2026, 8, 1, 9, 30),
      kind: 'order',
      label: 'Burr-hole evacuation',
      detail: 'Neurosurgery. Uneventful; drain removed day 2.',
      by: 'Neurosurgery',
    },
    {
      at: new Date(2026, 8, 7, 11, 0),
      kind: 'note',
      label: 'Discharged home',
      detail: 'Apixaban held until review. Levetiracetam for 3 months.',
      by: 'Dr. Ananya Iyer',
    },
    {
      at: minutesAgo(60),
      kind: 'result',
      label: 'Sodium 131 mmol/L ↓ Low',
      detail: 'Down from 134 at discharge.',
      by: 'Laboratory',
      ai: 'AI-212',
    },
  ],
  'SD-P-12': [
    {
      at: new Date(2026, 8, 18, 23, 40),
      kind: 'admission',
      label: 'Admitted to the stroke unit, 4B-08',
      detail: 'Code stroke from Emergency at 22:31 — sudden right-sided weakness and slurred speech, BP 212/118.',
      by: 'Dr. Ananya Iyer',
    },
    {
      at: new Date(2026, 8, 18, 22, 44),
      kind: 'imaging',
      label: 'CT head — left thalamic haemorrhage',
      detail: 'Small deep bleed, no ventricular extension, no midline shift.',
      by: 'Dr. Neha Bhatt',
      ai: 'AI-402',
    },
    {
      at: new Date(2026, 8, 18, 23, 0),
      kind: 'medication',
      label: 'IV labetalol infusion started',
      detail: 'Target systolic 140 within the hour.',
      by: 'Dr. Ananya Iyer',
    },
    {
      at: minutesAgo(130),
      kind: 'vitals',
      label: 'BP 148/88 — on target',
      detail: 'Switched to oral amlodipine and telmisartan.',
      by: 'Sr. Lalitha Raman',
    },
  ],
  'SD-P-13': [
    {
      at: new Date(2026, 8, 20, 18, 30),
      kind: 'admission',
      label: 'Admitted to the stroke unit, 4B-15',
      detail: 'Code stroke at 17:52 — found with left-sided weakness; last seen well about 30 hours earlier.',
      by: 'Dr. Ananya Iyer',
    },
    {
      at: new Date(2026, 8, 20, 18, 5),
      kind: 'imaging',
      label: 'CT head — large right MCA infarct',
      detail: 'Established infarct with mass effect and midline shift. No haemorrhage.',
      by: 'Dr. Neha Bhatt',
      ai: 'AI-402',
    },
    {
      at: minutesAgo(70),
      kind: 'ai',
      label: 'Deterioration risk HIGH',
      detail: 'GCS 15 → 13 overnight. Drivers: conscious level, midline shift, sodium.',
      by: 'AI-201 v2.4.1',
      ai: 'AI-201',
    },
  ],
  'SD-P-14': [
    {
      at: new Date(2026, 8, 21, 2, 24),
      kind: 'admission',
      label: 'Code stroke at Tiruppur',
      detail: 'Left hemiplegia, GCS 10. On warfarin for atrial fibrillation. Telestroke with the hub.',
      by: 'Dr. Rohit Desai',
    },
    {
      at: new Date(2026, 8, 21, 2, 34),
      kind: 'imaging',
      label: 'CT head — large right basal ganglia haemorrhage',
      detail: 'Intraventricular and subarachnoid extension, mass effect, midline shift.',
      by: 'Dr. Neha Bhatt',
      ai: 'AI-402',
    },
    {
      at: new Date(2026, 8, 21, 2, 40),
      kind: 'result',
      label: 'INR 3.8 ↑↑ Critical high',
      detail: 'Acknowledged by Dr. Rohit Desai at 02:42.',
      by: 'Laboratory',
      ai: 'AI-212',
    },
    {
      at: new Date(2026, 8, 21, 2, 48),
      kind: 'medication',
      label: 'Prothrombin complex concentrate + vitamin K 10 mg IV',
      detail: 'Warfarin reversal. Repeat INR 30 minutes after.',
      by: 'Dr. Rohit Desai',
    },
  ],
  'SD-P-15': [
    {
      at: new Date(2026, 8, 9, 10, 0),
      kind: 'note',
      label: 'Consultation — recurrent headache',
      detail: 'Migraine without aura; red flags absent. CT to reassure after a worse episode.',
      by: 'Dr. Ananya Iyer',
    },
    {
      at: new Date(2026, 8, 9, 12, 15),
      kind: 'imaging',
      label: 'CT head — normal',
      detail: 'No haemorrhage, mass or hydrocephalus.',
      by: 'Dr. Neha Bhatt',
      ai: 'AI-402',
    },
  ],
  'SD-P-16': [
    {
      at: new Date(2026, 8, 14, 22, 50),
      kind: 'admission',
      label: 'Emergency — two-wheeler fall, helmet on',
      detail: 'Brief confusion, no loss of consciousness. Medico-legal case registered.',
      by: 'Emergency',
    },
    {
      at: new Date(2026, 8, 14, 23, 40),
      kind: 'imaging',
      label: 'CT head — no acute injury',
      detail: 'Thin-slice series reviewed; no bleed, no fracture on the imaged levels.',
      by: 'Dr. Neha Bhatt',
      ai: 'AI-402',
    },
  ],
}

export function timelineFor(patientId: string): TimelineEvent[] {
  return (TIMELINE[patientId] ?? []).slice().sort((a, b) => b.at.getTime() - a.at.getTime())
}

/** Vitals for the patient banner risk strip and the objective section. */
export const VITALS: Record<string, { label: string; value: string; flag: 'Normal' | '↑ High' | '↓ Low'; at: Date }[]> = {
  'SD-P-03': [
    { label: 'Respiratory rate', value: '26 /min', flag: '↑ High', at: minutesAgo(50) },
    { label: 'SpO₂', value: '92% on 4 L', flag: '↓ Low', at: minutesAgo(50) },
    { label: 'Pulse', value: '108 bpm', flag: '↑ High', at: minutesAgo(50) },
    { label: 'BP', value: '104/62 mmHg', flag: 'Normal', at: minutesAgo(50) },
    { label: 'Temperature', value: '38.4 °C', flag: '↑ High', at: minutesAgo(50) },
  ],
  'SD-P-01': [
    { label: 'Pulse', value: '76 bpm', flag: 'Normal', at: minutesAgo(9) },
    { label: 'BP', value: '118/74 mmHg', flag: 'Normal', at: minutesAgo(9) },
    { label: 'Temperature', value: '36.8 °C', flag: 'Normal', at: minutesAgo(9) },
    { label: 'SpO₂', value: '99% on air', flag: 'Normal', at: minutesAgo(9) },
    { label: 'Weight', value: '58 kg', flag: 'Normal', at: minutesAgo(9) },
  ],
  'SD-P-07': [
    { label: 'Respiratory rate', value: '18 /min (SIMV)', flag: 'Normal', at: minutesAgo(20) },
    { label: 'SpO₂', value: '94% on FiO₂ 0.5', flag: 'Normal', at: minutesAgo(20) },
    { label: 'Pulse', value: '124 bpm', flag: '↑ High', at: minutesAgo(20) },
    { label: 'BP', value: '86/48 mmHg (noradrenaline)', flag: '↓ Low', at: minutesAgo(20) },
    { label: 'Temperature', value: '38.9 °C', flag: '↑ High', at: minutesAgo(20) },
  ],
  'SD-P-02': [
    { label: 'Pulse', value: '88 bpm (sinus)', flag: 'Normal', at: minutesAgo(60) },
    { label: 'BP', value: '122/70 mmHg', flag: 'Normal', at: minutesAgo(60) },
    { label: 'SpO₂', value: '96% on 2 L', flag: 'Normal', at: minutesAgo(60) },
    { label: 'Temperature', value: '37.2 °C', flag: 'Normal', at: minutesAgo(60) },
  ],
  'SD-P-09': [
    { label: 'BP', value: '152/88 mmHg', flag: '↑ High', at: minutesAgo(90) },
    { label: 'Pulse', value: '82 bpm', flag: 'Normal', at: minutesAgo(90) },
    { label: 'Weight', value: '55.6 kg (+1.6 kg)', flag: '↑ High', at: minutesAgo(90) },
  ],
  'SD-P-11': [
    { label: 'Pulse', value: '84 bpm (irregular)', flag: 'Normal', at: minutesAgo(12) },
    { label: 'BP', value: '134/78 mmHg', flag: 'Normal', at: minutesAgo(12) },
    { label: 'Temperature', value: '36.7 °C', flag: 'Normal', at: minutesAgo(12) },
    { label: 'SpO₂', value: '97% on air', flag: 'Normal', at: minutesAgo(12) },
    { label: 'Weight', value: '52 kg', flag: 'Normal', at: minutesAgo(12) },
  ],
  'SD-P-12': [
    { label: 'BP', value: '148/88 mmHg', flag: '↑ High', at: minutesAgo(130) },
    { label: 'Pulse', value: '72 bpm', flag: 'Normal', at: minutesAgo(130) },
    { label: 'GCS', value: '15 (E4V5M6)', flag: 'Normal', at: minutesAgo(130) },
    { label: 'SpO₂', value: '98% on air', flag: 'Normal', at: minutesAgo(130) },
    { label: 'Temperature', value: '36.9 °C', flag: 'Normal', at: minutesAgo(130) },
  ],
  'SD-P-13': [
    { label: 'GCS', value: '13 (E3V4M6)', flag: '↓ Low', at: minutesAgo(70) },
    { label: 'BP', value: '164/92 mmHg', flag: '↑ High', at: minutesAgo(70) },
    { label: 'Pulse', value: '64 bpm', flag: 'Normal', at: minutesAgo(70) },
    { label: 'SpO₂', value: '96% on air', flag: 'Normal', at: minutesAgo(70) },
    { label: 'Temperature', value: '37.4 °C', flag: 'Normal', at: minutesAgo(70) },
  ],
  'SD-P-14': [
    { label: 'GCS', value: '10 (E2V3M5)', flag: '↓ Low', at: new Date(2026, 8, 21, 2, 44) },
    { label: 'BP', value: '196/104 mmHg', flag: '↑ High', at: new Date(2026, 8, 21, 2, 44) },
    { label: 'Pulse', value: '96 bpm (AF)', flag: 'Normal', at: new Date(2026, 8, 21, 2, 40) },
    { label: 'SpO₂', value: '95% on 2 L', flag: 'Normal', at: new Date(2026, 8, 21, 2, 40) },
  ],
  'SD-P-15': [
    { label: 'BP', value: '116/72 mmHg', flag: 'Normal', at: new Date(2026, 8, 9, 10, 5) },
    { label: 'Pulse', value: '70 bpm', flag: 'Normal', at: new Date(2026, 8, 9, 10, 5) },
    { label: 'Weight', value: '60 kg', flag: 'Normal', at: new Date(2026, 8, 9, 10, 5) },
  ],
  'SD-P-16': [
    { label: 'BP', value: '124/76 mmHg', flag: 'Normal', at: minutesAgo(72) },
    { label: 'Pulse', value: '68 bpm', flag: 'Normal', at: minutesAgo(72) },
    { label: 'GCS', value: '15', flag: 'Normal', at: minutesAgo(72) },
  ],
}

/** The banner's deterioration strip — AI-201, AIP-05. */
export interface RiskStrip {
  band: 'HIGH' | 'MODERATE' | 'LOW' | 'ABSTAIN'
  score: string
  trend: string
  drivers: { label: string; direction: 'up' | 'down'; weight: number }[]
  modelVersion: string
  computedAt: Date
  /** Where AI-201 abstains, why — never a null or zero. */
  abstainReason?: string
}

export const RISK_STRIPS: Record<string, RiskStrip> = {
  'SD-P-03': {
    band: 'HIGH',
    score: 'NEWS2 7',
    trend: 'rising over 4h',
    drivers: [
      { label: 'Respiratory rate 26', direction: 'up', weight: 0.34 },
      { label: 'SpO₂ 92% on 4 L', direction: 'down', weight: 0.28 },
      { label: 'Temperature 38.4 °C', direction: 'up', weight: 0.19 },
      { label: 'Pulse 108', direction: 'up', weight: 0.12 },
    ],
    modelVersion: 'AI-201 v2.4.1',
    computedAt: minutesAgo(48),
  },
  'SD-P-07': {
    band: 'HIGH',
    score: 'SOFA 11',
    trend: 'stable 6h',
    drivers: [
      { label: 'Vasopressor requirement', direction: 'up', weight: 0.31 },
      { label: 'Creatinine 268 µmol/L', direction: 'up', weight: 0.26 },
      { label: 'Platelets 84 ×10⁹/L', direction: 'down', weight: 0.22 },
    ],
    modelVersion: 'AI-215 v1.9.0',
    computedAt: minutesAgo(35),
  },
  'SD-P-13': {
    band: 'HIGH',
    score: 'GCS 13',
    trend: 'falling overnight',
    drivers: [
      { label: 'GCS 15 → 13', direction: 'down', weight: 0.38 },
      { label: 'Midline shift 6 mm on CT', direction: 'up', weight: 0.3 },
      { label: 'Sodium 133, falling', direction: 'down', weight: 0.17 },
      { label: 'Glucose 188', direction: 'up', weight: 0.09 },
    ],
    modelVersion: 'AI-201 v2.4.1',
    computedAt: minutesAgo(70),
  },
  'SD-P-12': {
    band: 'MODERATE',
    score: 'NEWS2 3',
    trend: 'improving 24h',
    drivers: [
      { label: 'Systolic BP 148', direction: 'up', weight: 0.41 },
      { label: 'Day 3 after ICH — expansion window closing', direction: 'down', weight: 0.22 },
    ],
    modelVersion: 'AI-201 v2.4.1',
    computedAt: minutesAgo(130),
  },
}

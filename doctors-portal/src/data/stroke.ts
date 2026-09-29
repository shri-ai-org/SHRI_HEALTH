/**
 * M-18 · Stroke-AI Command Centre data.
 *
 * "A hub-and-spoke stroke network run as a clock, not a queue."
 *
 * Every value here is from a screen spec's wireframe or Sample data line.
 * SD-P-05 Vikram Malhotra is the deck protagonist — one patient across seven
 * screens, which is "what makes the flagship read as a system rather than
 * seven dashboards."
 *
 * The stroke module runs on its own clock. §8.6 fixes 08:40 for the product,
 * "unless the screen is explicitly a spoke" — and this case happens at 02:00,
 * because that is when the design has to work.
 */

import type { ConfidenceBand } from '@/atlas/confidence'
import { facility } from '@/data/kit'

/** Server time on the live case clock. S-18-06 draws 02:55:12. */
export const STROKE_NOW = new Date(2026, 8, 21, 2, 52, 0)

function at(h: number, m: number): Date {
  return new Date(2026, 8, 21, h, m, 0)
}

/** A stamp on an earlier night — the closed cases happened before today. */
function on(day: number, h: number, m: number): Date {
  return new Date(2026, 8, day, h, m, 0)
}

// ────────────────────────────────────────────────────────── The case itself

export interface StrokeCase {
  id: string
  caseNo: string
  patientId: string
  originFacility: string
  destinationFacility: string
  /** Last known well. Everything eligibility-related hangs off this. */
  lkw: Date
  activatedAt: Date
  activatedBy: string
  status: 'active' | 'de-activated' | 'closed'
  deactivationReason?: string
  /** Break-glass is the normal path for a remote on-call (S-18-14 permission). */
  breakGlassBy?: string
  nihss: number
  payer: string
  /** What happened to a closed case, in one line. */
  outcome?: string
  /** The scan-side facts the study's labels cannot carry. */
  imaging: CaseImaging
}

/**
 * What the imaging showed beyond the haemorrhage labels, per case. The labels
 * (`ncct.generated.ts`) say WHETHER there is blood or shift; this says where,
 * how much, and what the next step is — the parts a report reads for.
 */
export interface CaseImaging {
  acquiredAt: Date
  deliveredAt: Date
  /** ASPECTS where it applies. null on a haemorrhage, where it is not scored. */
  aspects: number | null
  hyperdenseVessel: string
  /** A CTA-confirmed large-vessel occlusion. Only then do the CTA and CTP blocks read. */
  lvo: boolean
  lesion?: { site: string; volumeMl?: number; shiftMm?: number; extension?: string }
  /** ICH score, 0–6, for a haemorrhage. */
  ichScore?: number
  bp: string
  /** Anticoagulant on board, if any — a thrombolysis contraindication in its own right. */
  anticoagulant?: string
  /** Where CTA/CTP were not done, why — so the report does not look incomplete. */
  notPerformed?: string
  /** The next step, as the verdict ends it. */
  recommendation: string
  /** Who takes the patient next. */
  receiving: string
}

export const STROKE_CASES: StrokeCase[] = [
  {
    id: '0141',
    caseNo: 'STROKE/26-27/0141',
    patientId: 'SD-P-05',
    originFacility: 'IPL',
    destinationFacility: 'ICH',
    lkw: at(1, 20),
    activatedAt: at(2, 16),
    activatedBy: 'Dr. Priya Menon',
    status: 'active',
    breakGlassBy: 'Dr. Rohit Desai',
    nihss: 14,
    payer: 'TPA cashless',
    imaging: {
      acquiredAt: at(2, 32),
      deliveredAt: at(2, 40),
      aspects: 8,
      hyperdenseVessel: 'PRESENT — left MCA',
      lvo: true,
      bp: '168/94',
      recommendation: 'IV tenecteplase now, then transfer for mechanical thrombectomy.',
      receiving: 'Stroke unit · cath lab on standby',
    },
  },
  {
    /** The mimic. A network that only shows true strokes is not being honest. */
    id: '0140',
    caseNo: 'STROKE/26-27/0140',
    patientId: 'SD-P-03',
    originFacility: 'ICH',
    destinationFacility: 'ICH',
    lkw: at(0, 35),
    activatedAt: at(0, 52),
    activatedBy: 'Dr. Ananya Iyer',
    status: 'de-activated',
    deactivationReason: 'Seizure with post-ictal deficit — stroke mimic. De-activated 01:12.',
    nihss: 4,
    payer: 'PM-JAY',
    imaging: {
      acquiredAt: at(0, 58),
      deliveredAt: at(1, 2),
      aspects: 10,
      hyperdenseVessel: 'Absent',
      lvo: false,
      bp: '138/82',
      notPerformed: 'CTA not performed — the deficit was resolving and the history pointed to a seizure.',
      recommendation: 'Stand down. Neurology review for the seizure; no stroke treatment is indicated.',
      receiving: 'Ward 4B · general medicine',
    },
  },
  {
    /** A deep hypertensive bleed — small, no extension, a blood-pressure pathway. */
    id: '0137',
    caseNo: 'STROKE/26-27/0137',
    patientId: 'SD-P-12',
    originFacility: 'ICH',
    destinationFacility: 'ICH',
    lkw: on(18, 22, 5),
    activatedAt: on(18, 22, 31),
    activatedBy: 'Dr. Ananya Iyer',
    status: 'closed',
    outcome: 'Haemorrhage on CT — thrombolysis contraindicated. Admitted to the stroke unit for blood-pressure control.',
    nihss: 7,
    payer: 'CGHS',
    imaging: {
      acquiredAt: on(18, 22, 44),
      deliveredAt: on(18, 22, 48),
      aspects: null,
      hyperdenseVessel: 'Absent',
      lvo: false,
      lesion: { site: 'Left thalamus', volumeMl: 6, shiftMm: 0, extension: 'No intraventricular extension' },
      ichScore: 0,
      bp: '212/118',
      notPerformed: 'CTA not performed — a small deep bleed with a clear hypertensive cause; the NCCT decided the pathway.',
      recommendation: 'Lower systolic BP to 140 within the hour; stroke-unit care and a repeat CT at 24 hours.',
      receiving: 'Stroke unit · 4B',
    },
  },
  {
    /** Late and large — outside every window, the danger now is swelling. */
    id: '0138',
    caseNo: 'STROKE/26-27/0138',
    patientId: 'SD-P-13',
    originFacility: 'ICH',
    destinationFacility: 'ICH',
    lkw: on(19, 12, 0),
    activatedAt: on(20, 17, 52),
    activatedBy: 'Dr. Ananya Iyer',
    status: 'closed',
    outcome: 'Established infarct about 30 hours after last seen well — no reperfusion option. Admitted; neurosurgery informed.',
    nihss: 18,
    payer: 'TPA cashless',
    imaging: {
      acquiredAt: on(20, 18, 5),
      deliveredAt: on(20, 18, 9),
      aspects: 2,
      hyperdenseVessel: 'Absent',
      lvo: false,
      lesion: { site: 'Right MCA territory', shiftMm: 6, extension: 'Right lateral ventricle and sulci effaced' },
      bp: '164/92',
      notPerformed:
        'CTA and perfusion not performed — last seen well about 30 hours earlier with an established infarct, so no reperfusion decision depends on them.',
      recommendation:
        'Neurosurgery review for decompressive hemicraniectomy (under 60, within 48 hours); keep sodium at or above 140.',
      receiving: 'Stroke unit · neurosurgery informed',
    },
  },
  {
    /** The anticoagulated bleed. The hour belongs to reversal and neurosurgery, not to lysis. */
    id: '0142',
    caseNo: 'STROKE/26-27/0142',
    patientId: 'SD-P-14',
    originFacility: 'ITP',
    destinationFacility: 'ICH',
    lkw: at(1, 50),
    activatedAt: at(2, 24),
    activatedBy: 'Dr. Rohit Desai',
    status: 'active',
    nihss: 21,
    payer: 'ESI',
    imaging: {
      acquiredAt: at(2, 34),
      deliveredAt: at(2, 38),
      aspects: null,
      hyperdenseVessel: 'Absent',
      lvo: false,
      lesion: {
        site: 'Right basal ganglia and thalamus',
        volumeMl: 48,
        shiftMm: 8,
        extension: 'Intraventricular and subarachnoid extension',
      },
      ichScore: 3,
      bp: '196/104',
      anticoagulant: 'Warfarin — INR 3.8',
      notPerformed: 'CTA and perfusion not performed — the NCCT shows a haemorrhage, so no reperfusion decision depends on them.',
      recommendation:
        'Reverse warfarin now (PCC + vitamin K), lower systolic BP to 140, and transfer to the hub for neurosurgery and neuro-ICU.',
      receiving: 'Neuro-ICU · neurosurgery on call',
    },
  },
]

export const ACTIVE_CASE = STROKE_CASES[0]

export function strokeCase(id: string): StrokeCase {
  const c = maybeStrokeCase(id)
  if (!c) throw new Error(`Unknown stroke case ${id}`)
  return c
}

export function maybeStrokeCase(id: string | undefined): StrokeCase | undefined {
  if (!id) return undefined
  return STROKE_CASES.find((x) => x.id === id || x.caseNo.endsWith(id))
}

/** The stroke case, if any, a patient is on. Newest first. */
export function strokeCaseForPatient(patientId: string): StrokeCase | undefined {
  return STROKE_CASES.filter((c) => c.patientId === patientId).sort(
    (a, b) => b.activatedAt.getTime() - a.activatedAt.getTime(),
  )[0]
}

// ─────────────────────────────────────────── S-18-06 · the interval clocks

export type IntervalState = 'DONE' | 'RUNNING' | 'PENDING' | 'BREACH'

export interface ClockInterval {
  key: string
  label: string
  /** Target in minutes. null where the interval has no target. */
  targetMin: number | null
  /** Stamped start, where known. */
  startedAt: Date | null
  /** Stamped completion. null means it is still running or pending. */
  stampedAt: Date | null
  state: IntervalState
  /**
   * "The owner column is what turns a dashboard into a coordination tool."
   */
  nextAction: string
  owner: string
  /** AI-209's projected breach, where it has one. */
  projectedBreachIn?: number
  blockingStep?: string
}

/**
 * S-18-06 sample data: door 02:14, CT start 02:32, CT done 02:41,
 * needle 02:55 → DTN 41 min; DIDO pending.
 *
 * The needle is deliberately NOT stamped here — stamping it is the clickable
 * step, and doing so is what closes the DTN interval.
 */
export const CASE_INTERVALS: ClockInterval[] = [
  {
    key: 'ems',
    label: 'EMS → team notified',
    targetMin: null,
    startedAt: at(1, 52),
    stampedAt: at(2, 4),
    state: 'DONE',
    nextAction: '—',
    owner: '—',
  },
  {
    key: 'd2ct',
    label: 'Door → CT start',
    targetMin: 25,
    startedAt: at(2, 14),
    stampedAt: at(2, 32),
    state: 'DONE',
    nextAction: '—',
    owner: '—',
  },
  {
    key: 'ct2ai',
    label: 'CT → AI result',
    targetMin: 5,
    startedAt: at(2, 32),
    stampedAt: at(2, 36),
    state: 'DONE',
    nextAction: '—',
    owner: '—',
  },
  {
    key: 'ct2read',
    label: 'CT → read',
    targetMin: 20,
    startedAt: at(2, 32),
    stampedAt: at(2, 46),
    state: 'DONE',
    nextAction: '—',
    owner: '—',
  },
  {
    key: 'dtn',
    label: 'Door → needle',
    targetMin: 60,
    startedAt: at(2, 14),
    stampedAt: null,
    state: 'RUNNING',
    nextAction: 'Administer tenecteplase and stamp the needle',
    owner: 'Dr. Rohit Desai',
  },
  {
    key: 'dido',
    label: 'Door-in → door-out',
    targetMin: 60,
    startedAt: at(2, 14),
    stampedAt: null,
    state: 'BREACH',
    nextAction: 'Load the ambulance',
    owner: 'Sr. Grace Fernandes',
    projectedBreachIn: 19,
    blockingStep: 'Ambulance not loaded — AMB-IPL-03 is on site but the trolley has not moved',
  },
  {
    key: 'groin',
    label: 'Groin puncture',
    targetMin: 90,
    startedAt: null,
    stampedAt: null,
    state: 'PENDING',
    nextAction: 'Cath lab CATH-1 reserved from 03:40',
    owner: 'Dr. Samir Kulkarni',
  },
]

/** The stampable events, one keystroke each. The stream is append-only. */
export const STAMPABLE_EVENTS = [
  { key: 'ct-done', label: 'CT done', stamped: at(2, 41) },
  { key: 'needle', label: 'Needle', stamped: null },
  { key: 'door-out', label: 'Door-out', stamped: null },
  { key: 'groin', label: 'Groin puncture', stamped: null },
]

// ───────────────────────────────── S-18-14 · Imaging AI triage (AI-403/404)

export interface ImagingFinding {
  label: string
  value: string
  /** An explicit negative — "that negative is what unlocks thrombolysis." */
  emphasisNegative?: boolean
  band?: ConfidenceBand
  confidence?: number
}

export const IMAGING_TRIAGE = {
  studyId: 'ST-9914',
  study: 'NCCT head + CT angiogram',
  acquiredAt: at(2, 32),
  reconstructedAt: at(2, 36),
  /** "delivered 4 min after reconstruction" */
  deliveredAt: at(2, 40),
  /** "The card must name model@version. A finding with no provenance is not
   *  actionable clinically or legally." */
  model: 'lvo-det v4.2.1',
  /** G3 — "it prioritises and notifies; it never diagnoses." */
  gate: 'G3' as const,
  findings: [
    { label: 'ICH', value: 'NO', emphasisNegative: true, band: 'HIGH' as ConfidenceBand, confidence: 0.97 },
    { label: 'LVO', value: 'LEFT M1', band: 'HIGH' as ConfidenceBand, confidence: 0.94 },
    { label: 'ASPECTS', value: '8', band: 'HIGH' as ConfidenceBand, confidence: 0.86 },
    { label: 'Hyperdense vessel sign', value: 'YES', band: 'MED' as ConfidenceBand, confidence: 0.72 },
  ] satisfies ImagingFinding[],
  limits: [
    'Validated on 14,200 non-contrast head CTs across 9 Indian sites, including 1,840 from this group.',
    'Sensitivity falls with motion artefact and on scanners below 16 slices.',
    'Does not detect posterior circulation occlusion reliably.',
    'This is a prioritisation and notification tool. It is not a diagnosis.',
  ],
}

/** S-18-15 · ASPECTS. 10 regions, 1 point lost per affected region. */
export const ASPECTS_REGIONS = [
  { key: 'caudate', label: 'Caudate', aiAffected: false, humanAffected: false },
  { key: 'lentiform', label: 'Lentiform nucleus', aiAffected: true, humanAffected: true },
  { key: 'insula', label: 'Insular ribbon', aiAffected: true, humanAffected: true },
  { key: 'ic', label: 'Internal capsule', aiAffected: false, humanAffected: false },
  { key: 'm1', label: 'M1 — anterior MCA cortex', aiAffected: false, humanAffected: true },
  { key: 'm2', label: 'M2 — lateral to insula', aiAffected: false, humanAffected: false },
  { key: 'm3', label: 'M3 — posterior MCA cortex', aiAffected: false, humanAffected: false },
  { key: 'm4', label: 'M4 — anterior superior', aiAffected: false, humanAffected: false },
  { key: 'm5', label: 'M5 — lateral superior', aiAffected: false, humanAffected: false },
  { key: 'm6', label: 'M6 — posterior superior', aiAffected: false, humanAffected: false },
]

/** S-18-16 · Perfusion. Core, penumbra, and whether there is tissue worth saving. */
export const PERFUSION = {
  model: 'perf-quant v2.8.0',
  coreMl: 18,
  penumbraMl: 96,
  mismatchRatio: 5.3,
  hypoperfusionIndex: 0.32,
  /** Target mismatch profile: core < 70 mL and ratio > 1.8. */
  targetMismatch: true,
  band: 'HIGH' as ConfidenceBand,
  confidence: 0.89,
  interpretation:
    'Small core with a large penumbra. 96 mL of tissue is at risk but still salvageable — this is the profile that benefits most from thrombectomy.',
}

// ──────────────────────────── S-18-17 · Thrombolysis eligibility & dosing

export type CriterionState = 'ok' | 'blocks' | 'unknown' | 'contraindicated'

export interface Criterion {
  key: string
  label: string
  answer: string
  state: CriterionState
  /**
   * "every item answerable UNKNOWN and each unknown showing its consequence.
   * That is what makes it usable by a general physician at 02:00."
   */
  consequence: string
  /** The sub-flow that unblocks a blocking item. */
  subFlow?: { label: string; detail: string }
  /** Actions offered where the answer is uncertain. */
  actions?: string[]
}

export const THROMBOLYSIS_CRITERIA: Criterion[] = [
  {
    key: 'time',
    label: 'Time from LKW < 4.5h',
    answer: '01:20 → 1h 35m',
    state: 'ok',
    consequence: 'Within the thrombolysis window.',
  },
  {
    key: 'nihss',
    label: 'NIHSS',
    answer: '14',
    state: 'ok',
    consequence: 'Moderate-to-severe deficit; treatment indicated.',
  },
  {
    key: 'bp',
    label: 'BP < 185/110',
    answer: '196/104',
    state: 'blocks',
    consequence: 'BLOCKS. The item unblocks only when a BP below threshold is documented.',
    subFlow: {
      label: 'Treat to target',
      detail:
        'Labetalol 10 mg IV over 1–2 min, repeat every 10 min to a maximum of 300 mg. Re-measure and document before proceeding.',
    },
  },
  {
    key: 'glucose',
    label: 'Glucose',
    answer: '7.2 mmol/L',
    state: 'ok',
    consequence: 'Neither hypo- nor hyperglycaemic enough to mimic or contraindicate.',
  },
  {
    key: 'coag',
    label: 'Platelets / INR',
    answer: 'pending',
    state: 'unknown',
    consequence:
      'Unknown → proceed if the clinical picture supports it. No history of anticoagulation or bleeding disorder is documented.',
    actions: ['Chase laboratory'],
  },
  {
    key: 'doac',
    label: 'DOAC last dose',
    answer: 'UNCERTAIN',
    state: 'contraindicated',
    consequence: 'CONTRAINDICATED unless the last dose was more than 48 hours ago.',
    actions: ['Family call', 'Override with reason'],
  },
  {
    key: 'surgery',
    label: 'Recent surgery / prior ICH',
    answer: 'no',
    state: 'ok',
    consequence: 'No exclusion.',
  },
]

/**
 * The dose. §5.4 — "paediatric doses are per-kg with the weight and its
 * capture time shown beside them"; the same discipline applies to a weight-based
 * thrombolytic in an adult, because the weight is the dose.
 */
export const THROMBOLYSIS_DOSE = {
  drug: 'Tenecteplase',
  perKg: 0.25,
  unit: 'mg/kg',
  weightKg: 78,
  weightCapturedAt: at(2, 22),
  weightSource: 'Estimated by Dr. Priya Menon — no bed scale at IPL',
  totalMg: 19.5,
  administration: 'single IV bolus over 5 seconds',
  /** "Show the independent second dose check as mandatory even when the AI is off." */
  secondCheckMandatory: true,
  secondCheckBy: null as string | null,
}

/**
 * "Draw the cost panel with 'treat now, authorize in parallel'. In India,
 * settling money is the commonest non-clinical cause of delay, and the
 * product's position on that is a stated design principle."
 */
export const THROMBOLYSIS_COST = {
  drugCost: 42000,
  pmjay: 'pending' as const,
  tpa: 'pending' as const,
  /** Display only. It does not block, and the frame says so. */
  blocking: false,
  note: 'Cost is shown so nobody is surprised. It never gates the decision.',
}

// ──────────────────────── S-18-18 · EVT selection & cath lab decision

export const EVT_CRITERIA = [
  { key: 'lvo', label: 'Confirmed LVO', answer: 'Left M1', state: 'ok' as CriterionState, consequence: 'Target vessel accessible.' },
  { key: 'aspects', label: 'ASPECTS ≥ 6', answer: '8 (human-adjusted 7)', state: 'ok' as CriterionState, consequence: 'Core not yet established.' },
  { key: 'mismatch', label: 'Target mismatch', answer: 'core 18 mL / penumbra 96 mL', state: 'ok' as CriterionState, consequence: 'Ratio 5.3 — well above the 1.8 threshold.' },
  { key: 'prestroke', label: 'Pre-stroke mRS ≤ 2', answer: '0', state: 'ok' as CriterionState, consequence: 'Independent before the event.' },
  { key: 'window', label: 'Within 6h, or 6–24h with imaging selection', answer: '1h 35m', state: 'ok' as CriterionState, consequence: 'Early window; no extended-window imaging needed.' },
  {
    key: 'access',
    label: 'Vascular access feasible',
    answer: 'UNKNOWN',
    state: 'unknown' as CriterionState,
    consequence: 'Unknown → assess on table. Tortuous arch would change the approach, not the decision.',
  },
]

/** AI-221 functional-outcome prediction, shown with its limits. */
export const EVT_OUTCOME_PREDICTION = {
  model: 'mrs90-pred v1.4.2',
  withEvt: { goodOutcome: 0.58, label: 'mRS 0–2 at 90 days' },
  withoutEvt: { goodOutcome: 0.21, label: 'mRS 0–2 at 90 days' },
  band: 'MED' as ConfidenceBand,
  confidence: 0.74,
  limits:
    'Derived from registry data with a median door-to-groin of 96 minutes. This case is tracking faster, which the model does not account for.',
}

// ───────────────── S-18-19 · Transfer, DIDO clock & single-act reservation

/**
 * DD-012 — "Single-act reservation must hold a bed, a cath lab and an
 * ambulance ATOMICALLY." This is the exception in the atlas's layer
 * dependency rule that justifies itself.
 */
export interface Reservation {
  key: string
  resource: string
  detail: string
  status: 'available' | 'held' | 'unavailable'
  heldUntil?: string
  ownerModule: string
}

export const TRANSFER_RESERVATION: Reservation[] = [
  {
    key: 'ambulance',
    resource: 'Ambulance',
    detail: 'AMB-IPL-03 · ALS-equipped · paramedic Mr Ganesh Kumar',
    status: 'available',
    ownerModule: 'M-22 Support Services',
  },
  {
    key: 'cathlab',
    resource: 'Cath lab',
    detail: 'CATH-1 at ICH · free from 03:40',
    status: 'available',
    ownerModule: 'M-11 Operation Theatre',
  },
  {
    key: 'anaesthetist',
    resource: 'Anaesthetist',
    detail: 'On-call rota · Dr. S. Iyengar, 12 min from site',
    status: 'available',
    ownerModule: 'M-23 HR & Rostering',
  },
  {
    key: 'bed',
    resource: 'Neuro-ICU bed',
    detail: 'ICU-1 · 2 of 4 stroke beds free',
    status: 'available',
    ownerModule: 'M-08 Inpatient ADT',
  },
]

export const TRANSFER_ROUTE = {
  from: `${facility('IPL').name} (IPL)`,
  to: `${facility('ICH').name} (ICH)`,
  distanceKm: 42,
  /** Pollachi to Coimbatore is a 42 km blue-light run on NH-83 — road is the
   *  credible mode, and the ETA is what the registry has seen on this pair. */
  mode: 'Road ambulance, blue-light' as const,
  etaMinutes: 48,
  aiEta: { model: 'amb-eta v3.1.0', confidence: 0.69, band: 'MED' as ConfidenceBand },
}

// ────────────────────────── S-18-01 · Network wall supporting data

export const NETWORK_SITES = [
  {
    code: 'ICH',
    name: 'Indostates Health Hospital, Coimbatore',
    role: 'hub' as const,
    ctStatus: 'free' as const,
    neurologist: 'Dr. Rohit Desai (phone)',
    strokeBeds: { free: 2, total: 4 },
    cathLab: 'free' as const,
    /** AI-816 / AI-622 readiness signals for S-18-03. */
    readiness: [] as string[],
  },
  {
    code: 'ITP',
    name: 'Indostates Tiruppur',
    role: 'secondary' as const,
    ctStatus: 'free' as const,
    neurologist: '⊘ teleneurology only',
    strokeBeds: { free: 1, total: 2 },
    cathLab: 'none' as const,
    readiness: ['2 of 6 ED staff overdue for stroke competency refresher'],
  },
  {
    code: 'IPL',
    name: 'Indostates Pollachi',
    role: 'spoke' as const,
    ctStatus: 'in use' as const,
    neurologist: '⊘ no on-site neurologist',
    strokeBeds: { free: 0, total: 1 },
    cathLab: 'none' as const,
    readiness: ['CT gantry service due in 11 days — AI-622 predicts failure risk rising'],
  },
  {
    code: 'IUD',
    name: 'Indostates Udumalpet',
    role: 'spoke' as const,
    ctStatus: 'none' as const,
    neurologist: '⊘ no on-site neurologist',
    strokeBeds: { free: 0, total: 0 },
    cathLab: 'none' as const,
    readiness: ['⊘ No CT — transfer-only site. All activations route out.'],
  },
]

export const INBOUND_AMBULANCES = [
  {
    id: 'AMB-IPL-03',
    from: 'IPL',
    to: 'ICH',
    etaMinutes: 9,
    caseId: '0141',
    /** AI-616. The GPS position remains when the model is off. */
    band: 'MED' as ConfidenceBand,
    note: 'On site at IPL. ETA is to departure, not arrival.',
  },
]

export const NETWORK_TODAY = {
  activations: 3,
  dtnMedianMin: 41,
  mimics: 1,
  transfers: 1,
}

// ─────────────────────────── S-18-07 · Parallel task board

export interface StrokeTask {
  id: string
  label: string
  owner: string
  column: 'To do' | 'In progress' | 'Blocked' | 'Done'
  dueInMin: number | null
  /** AI-619 prioritisation reason chip. */
  reason?: string
  /** A hard rule that refuses a drag, with the reason shown on the target. */
  blockedBy?: string
}

export const STROKE_TASKS: StrokeTask[] = [
  { id: 'T-01', label: 'NCCT + CTA acquired', owner: 'Radiographer, IPL', column: 'Done', dueInMin: null },
  { id: 'T-02', label: 'AI triage reviewed and confirmed', owner: 'Dr. Rohit Desai', column: 'Done', dueInMin: null },
  { id: 'T-03', label: 'NIHSS scored over video', owner: 'Dr. Rohit Desai', column: 'Done', dueInMin: null },
  {
    id: 'T-04',
    label: 'BP treated to target < 185/110',
    owner: 'Dr. Priya Menon',
    column: 'In progress',
    dueInMin: 6,
    reason: 'Blocks thrombolysis — highest-value next action',
  },
  {
    id: 'T-05',
    label: 'Consent for thrombolysis',
    owner: 'Dr. Priya Menon',
    column: 'In progress',
    dueInMin: 8,
    reason: 'Family reached by phone at 02:44',
  },
  {
    id: 'T-06',
    label: 'Tenecteplase second dose check',
    owner: 'Sr. Grace Fernandes',
    column: 'To do',
    dueInMin: 10,
    reason: 'Mandatory independent check before administration',
  },
  {
    id: 'T-07',
    label: 'Load ambulance for transfer',
    owner: 'Sr. Grace Fernandes',
    column: 'Blocked',
    dueInMin: 19,
    reason: 'DIDO projected breach in 19 min',
    blockedBy: 'Cannot load before the needle is given — drip-and-ship requires the bolus first',
  },
  {
    id: 'T-08',
    label: 'TPA pre-authorisation raised',
    owner: 'Ms Rekha Joshi',
    column: 'In progress',
    dueInMin: null,
    reason: 'Running in parallel — never on the critical path',
  },
]

// ─────────────────── S-18-08 · Timestamp reconciliation (two clocks disagree)

export const TIMESTAMP_CONFLICTS = [
  {
    event: 'Door time',
    sources: [
      { source: 'ED triage entry (IPL)', value: at(2, 14), authority: 'server' as const },
      { source: 'Ambulance handover form', value: at(2, 9), authority: 'local' as const },
      { source: 'CCTV entry log', value: at(2, 12), authority: 'device' as const },
    ],
    /** DD-012 — local times are reconciled against the server clock, never trusted. */
    resolved: at(2, 14),
    resolvedBy: 'Server-authoritative',
    consequence: 'A disputed door time is a disputed door-to-needle. The 5-minute spread changes DTN from 41 to 46.',
  },
  {
    event: 'CT start',
    sources: [
      { source: 'Modality DICOM header', value: at(2, 32), authority: 'device' as const },
      { source: 'Radiographer entry', value: at(2, 35), authority: 'local' as const },
    ],
    resolved: at(2, 32),
    resolvedBy: 'DICOM header preferred over manual entry',
    consequence: 'Door-to-CT stays inside the 25-minute target either way.',
  },
]

// ───────────────────────── S-18-09 · Team paging & acknowledgement

export const PAGING_LOG = [
  { role: 'Stroke neurologist', name: 'Dr. Rohit Desai', pagedAt: at(2, 16), ackAt: at(2, 18), channel: 'Push + call' },
  { role: 'Stroke coordinator', name: 'Sr. Grace Fernandes', pagedAt: at(2, 16), ackAt: at(2, 17), channel: 'Push' },
  { role: 'Radiographer, IPL', name: 'On duty', pagedAt: at(2, 16), ackAt: at(2, 21), channel: 'Ward phone' },
  { role: 'Neuro-interventionist', name: 'Dr. Samir Kulkarni', pagedAt: at(2, 38), ackAt: null, channel: 'Push + call' },
  { role: 'Anaesthetist on call', name: 'Dr. S. Iyengar', pagedAt: at(2, 38), ackAt: at(2, 44), channel: 'Push' },
]

// ────────────────────── S-18-10 · Telestroke request queue

export const TELESTROKE_QUEUE = [
  {
    caseId: '0141',
    patientId: 'SD-P-05',
    site: 'IPL',
    requestedAt: at(2, 20),
    lkwElapsedMin: 92,
    nihss: 14,
    aiFinding: 'LVO left M1 · HIGH',
    /** AI-613 ranking, reversible to a deterministic sort. */
    rankReason: 'LVO with 1h 35m of window remaining — highest time-value',
    band: 'HIGH' as ConfidenceBand,
    status: 'In session' as const,
  },
  {
    caseId: '0139',
    patientId: 'SD-P-09',
    site: 'ITP',
    requestedAt: at(2, 41),
    lkwElapsedMin: 310,
    nihss: 6,
    aiFinding: 'No LVO detected',
    rankReason: 'Outside the thrombolysis window; no large-vessel target',
    band: 'HIGH' as ConfidenceBand,
    status: 'Waiting' as const,
  },
]

// ─────────────────── S-18-12 · NIHSS, 15 items, scored over video

export interface NihssItem {
  key: string
  label: string
  max: number
  score: number
  /** AI-112 extracted this from the session transcript, pending a disposition. */
  aiExtracted?: boolean
  note?: string
}

/** Left M1 occlusion: right-sided weakness with aphasia. Total 14. */
export const NIHSS_ITEMS: NihssItem[] = [
  { key: '1a', label: 'Level of consciousness', max: 3, score: 1, aiExtracted: true },
  { key: '1b', label: 'LOC questions', max: 2, score: 1, aiExtracted: true },
  { key: '1c', label: 'LOC commands', max: 2, score: 0 },
  { key: '2', label: 'Best gaze', max: 2, score: 1, aiExtracted: true },
  { key: '3', label: 'Visual fields', max: 3, score: 1 },
  { key: '4', label: 'Facial palsy', max: 3, score: 1, aiExtracted: true, note: 'Right lower facial weakness' },
  { key: '5a', label: 'Motor arm — left', max: 4, score: 0 },
  { key: '5b', label: 'Motor arm — right', max: 4, score: 3, aiExtracted: true, note: 'No effort against gravity' },
  { key: '6a', label: 'Motor leg — left', max: 4, score: 0 },
  { key: '6b', label: 'Motor leg — right', max: 4, score: 2 },
  { key: '7', label: 'Limb ataxia', max: 2, score: 0, note: 'Not testable — hemiparesis' },
  { key: '8', label: 'Sensory', max: 2, score: 0 },
  { key: '9', label: 'Best language', max: 3, score: 2, aiExtracted: true, note: 'Expressive aphasia' },
  { key: '10', label: 'Dysarthria', max: 2, score: 1 },
  { key: '11', label: 'Extinction and inattention', max: 2, score: 1 },
]

export const NIHSS_TOTAL = NIHSS_ITEMS.reduce((sum, i) => sum + i.score, 0)

// ──────────────────── S-18-20 · Outcomes, mRS-90 & registry

export interface OutcomeRow {
  caseNo: string
  patientInitials: string
  site: string
  treatedWith: 'Thrombolysis' | 'Thrombectomy' | 'Both' | 'Conservative'
  dtnMin: number | null
  ditgMin: number | null
  /** modified Rankin Scale at 90 days. null where the call has not happened. */
  mrs90: number | null
  followUpStatus: 'Done' | 'Call due' | 'Unreachable — 3 attempts' | 'Window open'
  /** AI-708 outreach prioritisation. */
  outreachReason?: string
}

export const OUTCOMES: OutcomeRow[] = [
  { caseNo: 'STROKE/26-27/0118', patientInitials: 'S.R.', site: 'ICH', treatedWith: 'Both', dtnMin: 38, ditgMin: 84, mrs90: 1, followUpStatus: 'Done' },
  { caseNo: 'STROKE/26-27/0121', patientInitials: 'K.M.', site: 'ICH', treatedWith: 'Thrombolysis', dtnMin: 52, ditgMin: null, mrs90: 2, followUpStatus: 'Done' },
  {
    caseNo: 'STROKE/26-27/0126',
    patientInitials: 'B.N.',
    site: 'IPL',
    treatedWith: 'Thrombolysis',
    dtnMin: 61,
    ditgMin: null,
    mrs90: null,
    followUpStatus: 'Call due',
    outreachReason: 'Day 88 of the 90-day window — the registry award depends on this call',
  },
  {
    caseNo: 'STROKE/26-27/0131',
    patientInitials: 'A.D.',
    site: 'ITP',
    treatedWith: 'Conservative',
    dtnMin: null,
    ditgMin: null,
    mrs90: null,
    followUpStatus: 'Unreachable — 3 attempts',
    outreachReason: 'Number unobtainable. Try the attendant contact recorded at admission.',
  },
  { caseNo: 'STROKE/26-27/0137', patientInitials: 'P.G.', site: 'ICH', treatedWith: 'Thrombectomy', dtnMin: null, ditgMin: 72, mrs90: null, followUpStatus: 'Window open' },
]

export const REGISTRY_INDICATORS = [
  { label: 'Door-to-needle median', value: '41 min', target: '≤ 60 min', met: true },
  { label: 'Door-to-groin median', value: '84 min', target: '≤ 90 min', met: true },
  { label: 'DIDO median (spoke)', value: '68 min', target: '≤ 60 min', met: false },
  { label: 'Thrombolysis rate', value: '11.2%', target: '≥ 10%', met: true },
  { label: 'mRS 0–2 at 90 days', value: '54%', target: '≥ 50%', met: true },
  { label: '90-day follow-up completeness', value: '78%', target: '≥ 90%', met: false },
]

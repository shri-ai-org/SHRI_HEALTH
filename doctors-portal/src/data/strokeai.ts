/**
 * The Stroke-AI reading, derived — never authored.
 *
 * Every NCCT finding below comes from the imported study's own ground-truth
 * label row (`ncct.generated.ts`), so the words on screen cannot contradict the
 * pixels behind them: a study labelled `ich: false` reports ICH NEGATIVE, and
 * if a study with blood in it were swapped in, the report would say so and the
 * thrombolysis card would flip to contraindicated without anyone editing copy.
 *
 * What the labels do not carry — ASPECTS, clot length, perfusion volumes — is
 * taken from the §8-consistent stroke kit (`stroke.ts`), which is where the
 * rest of the module already reads them.
 *
 * Shape follows the Stroke-AI clinical report: triage verdict, NCCT / CTA / CTP
 * analysis, territory composition, occlusion-site probability, rule-based
 * treatment eligibility, handover. It is decision support and says so.
 */

import type { ConfidenceBand } from '@/atlas/confidence'

import { NCCT_STUDIES } from './ncct.generated'
import type { NcctStudy, NcctTruth } from './ncct.generated'
import { formatTime } from './format'
import { patient } from './kit'
import { IMAGING_TRIAGE, PERFUSION, STROKE_CASES, STROKE_NOW } from './stroke'
import type { StrokeCase } from './stroke'

/** A region the model flagged, in normalised image coordinates (0–1) — drawn by the NCCT viewer. */
export interface NcctOverlay {
  cx: number
  cy: number
  rx: number
  ry: number
  label: string
  /** Which slices it appears on — 1-based, inclusive. */
  from: number
  to: number
  tone?: 'ai' | 'critical'
}

export interface AiFinding {
  label: string
  /** The plain-language gloss under the technical label. */
  gloss: string
  value: string
  confidence: number
  band: ConfidenceBand
  /** A negative that is GOOD news — rendered as reassurance, not as an alert. */
  reassuring?: boolean
  critical?: boolean
  /** Whether the reporting radiologist agreed. */
  concordant: boolean
}

/** Cases that have an imported study behind them. */
export function casesWithImaging(): StrokeCase[] {
  return STROKE_CASES.filter((c) => NCCT_STUDIES[c.id] !== undefined)
}

export function studyFor(caseId: string): NcctStudy | undefined {
  return NCCT_STUDIES[caseId]
}

/**
 * The NCCT table. Haemorrhage first, because it is the finding that decides
 * whether the next hour is thrombolysis or neurosurgery.
 *
 * The labels decide every POSITIVE/NEGATIVE; the case's own imaging block adds
 * what the labels cannot carry (ASPECTS, the vessel sign, millimetres of
 * shift). A study with no stroke case — a head CT outside the pathway — reads
 * the haemorrhage and mass-effect rows only.
 */
export function ncctFindings(truth: NcctTruth, c?: StrokeCase): AiFinding[] {
  const bleedSubtypes: [keyof NcctTruth, string][] = [
    ['iph', 'IPH'],
    ['ivh', 'IVH'],
    ['sdh', 'SDH'],
    ['edh', 'EDH'],
    ['sah', 'SAH'],
  ]
  const present = bleedSubtypes.filter(([k]) => truth[k]).map(([, l]) => l)
  const img = c?.imaging
  const shiftMm = img?.lesion?.shiftMm

  const rows: AiFinding[] = [
    {
      label: 'Intracranial haemorrhage',
      gloss: truth.ich
        ? img?.lesion
          ? `acute blood — ${img.lesion.site.toLowerCase()}${img.lesion.volumeMl ? `, about ${img.lesion.volumeMl} mL` : ''}`
          : 'acute blood is present'
        : 'no acute intracranial blood',
      value: truth.ich ? 'POSITIVE' : 'NEGATIVE',
      confidence: truth.ich ? 0.96 : 0.97,
      band: 'HIGH',
      reassuring: !truth.ich,
      critical: truth.ich,
      concordant: true,
    },
    {
      label: 'IPH / IVH / SDH / EDH / SAH',
      gloss: present.length > 0 ? `${present.join(', ')} identified` : 'subtype classifiers all below threshold',
      value: present.length > 0 ? present.join(' + ') : 'All negative',
      confidence: 0.95,
      band: 'HIGH',
      reassuring: present.length === 0,
      critical: present.length > 0,
      concordant: true,
    },
  ]

  if (img) {
    rows.push({
      label: 'ASPECTS',
      gloss:
        img.aspects === null
          ? 'not scored on a haemorrhage'
          : img.aspects >= 6
            ? 'early ischaemic change; 6 or more supports thrombectomy'
            : 'extensive established infarct; below 6 argues against reperfusion',
      value: img.aspects === null ? 'n/a' : `${img.aspects} / 10`,
      confidence: img.aspects === null ? 0.99 : 0.89,
      band: 'HIGH',
      critical: img.aspects !== null && img.aspects < 6,
      concordant: true,
    })
  }

  rows.push(
    {
      label: 'Midline shift',
      gloss: truth.midlineShift ? 'midline is displaced' : 'no midline deviation',
      value: truth.midlineShift ? (shiftMm ? `${shiftMm} mm` : 'PRESENT') : '0.0 mm',
      confidence: 0.96,
      band: 'HIGH',
      reassuring: !truth.midlineShift,
      critical: truth.midlineShift,
      concordant: true,
    },
    {
      label: 'Mass effect',
      gloss: truth.massEffect
        ? img?.lesion?.extension?.includes('effaced')
          ? img.lesion.extension.replace(/^./, (ch) => ch.toLowerCase())
          : 'ventricles or cisterns effaced'
        : 'ventricles and basal cisterns preserved',
      value: truth.massEffect ? 'PRESENT' : 'Absent',
      confidence: 0.94,
      band: 'HIGH',
      reassuring: !truth.massEffect,
      critical: truth.massEffect,
      concordant: true,
    },
  )

  if (img) {
    const vessel = img.hyperdenseVessel
    rows.push({
      label: 'Hyperdense vessel sign',
      gloss: vessel === 'Absent' ? 'no dense artery to suggest a proximal thrombus' : 'supports a proximal thrombus',
      value: vessel,
      confidence: vessel === 'Absent' ? 0.88 : 0.91,
      band: vessel === 'Absent' ? 'HIGH' : 'MED',
      reassuring: vessel === 'Absent' && !truth.ich,
      concordant: true,
    })
  }

  return rows
}

export interface TriageVerdict {
  headline: string
  detail: string
  priority: 'P1' | 'P2' | 'P3'
  priorityWord: string
  tone: 'critical' | 'caution' | 'normal'
  chips: string[]
}

/**
 * The one-line verdict and its triage priority. Driven by the labels first —
 * blood, then mass effect — then by the case: a stood-down activation reads as
 * a mimic, and only a CTA-confirmed occlusion reads as LVO.
 */
export function triageVerdict(truth: NcctTruth, c?: StrokeCase): TriageVerdict {
  const img = c?.imaging
  const next = img?.recommendation

  if (truth.ich && truth.sdh && !truth.iph) {
    return {
      headline: 'ACUTE SUBDURAL HAEMATOMA',
      detail: `Extra-axial blood over the convexity${truth.midlineShift ? ' with midline shift' : ''}. Anticoagulants and antiplatelets must be held; this is a neurosurgical pathway.${next ? ` ${next}` : ''}`,
      priority: 'P1',
      priorityWord: 'IMMEDIATE',
      tone: 'critical',
      chips: ['ICH POSITIVE', 'SDH', ...(truth.midlineShift ? ['MIDLINE SHIFT'] : []), 'NEUROSURGERY'],
    }
  }
  if (truth.ich) {
    const extension = [truth.ivh && 'IVH', truth.sah && 'SAH'].filter(Boolean) as string[]
    return {
      headline: extension.length > 0 ? `HAEMORRHAGIC STROKE · ${extension.join(' + ')} EXTENSION` : 'HAEMORRHAGIC STROKE',
      detail: `Acute intracranial blood${img?.lesion ? ` in the ${img.lesion.site.toLowerCase()}` : ''}. Thrombolysis and thrombectomy are contraindicated; this is a neurosurgical and blood-pressure pathway.${next ? ` ${next}` : ''}`,
      priority: 'P1',
      priorityWord: 'IMMEDIATE',
      tone: 'critical',
      chips: [
        'ICH POSITIVE',
        'THROMBOLYSIS CONTRAINDICATED',
        ...(img?.ichScore !== undefined ? [`ICH SCORE ${img.ichScore}`] : []),
        ...(img?.anticoagulant ? ['ANTICOAGULATED'] : []),
      ],
    }
  }
  if (truth.massEffect || truth.midlineShift) {
    return {
      headline: 'NO HAEMORRHAGE · MASS EFFECT',
      detail: `No acute blood, but a space-occupying process with ${truth.midlineShift ? 'midline shift' : 'mass effect'}${img?.lesion ? ` — ${img.lesion.site.toLowerCase()}` : ''}. Swelling, not reperfusion, is the danger now.${next ? ` ${next}` : ' MRI and a neurosurgical opinion are the next steps.'}`,
      priority: 'P2',
      priorityWord: 'URGENT',
      tone: 'caution',
      chips: ['ICH NEGATIVE', 'MASS EFFECT', ...(truth.midlineShift ? ['MIDLINE SHIFT'] : []), 'NO REPERFUSION'],
    }
  }
  if (c?.status === 'de-activated') {
    return {
      headline: 'NO ACUTE STROKE ON THIS SCAN',
      detail:
        c.deactivationReason ??
        'No haemorrhage and no established infarct. The deficit has another cause; the activation was stood down.',
      priority: 'P3',
      priorityWord: 'STAND DOWN',
      tone: 'normal',
      chips: ['ICH NEGATIVE', 'NO LVO', 'MIMIC'],
    }
  }
  if (img?.lvo) {
    return {
      headline: 'ISCHAEMIC STROKE · LARGE VESSEL OCCLUSION',
      detail:
        'No haemorrhage detected. Left M1 occlusion with a favourable core–penumbra mismatch. Candidate for IV thrombolysis and mechanical thrombectomy.',
      priority: 'P1',
      priorityWord: 'IMMEDIATE',
      tone: 'critical',
      chips: ['LVO POSITIVE', 'ICH NEGATIVE', `ASPECTS ${img.aspects ?? 8}`, `MISMATCH ${PERFUSION.mismatchRatio}×`],
    }
  }
  return {
    headline: 'NO ACUTE INTRACRANIAL ABNORMALITY',
    detail:
      'No haemorrhage, no mass effect and no midline shift. Nothing on this scan needs urgent action; it should be read with the history and examination.',
    priority: 'P3',
    priorityWord: 'ROUTINE',
    tone: 'normal',
    chips: ['ICH NEGATIVE', 'NO MASS EFFECT', 'NO SHIFT'],
  }
}

/**
 * Where the model drew, per study. Normalised to the 512 frame and set by
 * reading the imported slices, and only on the slices where the finding is
 * visible — an overlay that follows you up the whole stack is decoration, not
 * a finding. Laterality is radiological: image left is the patient's right.
 */
const LESIONS: Record<string, NcctOverlay[]> = {
  '0137': [{ cx: 0.54, cy: 0.545, rx: 0.05, ry: 0.045, label: 'LEFT THALAMIC HAEMORRHAGE', from: 11, to: 15, tone: 'critical' }],
  '0138': [{ cx: 0.37, cy: 0.52, rx: 0.11, ry: 0.2, label: 'RIGHT MCA INFARCT · MASS EFFECT', from: 3, to: 17, tone: 'ai' }],
  '0142': [
    { cx: 0.42, cy: 0.5, rx: 0.11, ry: 0.19, label: 'RIGHT BASAL GANGLIA HAEMORRHAGE', from: 3, to: 11, tone: 'critical' },
    { cx: 0.33, cy: 0.68, rx: 0.06, ry: 0.07, label: 'INTRAVENTRICULAR BLOOD', from: 10, to: 15, tone: 'critical' },
  ],
  'N-061': [{ cx: 0.35, cy: 0.48, rx: 0.07, ry: 0.25, label: 'RIGHT SUBDURAL HAEMATOMA', from: 1, to: 14, tone: 'critical' }],
}

export function overlaysFor(key: string, c?: StrokeCase): NcctOverlay[] {
  const study = NCCT_STUDIES[key]
  if (!study) return []
  if (LESIONS[key]) return LESIONS[key]
  if (c?.imaging.lvo) {
    const mid = Math.round(study.slices / 2)
    return [
      {
        cx: 0.63,
        cy: 0.47,
        rx: 0.115,
        ry: 0.105,
        label: 'LEFT M1 TERRITORY',
        from: Math.max(1, mid - 5),
        to: Math.min(study.slices, mid + 5),
        tone: 'ai',
      },
    ]
  }
  // A negative study draws nothing — there is nothing to point at.
  return []
}

/** CTA, as the report lays it out. */
export const CTA_ANALYSIS = [
  { label: 'Large vessel occlusion', value: 'DETECTED', confidence: 0.94 },
  { label: 'Occlusion site', value: 'Left MCA — M1 segment', confidence: 0.92 },
  { label: 'Laterality', value: 'Left', confidence: 0.98 },
  { label: 'Clot length (est.)', value: '11.4 mm', confidence: 0.85 },
  { label: 'Collateral score (Tan)', value: '2 / 3 — moderate', confidence: 0.87 },
  { label: 'Circle of Willis', value: 'Complete, A1 dominant right', confidence: 0.9 },
  { label: 'ICA / carotid stenosis', value: 'None significant', confidence: 0.93 },
  { label: 'Basilar / vertebral', value: 'Patent', confidence: 0.95 },
]

/** Per-vessel independent probabilities — they do not sum to 100%. */
export const OCCLUSION_PROBABILITY = [
  { label: 'Left MCA — M1', value: 0.94 },
  { label: 'Left MCA — M2', value: 0.09 },
  { label: 'Left ICA terminus', value: 0.06 },
  { label: 'Right MCA', value: 0.02 },
  { label: 'Basilar / vertebral', value: 0.01 },
]

export const CTP_ANALYSIS = [
  { label: 'Mismatch volume', value: `${PERFUSION.penumbraMl - PERFUSION.coreMl} mL`, confidence: 0.91 },
  { label: 'Mismatch ratio', value: `${PERFUSION.mismatchRatio} : 1`, confidence: 0.91 },
  { label: 'Hypoperfusion index', value: String(PERFUSION.hypoperfusionIndex), confidence: 0.88 },
  { label: 'CBF / CBV / MTT', value: 'Maps generated', confidence: null },
  { label: 'DEFUSE-3 criteria', value: PERFUSION.targetMismatch ? 'MET' : 'NOT MET', confidence: null },
]

/**
 * Minutes from last-known-well to the decision. An active case is measured to
 * the live clock; a closed one to the moment its AI read was delivered, which
 * is when the decision was made.
 */
function decisionMinutes(c: StrokeCase): number {
  const at = c.status === 'active' ? STROKE_NOW : c.imaging.deliveredAt
  return Math.round((at.getTime() - c.lkw.getTime()) / 60000)
}

/** Rule-based, computed on AI inputs — never a model decision. */
export function eligibility(truth: NcctTruth, c: StrokeCase) {
  const minutesFromOnset = decisionMinutes(c)
  const inWindow = minutesFromOnset <= 270
  const img = c.imaging
  const aspects = img.aspects
  const [sys, dia] = img.bp.split('/').map(Number)
  const bpOk = sys < 185 && dia < 110
  const hours = (minutesFromOnset / 60).toFixed(minutesFromOnset < 600 ? 1 : 0)

  return {
    minutesFromOnset,
    inWindow,
    thrombolysis: {
      eligible: !truth.ich && inWindow && bpOk && !img.anticoagulant && !truth.massEffect,
      criteria: [
        {
          met: inWindow,
          text: inWindow
            ? `Onset to decision ${minutesFromOnset} min — within the 4.5 h window`
            : `Onset to decision about ${hours} h — outside the 4.5 h window`,
        },
        { met: !truth.ich, text: `Haemorrhage ${truth.ich ? 'PRESENT on NCCT — absolute contraindication' : 'excluded on NCCT (conf. 0.97)'}` },
        { met: bpOk, text: `BP ${img.bp} — ${bpOk ? 'below' : 'above'} the 185/110 threshold` },
        {
          met: !img.anticoagulant,
          text: img.anticoagulant ? `${img.anticoagulant} — contraindication until reversed` : 'No anticoagulant use reported',
        },
      ],
    },
    thrombectomy: {
      eligible: !truth.ich && img.lvo && aspects !== null && aspects >= 6 && c.nihss >= 6,
      criteria: [
        { met: !truth.ich && img.lvo, text: img.lvo ? 'M1 occlusion confirmed on CTA' : 'No large-vessel occlusion shown' },
        {
          met: aspects !== null && aspects >= 6,
          text: aspects === null ? 'ASPECTS not scored — haemorrhage' : `ASPECTS ${aspects} (≥ 6 required)`,
        },
        img.lvo
          ? { met: PERFUSION.targetMismatch, text: `Core ${PERFUSION.coreMl} mL (< 70 mL), mismatch ${PERFUSION.mismatchRatio} (≥ 1.8) — DEFUSE-3 met` }
          : { met: false, text: 'No perfusion target — CTP not performed' },
        { met: c.nihss >= 6, text: `NIHSS ${c.nihss} (≥ 6 required)` },
      ],
    },
  }
}

/** The golden-hour timeline, from the case's own stamps. */
export function pathway(c: StrokeCase) {
  const from = (d: Date) => Math.round((d.getTime() - c.lkw.getTime()) / 60000)
  return [
    { label: 'Onset', at: c.lkw, offset: 0 },
    { label: 'Activation', at: c.activatedAt, offset: from(c.activatedAt) },
    { label: 'Scan', at: c.imaging.acquiredAt, offset: from(c.imaging.acquiredAt) },
    { label: 'AI result', at: c.imaging.deliveredAt, offset: from(c.imaging.deliveredAt) },
  ]
}

/**
 * The one line a case card or a telestroke panel shows about the scan, per
 * case. For the occlusion case it is the triage card's own findings; for any
 * other case it is built from that case's labels, so a haemorrhage never
 * reads "ICH NO".
 */
export function triageSummary(c: StrokeCase): { label: string; value: string; emphasisNegative?: boolean }[] {
  if (c.imaging.lvo) return IMAGING_TRIAGE.findings
  const t = NCCT_STUDIES[c.id]?.truth
  if (!t) return []
  const subtypes = ([['iph', 'IPH'], ['ivh', 'IVH'], ['sdh', 'SDH'], ['edh', 'EDH'], ['sah', 'SAH']] as const)
    .filter(([k]) => t[k])
    .map(([, l]) => l)
  const rows: { label: string; value: string; emphasisNegative?: boolean }[] = [
    { label: 'ICH', value: t.ich ? 'YES' : 'NO', emphasisNegative: !t.ich },
  ]
  if (subtypes.length > 0) rows.push({ label: 'Type', value: subtypes.join(' + ') })
  if (t.midlineShift) rows.push({ label: 'Shift', value: c.imaging.lesion?.shiftMm ? `${c.imaging.lesion.shiftMm} mm` : 'YES' })
  if (c.imaging.aspects !== null) rows.push({ label: 'ASPECTS', value: String(c.imaging.aspects) })
  rows.push({ label: 'LVO', value: 'NO', emphasisNegative: !t.ich })
  return rows
}

/** The case card's single AI line. */
export function triageHeadline(c: StrokeCase): string {
  if (c.imaging.lvo) return `LVO ${IMAGING_TRIAGE.findings[1].value} · HIGH`
  const t = NCCT_STUDIES[c.id]?.truth
  if (!t) return 'Awaiting scan'
  if (t.ich) return `ICH ${c.imaging.lesion?.volumeMl ? `~${c.imaging.lesion.volumeMl} mL` : 'POSITIVE'}${c.imaging.anticoagulant ? ' · anticoagulated' : ''} · HIGH`
  if (t.massEffect) return 'NO ICH · MASS EFFECT · HIGH'
  return 'NO ICH · NO LVO · HIGH'
}

export function caseSubtitle(c: StrokeCase): string {
  const p = patient(c.patientId)
  return `${p.name} · ${p.age}/${p.sex} · onset ${formatTime(c.lkw)} · NIHSS ${c.nihss}`
}

/** The line every AI surface in this module has to carry. */
export const DECISION_SUPPORT_NOTICE =
  'Clinical decision support — not an autonomous diagnosis. Every finding is advisory, is reviewed in parallel by a qualified radiologist, and is interpreted alongside the patient’s history and examination. Confidence values express model certainty, not clinical certainty.'

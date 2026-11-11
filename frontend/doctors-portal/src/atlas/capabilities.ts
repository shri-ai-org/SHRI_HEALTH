/**
 * UI_ATLAS.md §4.2 — the AI capability catalogue, restricted to the 59
 * capabilities referenced by the 57 screens in this build.
 *
 * "No module owns a model, a prompt, a threshold or a training set — modules
 * own TOUCHPOINTS that compose from the fabric." (DD-008)
 *
 * Two columns from the atlas carry real behaviour here:
 *   `gate` is the MAXIMUM gate at which a capability may be used; an individual
 *   touchpoint may be stricter but never looser.
 *   `safetyFloor` marks the capabilities whose fallback says "never fully off" —
 *   a deterministic, rule-based floor remains even when the model is
 *   unavailable. This is why the prescription hard stop still fires in AI-OFF.
 */

import type { Gate } from './gates'

export type AICapabilityId = `AI-${number}`

export type AIFamily =
  | '1xx · Documentation & language'
  | '2xx · Clinical decision support'
  | '3xx · Orders, pathways & protocols'
  | '4xx · Imaging & diagnostics'
  | '5xx · Revenue, coding & claims'
  | '6xx · Operations & patient flow'
  | '7xx · Patient-facing & engagement'
  | '8xx · Quality, safety & compliance'
  | '9xx · Platform & governance'

export interface CapabilitySpec {
  id: AICapabilityId
  name: string
  family: AIFamily
  /** The maximum permitted gate. */
  gate: Gate
  /** Where a hard stop escalates to — AI-205 is G2 that becomes G4 on override. */
  escalatesTo?: Gate
  /** What the screen does when the capability is unavailable (guardrail 1). */
  fallback: string
  /**
   * The atlas marks these with a warning glyph: their failure has a
   * patient-safety consequence rather than an efficiency one, so a
   * deterministic floor survives AI-OFF.
   */
  safetyFloor?: boolean
}

const F1: AIFamily = '1xx · Documentation & language'
const F2: AIFamily = '2xx · Clinical decision support'
const F3: AIFamily = '3xx · Orders, pathways & protocols'
const F4: AIFamily = '4xx · Imaging & diagnostics'
const F5: AIFamily = '5xx · Revenue, coding & claims'
const F6: AIFamily = '6xx · Operations & patient flow'
const F7: AIFamily = '7xx · Patient-facing & engagement'
const F8: AIFamily = '8xx · Quality, safety & compliance'
const F9: AIFamily = '9xx · Platform & governance'

export const CAPABILITIES: Record<string, CapabilitySpec> = {
  // ---------------------------------------------- 1xx Documentation & language
  'AI-101': {
    id: 'AI-101',
    name: 'Ambient scribe — consultation & teleconsult',
    family: F1,
    gate: 'G2',
    fallback: 'Type or dictate manually',
  },
  'AI-102': {
    id: 'AI-102',
    name: 'Ambient scribe — ward round, handover & intra-op',
    family: F1,
    gate: 'G2',
    fallback: 'Type manually',
  },
  'AI-103': {
    id: 'AI-103',
    name: 'Note section draft from chart context',
    family: F1,
    gate: 'G2',
    fallback: 'Blank section with a prompt',
  },
  'AI-104': {
    id: 'AI-104',
    name: 'Dictation cleanup, punctuation & formatting',
    family: F1,
    gate: 'G2',
    fallback: 'Raw transcript retained verbatim',
  },
  'AI-105': {
    id: 'AI-105',
    name: 'Chart summarisation — "catch me up"',
    family: F1,
    gate: 'G1',
    fallback: 'Chronological record, unsummarised',
  },
  'AI-106': {
    id: 'AI-106',
    name: 'Discharge summary draft',
    family: F1,
    gate: 'G3',
    fallback: 'Structured template, manually completed',
  },
  'AI-109': {
    id: 'AI-109',
    name: 'Lab report narrative & interpretation draft',
    family: F1,
    gate: 'G3',
    fallback: 'Numeric results with reference ranges only',
  },
  'AI-110': {
    id: 'AI-110',
    name: 'Translation & name transliteration (22 languages)',
    family: F1,
    gate: 'G2',
    fallback: 'English only, with a stated limitation',
  },
  'AI-111': {
    id: 'AI-111',
    name: 'Patient-friendly instruction rewrite',
    family: F1,
    gate: 'G2',
    fallback: "Clinician's own wording",
  },
  'AI-112': {
    id: 'AI-112',
    name: 'Structured extraction from free text',
    family: F1,
    gate: 'G2',
    fallback: 'Manual structured entry',
  },
  'AI-114': {
    id: 'AI-114',
    name: 'Banned-abbreviation & documentation-quality check',
    family: F1,
    gate: 'G1',
    fallback: 'Periodic retrospective audit',
  },

  // ------------------------------------------- 2xx Clinical decision support
  'AI-201': {
    id: 'AI-201',
    name: 'Deterioration risk (NEWS2+)',
    family: F2,
    gate: 'G1',
    fallback: 'Manual NEWS2 from charted vitals',
  },
  'AI-203': {
    id: 'AI-203',
    name: 'Differential diagnosis suggestion',
    family: F2,
    gate: 'G1',
    fallback: "Clinician's own differential",
  },
  'AI-204': {
    id: 'AI-204',
    name: 'Diagnosis–evidence consistency check',
    family: F2,
    gate: 'G1',
    fallback: 'Coder review downstream',
  },
  'AI-205': {
    id: 'AI-205',
    name: 'Drug interaction, allergy & contraindication check',
    family: F2,
    gate: 'G2',
    escalatesTo: 'G4',
    fallback: 'Static interaction tables — never fully off',
    safetyFloor: true,
  },
  'AI-206': {
    id: 'AI-206',
    name: 'Renal & hepatic dose adjustment',
    family: F2,
    gate: 'G2',
    fallback: 'Printed dosing reference',
  },
  'AI-209': {
    id: 'AI-209',
    name: 'Time-critical pathway detection (stroke, STEMI, sepsis, trauma)',
    family: F2,
    gate: 'G1',
    fallback: 'Manual activation button, always present',
    safetyFloor: true,
  },
  'AI-211': {
    id: 'AI-211',
    name: 'Fall, pressure-ulcer & VTE risk',
    family: F2,
    gate: 'G1',
    fallback: 'Manual assessment scales',
  },
  'AI-212': {
    id: 'AI-212',
    name: 'Result interpretation & delta check',
    family: F2,
    gate: 'G1',
    fallback: 'Reference ranges and prior value shown',
  },
  'AI-213': {
    id: 'AI-213',
    name: 'Critical-value detection & escalation',
    family: F2,
    gate: 'G2',
    fallback: 'Rule-based thresholds — never fully off',
    safetyFloor: true,
  },
  'AI-221': {
    id: 'AI-221',
    name: 'Functional-outcome prediction (mRS, Barthel)',
    family: F2,
    gate: 'G1',
    fallback: 'Observed scale only, no prediction',
  },

  // ---------------------------------- 3xx Orders, pathways & protocols
  'AI-301': {
    id: 'AI-301',
    name: 'Order suggestion from clinical context',
    family: F3,
    gate: 'G2',
    fallback: 'Manual order search',
  },
  'AI-302': {
    id: 'AI-302',
    name: 'Order-set & pathway recommendation',
    family: F3,
    gate: 'G2',
    fallback: 'Browse order-set library',
  },
  'AI-303': {
    id: 'AI-303',
    name: 'Pathway & protocol adherence monitoring',
    family: F3,
    gate: 'G1',
    fallback: 'Manual checklist',
  },
  'AI-304': {
    id: 'AI-304',
    name: 'Duplicate & low-value test detection',
    family: F3,
    gate: 'G2',
    fallback: 'Retrospective stewardship review',
  },
  'AI-305': {
    id: 'AI-305',
    name: 'Prescription completeness & dose-range check',
    family: F3,
    gate: 'G2',
    fallback: 'Static dose-range tables — never fully off',
    safetyFloor: true,
  },
  'AI-306': {
    id: 'AI-306',
    name: 'Medication reconciliation matching',
    family: F3,
    gate: 'G2',
    fallback: 'Manual side-by-side comparison',
  },
  'AI-308': {
    id: 'AI-308',
    name: 'Order status & closed-loop chasing',
    family: F3,
    gate: 'G1',
    fallback: 'Manual order status list',
  },
  'AI-310': {
    id: 'AI-310',
    name: 'Tele-prescription category gate (Telemedicine Guidelines 2020)',
    family: F3,
    gate: 'G2',
    fallback: 'Hard-coded prohibited list — never off',
    safetyFloor: true,
  },

  // --------------------------------------------- 4xx Imaging & diagnostics
  'AI-402': {
    id: 'AI-402',
    name: 'Chest X-ray triage',
    family: F4,
    gate: 'G3',
    fallback: 'Standard reporting queue',
  },
  'AI-403': {
    id: 'AI-403',
    name: 'Intracranial haemorrhage detection',
    family: F4,
    gate: 'G3',
    fallback: 'Radiologist read, unprioritised',
    safetyFloor: true,
  },
  'AI-404': {
    id: 'AI-404',
    name: 'Large-vessel-occlusion detection',
    family: F4,
    gate: 'G3',
    fallback: 'Radiologist / neurologist read',
    safetyFloor: true,
  },
  'AI-405': {
    id: 'AI-405',
    name: 'ASPECTS auto-scoring',
    family: F4,
    gate: 'G2',
    fallback: 'Manual region-by-region scoring',
  },
  'AI-406': {
    id: 'AI-406',
    name: 'Perfusion core & penumbra quantification',
    family: F4,
    gate: 'G2',
    fallback: 'Vendor perfusion maps, read manually',
  },
  'AI-407': {
    id: 'AI-407',
    name: 'Critical-finding detection & escalation',
    family: F4,
    gate: 'G2',
    fallback: 'Radiologist-initiated escalation call',
    safetyFloor: true,
  },
  'AI-408': {
    id: 'AI-408',
    name: 'Prior-study comparison & change detection',
    family: F4,
    gate: 'G1',
    fallback: 'Manual side-by-side',
  },

  // ------------------------------------------- 5xx Revenue, coding & claims
  'AI-501': {
    id: 'AI-501',
    name: 'Diagnosis & procedure code assist (ICD-10, ICD-11, SNOMED)',
    family: F5,
    gate: 'G2',
    fallback: 'Manual code search',
  },
  'AI-514': {
    id: 'AI-514',
    name: 'Discharge financial clearance readiness',
    family: F5,
    gate: 'G1',
    fallback: 'Manual clearance checklist',
  },

  // ---------------------------------------- 6xx Operations & patient flow
  'AI-601': {
    id: 'AI-601',
    name: 'Front-office queue & load forecast',
    family: F6,
    gate: 'G0',
    fallback: 'Live counts only',
  },
  'AI-607': {
    id: 'AI-607',
    name: 'OP queue wait-time prediction',
    family: F6,
    gate: 'G0',
    fallback: 'Position in queue only',
  },
  'AI-608': {
    id: 'AI-608',
    name: 'Clinician capacity & template optimisation',
    family: F6,
    gate: 'G1',
    fallback: 'Manual template editing',
  },
  'AI-609': {
    id: 'AI-609',
    name: 'Referral triage & routing',
    family: F6,
    gate: 'G2',
    fallback: 'Manual triage',
  },
  'AI-610': {
    id: 'AI-610',
    name: 'Discharge-today prediction',
    family: F6,
    gate: 'G1',
    fallback: 'Clinician-flagged discharges only',
  },
  'AI-611': {
    id: 'AI-611',
    name: 'Bed allocation optimisation',
    family: F6,
    gate: 'G2',
    fallback: 'Ward-then-bed-number order; hard rules always deterministic',
    safetyFloor: true,
  },
  'AI-612': {
    id: 'AI-612',
    name: 'Census & occupancy forecast',
    family: F6,
    gate: 'G1',
    fallback: 'Current census only',
  },
  'AI-613': {
    id: 'AI-613',
    name: 'Clinician worklist prioritisation',
    family: F6,
    gate: 'G0',
    fallback: 'Chronological, with manual pinning',
  },
  'AI-616': {
    id: 'AI-616',
    name: 'Ambulance ETA & inbound forecast',
    family: F6,
    gate: 'G1',
    fallback: 'GPS position only',
  },
  'AI-617': {
    id: 'AI-617',
    name: 'OT & resource schedule optimisation, case-duration prediction',
    family: F6,
    gate: 'G2',
    fallback: 'Booked duration as stated by the surgeon',
  },
  'AI-619': {
    id: 'AI-619',
    name: 'Task prioritisation & workload balancing',
    family: F6,
    gate: 'G1',
    fallback: 'Due-time order',
  },
  'AI-622': {
    id: 'AI-622',
    name: 'Equipment failure prediction',
    family: F6,
    gate: 'G1',
    fallback: 'Scheduled preventive maintenance',
  },
  'AI-623': {
    id: 'AI-623',
    name: 'Roster optimisation & coverage-gap detection',
    family: F6,
    gate: 'G2',
    fallback: 'Manual roster, manual gap check',
  },

  // ------------------------------------------------------- 7xx Patient-facing
  'AI-708': {
    id: 'AI-708',
    name: 'Post-discharge outreach & check-in',
    family: F7,
    gate: 'G1',
    fallback: 'Scheduled call list',
  },

  // -------------------------------------- 8xx Quality, safety & compliance
  'AI-802': {
    id: 'AI-802',
    name: 'Indicator computation & trend alerting',
    family: F8,
    gate: 'G1',
    fallback: 'Manual monthly computation',
  },
  'AI-810': {
    id: 'AI-810',
    name: 'Medico-legal documentation completeness',
    family: F8,
    gate: 'G1',
    fallback: 'Manual MLC checklist',
  },
  'AI-815': {
    id: 'AI-815',
    name: 'ADR signal detection (PvPI)',
    family: F8,
    gate: 'G1',
    fallback: 'Clinician-initiated reporting',
  },
  'AI-816': {
    id: 'AI-816',
    name: 'Training & competency gap detection',
    family: F8,
    gate: 'G1',
    fallback: 'Manual training matrix',
  },

  // ------------------------------------------- 9xx Platform & governance
  'AI-901': {
    id: 'AI-901',
    name: 'Natural-language record & cohort search',
    family: F9,
    gate: 'G1',
    fallback: 'Structured filters',
  },
  'AI-902': {
    id: 'AI-902',
    name: 'Natural-language analytics',
    family: F9,
    gate: 'G1',
    fallback: 'Pre-built reports',
  },
  'AI-908': {
    id: 'AI-908',
    name: 'Access-pattern anomaly & break-glass review assist',
    family: F9,
    gate: 'G1',
    fallback: 'Manual log review',
  },
  /**
   * The one capability present on EVERY screen, because GP-17 is a global
   * pattern rather than a per-screen feature. Its explainability is stronger
   * than the catalogue default: mandatory AND cited, and an uncited answer is
   * not rendered at all.
   */
  'AI-911': {
    id: 'AI-911',
    name: 'Contextual RAG help & documentation assistant',
    family: F9,
    gate: 'G1',
    fallback: 'Static help centre and support contact — never removed',
    safetyFloor: true,
  },
}

export function capability(id: string): CapabilitySpec {
  const spec = CAPABILITIES[id]
  if (!spec) throw new Error(`Unknown AI capability ${id} — every touchpoint must exist in §4.2`)
  return spec
}

/** The capability every screen carries. */
export const GLOBAL_ASSISTANT: AICapabilityId = 'AI-911'

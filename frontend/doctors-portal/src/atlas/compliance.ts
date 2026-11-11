/**
 * UI_ATLAS.md §7 — India-first & compliance overlay, restricted to the
 * obligations the 57 screens in this build carry.
 *
 * These are not decoration. Several of them are the reason a screen behaves the
 * way it does — CMP-NABH-10 is why there is a LOCKED state and an Addendum
 * action on every authoring screen, and CMP-NABH-11 is why the attestation
 * block is stamped on sign rather than typed.
 */

export type ComplianceId = string

export interface ComplianceSpec {
  id: ComplianceId
  obligation: string
  /** What it forces in the UI. */
  consequence: string
  /** Marked with a warning glyph in the atlas: safety- or legally-critical. */
  critical?: boolean
}

export const COMPLIANCE: Record<ComplianceId, ComplianceSpec> = {
  'CMP-NABH-01': {
    id: 'CMP-NABH-01',
    obligation: 'Initial assessment within 24h of admission',
    consequence: 'A countdown on the admission assessment, and an overdue flag on the worklist.',
  },
  'CMP-NABH-03': {
    id: 'CMP-NABH-03',
    obligation: 'Care plan documented and countersigned',
    consequence: 'The `Co-sign pending` state and the consultant co-sign queue.',
  },
  'CMP-NABH-05': {
    id: 'CMP-NABH-05',
    obligation: 'Medication orders legible, complete, no banned abbreviations',
    consequence: 'AI-114 runs on blur; banned abbreviations are rejected, not warned about.',
  },
  'CMP-NABH-06': {
    id: 'CMP-NABH-06',
    obligation: 'High-risk medication double-check',
    consequence: 'A second-person check before a high-risk drug is committed.',
    critical: true,
  },
  'CMP-NABH-10': {
    id: 'CMP-NABH-10',
    obligation: 'A signed record is never edited — only amended',
    consequence:
      'LOCKED plus an Addendum action on every authoring screen, and `amend` is a separate capability from `write`.',
    critical: true,
  },
  'CMP-NABH-11': {
    id: 'CMP-NABH-11',
    obligation: 'Every clinical entry carries author identity, registration number, date and time',
    consequence: 'An attestation block, stamped on sign — never typed.',
  },
  'CMP-ABDM-03': {
    id: 'CMP-ABDM-03',
    obligation: 'HIP publish of 5 record types — OPConsultation, DiagnosticReport, Prescription, DischargeSummary, ImmunizationRecord',
    consequence: 'Per-record publish status on the signed note; a failure never blocks the clinical record.',
  },
  'CMP-ABDM-04': {
    id: 'CMP-ABDM-04',
    obligation: 'Publish failures must be visible and retryable',
    consequence: 'A publish-failure chip with a retry, not a silent drop.',
  },
  'CMP-ABDM-07': {
    id: 'CMP-ABDM-07',
    obligation: 'HPR ID on every clinician; HFR ID per facility',
    consequence: 'The HPR number is printed on every prescription and in every attestation block.',
  },
  'CMP-DPDP-01': {
    id: 'CMP-DPDP-01',
    obligation: 'Purpose registry and lawful basis per processing purpose',
    consequence: 'Assistant queries are a named processing purpose.',
  },
  'CMP-DPDP-02': {
    id: 'CMP-DPDP-02',
    obligation: "Consent notice and patient-facing content in the patient's language",
    consequence: 'Bilingual print for instructions, prescriptions, summaries and consent.',
  },
  'CMP-DRUG-03': {
    id: 'CMP-DRUG-03',
    obligation: 'DPCO ceiling and NLEM flags',
    consequence: 'A substitution prompt at prescribing when an NLEM equivalent exists.',
  },
  'CMP-DRUG-04': {
    id: 'CMP-DRUG-04',
    obligation: 'ADR reporting',
    consequence: 'A PvPI reporting form reachable from the prescription and the chart.',
  },
  'CMP-DRUG-06': {
    id: 'CMP-DRUG-06',
    obligation: 'Teleconsult prescribing categories (O / A / B) and prohibited list',
    consequence: 'A hard category gate on tele-prescription; the prohibited list is never AI-decided.',
    critical: true,
  },
  'CMP-STAT-01': {
    id: 'CMP-STAT-01',
    obligation: 'MLC, police intimation with acknowledgement, wound certificate',
    consequence: 'An MLC flag in the patient banner and a docket with an acknowledgement record.',
    critical: true,
  },
  'CMP-STAT-03': {
    id: 'CMP-STAT-03',
    obligation: 'Birth & death registration (CRS), MCCD Form 4 / 4A',
    consequence: 'The MCCD cause-of-death sequence, in the statutory order.',
    critical: true,
  },
  'CMP-DIAG-05': {
    id: 'CMP-DIAG-05',
    obligation: 'HIV Act 2017 — consent before test, restricted result visibility',
    consequence: 'Restricted result visibility; the refusal is uniform and reveals nothing.',
    critical: true,
  },
}

export function compliance(id: ComplianceId): ComplianceSpec | undefined {
  return COMPLIANCE[id]
}

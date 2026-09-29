/**
 * UI_ATLAS.md §4.6 — dispositions. FROZEN, closed set of 5.
 * "No module invents a sixth."
 *
 * Each disposition has exactly one control in C-41, the most-reused component
 * in the product.
 */

export const DISPOSITIONS = [
  'Accepted',
  'Accepted with edits',
  'Rejected',
  'Deferred',
  'Overridden',
] as const
export type Disposition = (typeof DISPOSITIONS)[number]

export interface DispositionSpec {
  value: Disposition
  means: string
  reasonRequired: boolean
  /** Overridden is reachable only through a G4 dual-signature gate. */
  g4Only?: boolean
}

export const DISPOSITION_SPECS: Record<Disposition, DispositionSpec> = {
  Accepted: { value: 'Accepted', means: 'Taken as offered', reasonRequired: false },
  'Accepted with edits': {
    value: 'Accepted with edits',
    means: 'Taken and modified; the diff is retained',
    reasonRequired: false,
  },
  Rejected: { value: 'Rejected', means: 'Discarded', reasonRequired: true },
  Deferred: {
    value: 'Deferred',
    means: 'Left undecided; the item persists in a queue',
    reasonRequired: false,
  },
  Overridden: {
    value: 'Overridden',
    means: 'Proceeded past a hard stop',
    reasonRequired: true,
    g4Only: true,
  },
}

/**
 * §4.6 / §8.5 — the fixed rejection reason list. Five values plus free text;
 * the dialog offers these and nothing else.
 */
export const REJECTION_REASONS = [
  'Clinically incorrect',
  'Not relevant to this patient',
  'Already documented',
  'Insufficient information',
  'Other',
] as const
export type RejectionReason = (typeof REJECTION_REASONS)[number]

/** A recorded disposition. §4.9 requires one before any G2+ output persists. */
export interface DispositionRecord {
  touchpointId: string
  disposition: Disposition
  reason?: RejectionReason
  reasonText?: string
  /** Set on Overridden — the G4 co-signer's identity. */
  coSigner?: string
  /** Retained on "Accepted with edits". */
  diff?: { before: string; after: string }
  at: string
  by: string
  modelVersion: string
  confidence: string
}

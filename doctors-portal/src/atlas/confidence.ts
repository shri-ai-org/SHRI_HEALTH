/**
 * UI_ATLAS.md §4.5 — confidence bands. FROZEN, closed set of 3.
 *
 * "Never a bare number." A percentage may accompany the band label but never
 * replace it. A capability that cannot produce a calibrated score shows
 * AI-ABSTAIN, not LOW.
 */

export const CONFIDENCE_BANDS = ['HIGH', 'MED', 'LOW'] as const
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number]

export interface BandSpec {
  band: ConfidenceBand
  /** Inclusive lower bound. */
  min: number
  label: string
  /** The mandated dot treatment (§4.5). */
  dot: 'solid-indigo' | 'half-amber' | 'hollow-amber'
  /** How the suggestion arrives. */
  delivery: 'may-pre-expand' | 'expanded-no-preselect' | 'collapsed-blocked'
}

export const BAND_SPECS: Record<ConfidenceBand, BandSpec> = {
  HIGH: {
    band: 'HIGH',
    min: 0.85,
    label: 'High confidence',
    dot: 'solid-indigo',
    delivery: 'may-pre-expand',
  },
  MED: {
    band: 'MED',
    min: 0.6,
    label: 'Moderate confidence',
    dot: 'half-amber',
    delivery: 'expanded-no-preselect',
  },
  LOW: {
    band: 'LOW',
    min: 0,
    label: 'Low confidence — review closely',
    dot: 'hollow-amber',
    // "Delivered collapsed; acceptance blocked until expanded."
    delivery: 'collapsed-blocked',
  },
}

export function bandFor(score: number): ConfidenceBand {
  if (score >= BAND_SPECS.HIGH.min) return 'HIGH'
  if (score >= BAND_SPECS.MED.min) return 'MED'
  return 'LOW'
}

/**
 * The rule that makes AI-LOW real rather than cosmetic: a LOW suggestion
 * cannot be accepted while it is still collapsed.
 */
export function acceptanceBlocked(band: ConfidenceBand, expanded: boolean): boolean {
  return band === 'LOW' && !expanded
}

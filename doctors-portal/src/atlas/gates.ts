/**
 * UI_ATLAS.md §4.4 — the HITL gate ladder. FROZEN, closed set of 5 (+1 forbidden).
 *
 * The binding one-liner: "no G2-or-above AI output is persisted without a
 * recorded disposition."
 *
 * Exactly one gate per touchpoint. This is what makes 143 AI capabilities
 * coherent instead of 27 modules each inventing their own AI idea.
 */

export const GATES = ['G0', 'G1', 'G2', 'G3', 'G4'] as const
export type Gate = (typeof GATES)[number]

/**
 * T5 — autonomous AND irreversible — is named and forbidden product-wide.
 * "the top autonomy tier is named and forbidden product-wide, which is
 * precisely what makes the five permitted tiers credible to a clinical
 * governance committee." (§2.3)
 *
 * It is modelled as a type with no values so it cannot be constructed.
 */
export type ForbiddenTier = 'T5' & { readonly __forbidden: unique symbol }

export interface GateSpec {
  gate: Gate
  name: string
  /** What the human must do. */
  human: string
  /** The fixed UI treatment — not negotiable per module. */
  treatment: string
  permittedFor: string
}

export const GATE_SPECS: Record<Gate, GateSpec> = {
  G0: {
    gate: 'G0',
    name: 'Ambient',
    human: 'Nothing',
    treatment: 'Disclosure only — a "Sorted by AI" label or a catalogue entry. Never a dialog.',
    permittedFor: 'Non-clinical ranking, search, cosmetics',
  },
  G1: {
    gate: 'G1',
    name: 'Suggest',
    human: 'Notice; may ignore',
    treatment: 'AIP-05 / AIP-06; dismissible; optional "not useful" plus a reason.',
    permittedFor: 'Risk scores, nudges, forecasts',
  },
  G2: {
    gate: 'G2',
    name: 'Confirm',
    human: 'Accept / Edit / Reject before the value is committed',
    treatment:
      'C-41 action bar. The page’s primary action stays disabled until every G2 item has a disposition.',
    permittedFor: 'Drafts, codes, order suggestions, allocations',
  },
  G3: {
    gate: 'G3',
    name: 'Attest',
    human: 'Accept and sign, with identity and timestamp recorded',
    treatment:
      'C-41 plus a signature block and a fixed-wording "I have reviewed this content" checkbox.',
    permittedFor: 'Anything entering the legal medical record or a claim',
  },
  G4: {
    gate: 'G4',
    name: 'Dual',
    human: 'A second qualified user must co-sign',
    treatment:
      'C-31 modal plus second-user authentication; reason mandatory; both identities recorded.',
    permittedFor: 'Overrides of hard stops, high-risk dosing, AI-initiated escalation',
  },
}

/** G0 touchpoints show no confidence at all (§4.5). */
export function gateShowsConfidence(gate: Gate): boolean {
  return gate !== 'G0'
}

/** G2 and above require a recorded disposition before the value is persisted. */
export function gateRequiresDisposition(gate: Gate): boolean {
  return gate === 'G2' || gate === 'G3' || gate === 'G4'
}

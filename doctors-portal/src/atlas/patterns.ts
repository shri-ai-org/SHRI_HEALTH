/**
 * UI_ATLAS.md §4.3 — AI affordance patterns. FROZEN, 10 allocated (10 reserved).
 *
 * "One interaction language. A clinician who learns how to accept an AI
 * suggestion in the outpatient note already knows how to accept one in the bed
 * board, the coding queue and the stroke console. Consistency is a
 * clinical-safety property, not a cosmetic one." (§2.3)
 */

export const AI_PATTERNS = [
  'AIP-01',
  'AIP-02',
  'AIP-03',
  'AIP-04',
  'AIP-05',
  'AIP-06',
  'AIP-07',
  'AIP-08',
  'AIP-09',
  'AIP-10',
] as const
export type AIPattern = (typeof AI_PATTERNS)[number]

export interface PatternSpec {
  id: AIPattern
  name: string
  useWhen: string
  /** How it renders — verbatim intent from §4.3. */
  drawnAs: string
}

export const PATTERN_SPECS: Record<AIPattern, PatternSpec> = {
  'AIP-01': {
    id: 'AIP-01',
    name: 'Inline ghost content',
    useWhen: 'AI drafts text the user will own',
    drawnAs:
      '85% opacity, left accent rule in AI-indigo, C-41 action bar beneath. Ghost text sits IN the field, not in a side card.',
  },
  'AIP-02': {
    id: 'AIP-02',
    name: 'Inline field chip',
    useWhen: 'AI fills one structured value',
    drawnAs: 'Chip inside the field: ◆ plus a confidence dot plus accept/reject.',
  },
  'AIP-03': {
    id: 'AIP-03',
    name: 'Suggestion card',
    useWhen: 'Discrete, rankable proposals',
    drawnAs: 'Z6 card, evidence line, per-card accept / edit / dismiss.',
  },
  'AIP-04': {
    id: 'AIP-04',
    name: 'Side panel',
    useWhen: 'Conversational or exploratory AI',
    drawnAs:
      'Z6 320px panel, C-40. §6.1 overrides this for the Z7b assistant: a 420px C-32 drawer in Z8.',
  },
  'AIP-05': {
    id: 'AIP-05',
    name: 'Banner / strip',
    useWhen: 'Something the user must notice now',
    drawnAs: 'Z3 or Z4 full-width strip, severity-coloured, with a Why? link.',
  },
  'AIP-06': {
    id: 'AIP-06',
    name: 'List / row badge',
    useWhen: 'Per-record score in a collection',
    drawnAs: 'Badge plus band dot, sortable, tooltip on hover AND focus.',
  },
  'AIP-07': {
    id: 'AIP-07',
    name: 'Ranked or reordered list',
    useWhen: 'AI changes order, not content',
    drawnAs:
      '"Sorted by AI acuity ▾" header control plus a per-row reason chip. Always reversible to a deterministic sort.',
  },
  'AIP-08': {
    id: 'AIP-08',
    name: 'Explainability drawer',
    useWhen: 'Invoked from any of the above',
    drawnAs: 'C-42, right drawer 480px, four fixed panels (§4.7).',
  },
  'AIP-09': {
    id: 'AIP-09',
    name: 'Modal gate',
    useWhen: 'AI output must be resolved before proceeding',
    drawnAs: 'C-31 modal, not dismissible without a disposition.',
  },
  'AIP-10': {
    id: 'AIP-10',
    name: 'Ambient / invisible',
    useWhen: 'AI improves a result with no surface',
    drawnAs: 'No visual. Disclosed only in the capability catalogue and on the AI governance screen.',
  },
}

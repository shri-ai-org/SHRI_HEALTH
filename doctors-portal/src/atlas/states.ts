/**
 * UI_ATLAS.md §1.5 — Screen state codes. FROZEN, closed set of 14.
 *
 * "Every screen specification carries a state table with a row for each. A
 * screen may state a code `n/a` — but only with a reason."
 *
 * A screen may declare a state n/a with a stated reason; it may not invent a
 * fifteenth (§0.4 conventions freeze).
 */

export const SCREEN_STATES = [
  'DEFAULT',
  'LOADING',
  'EMPTY',
  'PARTIAL',
  'ERROR',
  'VALIDATION',
  'DENIED',
  'BREAKGLASS',
  'OFFLINE',
  'STALE',
  'SAVING',
  'LOCKED',
  'AI-OFF',
  'AI-ABSTAIN',
  'AI-LOW',
] as const

export type ScreenState = (typeof SCREEN_STATES)[number]

/** The 14 frozen codes, excluding the implicit DEFAULT render. */
export type DeclaredState = Exclude<ScreenState, 'DEFAULT'>

export interface StateSpec {
  code: DeclaredState
  /** What triggers it. */
  trigger: string
  /** What to draw — verbatim intent from §1.5. */
  draw: string
  /** Which of the three families it belongs to, for grouping in the switcher. */
  family: 'data' | 'authorization' | 'connectivity' | 'ai'
}

export const STATE_SPECS: Record<DeclaredState, StateSpec> = {
  LOADING: {
    code: 'LOADING',
    trigger: 'first paint, data in flight',
    draw: 'Skeleton geometry that matches the loaded layout — never a spinner on a blank page.',
    family: 'data',
  },
  EMPTY: {
    code: 'EMPTY',
    trigger: 'no data, legitimately',
    draw: 'Explain why it is empty and what would change that. Never a bare "No records".',
    family: 'data',
  },
  PARTIAL: {
    code: 'PARTIAL',
    trigger: 'some regions loaded, one failed',
    draw: 'The screen stays usable; the failed region names what is missing and since when.',
    family: 'data',
  },
  ERROR: {
    code: 'ERROR',
    trigger: 'the operation failed',
    draw: 'Recoverable, with the user’s input preserved, a retry and an escape hatch.',
    family: 'data',
  },
  VALIDATION: {
    code: 'VALIDATION',
    trigger: 'user submitted with gaps',
    draw:
      'Count of problems, inline errors, focus moved to the first, primary action stays disabled.',
    family: 'data',
  },
  DENIED: {
    code: 'DENIED',
    trigger: 'caller lacks the capability',
    draw:
      'C-36 panel — what is missing, who grants it, a request action. And no patient data anywhere on screen.',
    family: 'authorization',
  },
  BREAKGLASS: {
    code: 'BREAKGLASS',
    trigger: 'has the capability, lacks the relationship',
    draw:
      'GP-10 amber full-width banner, reason required before content renders, "this access is logged and reviewed".',
    family: 'authorization',
  },
  LOCKED: {
    code: 'LOCKED',
    trigger: 'record signed, or held by another user',
    draw:
      'Read-only render naming who holds it and since when, plus the legitimate next action (Addendum, refresh).',
    family: 'authorization',
  },
  OFFLINE: {
    code: 'OFFLINE',
    trigger: 'network unavailable',
    draw:
      'C-37 strip — what still works, what is queued, what is blocked. Typed content is never lost.',
    family: 'connectivity',
  },
  STALE: {
    code: 'STALE',
    trigger: 'cached data past its freshness budget',
    draw: 'Timestamp turns amber, "Data as of HH:MM · Refresh".',
    family: 'connectivity',
  },
  SAVING: {
    code: 'SAVING',
    trigger: 'write in flight',
    draw: 'Primary action disabled with a spinner; content is not locked.',
    family: 'connectivity',
  },
  'AI-OFF': {
    code: 'AI-OFF',
    trigger: 'AI service down, or disabled for this tenant',
    draw:
      'Every ◆ affordance hidden entirely, not greyed. The Z7b bubble is unmounted. One quiet line. The screen stays fully usable.',
    family: 'ai',
  },
  'AI-ABSTAIN': {
    code: 'AI-ABSTAIN',
    trigger: 'AI cannot produce a calibrated answer',
    draw:
      'States what is missing and the action that would fix it. Never a null score, a zero, or a blank band.',
    family: 'ai',
  },
  'AI-LOW': {
    code: 'AI-LOW',
    trigger: 'confidence band is LOW',
    draw: 'Delivered collapsed with an amber band; acceptance blocked until expanded.',
    family: 'ai',
  },
}

export const DECLARED_STATES = Object.keys(STATE_SPECS) as DeclaredState[]

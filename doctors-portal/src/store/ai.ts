/**
 * The AI fabric's runtime state: the kill switch, recorded dispositions, and
 * the forced-state control that makes the 14 screen states walkable.
 *
 * §4.8 gives the fabric a global kill switch, and §1.5 says what AI-OFF must
 * look like: "every ◆ affordance HIDDEN ENTIRELY, NOT GREYED; one quiet line;
 * the screen fully usable." The bubble unmounts. Static help remains.
 *
 * The one thing that survives the kill switch is the deterministic safety
 * floor — the capabilities whose §4.2 fallback reads "never fully off".
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { capability } from '@/atlas/capabilities'
import type { ConfidenceBand } from '@/atlas/confidence'
import type { Disposition, DispositionRecord, RejectionReason } from '@/atlas/dispositions'
import type { DeclaredState } from '@/atlas/states'

export interface AIState {
  /** The §4.8 kill switch. false ⇒ every ◆ hidden and the Z7b bubble unmounted. */
  aiEnabled: boolean
  /**
   * A state forced on the current screen, for walking the 14 states.
   * null means render normally.
   */
  forcedState: DeclaredState | null
  /** Dispositions recorded this session, keyed by touchpoint id. */
  dispositions: Record<string, DispositionRecord>
  /** Touchpoints the user has expanded — LOW cannot be accepted while collapsed. */
  expanded: Record<string, boolean>

  setAiEnabled: (v: boolean) => void
  toggleAi: () => void
  forceState: (s: DeclaredState | null) => void
  expand: (id: string, v?: boolean) => void
  record: (args: {
    touchpointId: string
    disposition: Disposition
    by: string
    modelVersion: string
    confidence: ConfidenceBand
    reason?: RejectionReason
    reasonText?: string
    coSigner?: string
    diff?: { before: string; after: string }
  }) => void
  clearDisposition: (touchpointId: string) => void
  resetAll: () => void
}

export const useAI = create<AIState>()(
  persist(
    (set, get) => ({
  aiEnabled: true,
  forcedState: null,
  dispositions: {},
  expanded: {},

  setAiEnabled: (aiEnabled) => set({ aiEnabled }),
  toggleAi: () => set({ aiEnabled: !get().aiEnabled }),
  forceState: (forcedState) => set({ forcedState }),
  expand: (id, v = true) => set({ expanded: { ...get().expanded, [id]: v } }),

  record: ({ touchpointId, disposition, by, modelVersion, confidence, reason, reasonText, coSigner, diff }) =>
    set({
      dispositions: {
        ...get().dispositions,
        [touchpointId]: {
          touchpointId,
          disposition,
          reason,
          reasonText,
          coSigner,
          diff,
          at: new Date().toISOString(),
          by,
          modelVersion,
          confidence,
        },
      },
    }),

  clearDisposition: (touchpointId) => {
    const next = { ...get().dispositions }
    delete next[touchpointId]
    set({ dispositions: next })
  },

  resetAll: () => set({ dispositions: {}, expanded: {}, forcedState: null, aiEnabled: true }),
    }),
    {
      /**
       * Dispositions persist with the clinical record they qualify. A note whose
       * text survives a reload but whose decisions do not would re-present every
       * AI draft as undecided — and show live Accept / Reject bars on a SIGNED
       * note. The kill switch and the forced state stay per session.
       */
      name: 'indostates.ai',
      partialize: (s) => ({ dispositions: s.dispositions }),
    },
  ),
)

/**
 * A disposition that decides something. `Deferred` records that the clinician
 * looked and chose not to decide yet — it must never satisfy a signing gate,
 * or a section the clinician declined to decide on would sign as empty text.
 */
export const decided = (d?: DispositionRecord): boolean => d !== undefined && d.disposition !== 'Deferred'

/** How many of these touchpoints still need a decision — subscribed, so gates update. */
export function useOutstanding(touchpointIds: string[]): number {
  const dispositions = useAI((s) => s.dispositions)
  return touchpointIds.filter((id) => !decided(dispositions[id])).length
}

/**
 * Whether the fabric is live right now. Two things can switch it off: the
 * governance kill switch, and a forced AI-OFF (`forceState`) to show what
 * 57 screens look like without it. Every ◆ affordance reads this rather than
 * `aiEnabled`, so both paths behave identically.
 */
export const selectAiActive = (s: AIState): boolean => s.aiEnabled && s.forcedState !== 'AI-OFF'

/**
 * The rule that makes G2 real: a page's primary action stays disabled until
 * every G2 touchpoint on it has a recorded disposition.
 */
export function allDispositioned(touchpointIds: string[]): boolean {
  const { dispositions } = useAI.getState()
  return touchpointIds.every((id) => dispositions[id] !== undefined)
}

export function outstandingCount(touchpointIds: string[]): number {
  const { dispositions } = useAI.getState()
  return touchpointIds.filter((id) => dispositions[id] === undefined).length
}

/**
 * Whether a ◆ affordance renders at all.
 *
 * §1.5 is emphatic that AI-OFF HIDES rather than disables, and §4.2 marks the
 * capabilities that keep a deterministic floor. So a hard stop still fires with
 * the AI off — it just stops being presented as an AI finding.
 */
export function affordanceVisible(_capabilityId: string): boolean {
  return useAI.getState().aiEnabled
}

/** True where the capability keeps a rule-based floor with the model off. */
export function hasSafetyFloor(capabilityId: string): boolean {
  try {
    return capability(capabilityId).safetyFloor === true
  } catch {
    return false
  }
}

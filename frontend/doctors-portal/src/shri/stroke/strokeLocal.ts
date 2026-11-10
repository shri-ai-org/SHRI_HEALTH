/**
 * What the stroke screens record that the old stroke store (`@/store/stroke`)
 * has no place for — the old screens toasted these and kept nothing: a saved
 * intake, a de-activation and its reason, a timestamp amendment, a re-paged
 * team member. Held for the session, as the old store holds the stamps and
 * the clock (neither persists); every one of them is also on the audit trail,
 * which does.
 */

import { create } from 'zustand'

export interface IntakeDraft {
  fields: Record<string, string>
  mrs: string
  lives: string
  exclusions: Record<string, string>
  nextOfKin: string
  consent: string
  savedAt: Date
  by: string
}

export interface Deactivation {
  reason: string
  at: Date
  by: string
}

export interface Amendment {
  event: string
  rationale: string
  at: Date
  by: string
}

interface StrokeLocal {
  intakes: Record<string, IntakeDraft>
  deactivations: Record<string, Deactivation>
  amendments: Amendment[]
  /** Roles re-paged by hand, per case. */
  escalated: Record<string, string[]>
  saveIntake: (caseId: string, draft: IntakeDraft) => void
  deactivate: (caseId: string, d: Deactivation) => void
  amend: (a: Amendment) => void
  escalate: (caseId: string, role: string) => void
}

export const useStrokeLocal = create<StrokeLocal>()((set, get) => ({
  intakes: {},
  deactivations: {},
  amendments: [],
  escalated: {},
  saveIntake: (caseId, draft) => set({ intakes: { ...get().intakes, [caseId]: draft } }),
  // A case is de-activated once; the first reason stands.
  deactivate: (caseId, d) => {
    if (get().deactivations[caseId]) return
    set({ deactivations: { ...get().deactivations, [caseId]: d } })
  },
  amend: (a) => set({ amendments: [...get().amendments, a] }),
  escalate: (caseId, role) => {
    const now = get().escalated[caseId] ?? []
    if (now.includes(role)) return
    set({ escalated: { ...get().escalated, [caseId]: [...now, role] } })
  },
}))

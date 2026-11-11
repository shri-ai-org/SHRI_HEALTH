// SHRI_HEALTH: whether each AI feature is usable this session. The server says so only when a
// call is refused or fails: 409 feature-disabled (AI or the feature is off for the clinic), or an
// operation that failed with ai-unavailable (the model is down, or the month's budget is used up)
// or ai-output-rejected. A feature that failed that way is hidden for the rest of the session, so
// no AI button stays on screen that can't work; every other part of the screen keeps working.
import { create } from 'zustand'

import { ApiError } from '../../src/api/client'
import { problemCopy } from '../../src/design-system/problem/problem'

export type AiFeature = 'note-draft' | 'chart-summary' | 'chart-qa'

interface AiStatus {
  /** Why each feature is down, in plain words; absent while it works. */
  down: Partial<Record<AiFeature, string>>
  markDown: (feature: AiFeature, why: string) => void
}

export const useAiStatus = create<AiStatus>()((set, get) => ({
  down: {},
  markDown: (feature, why) => set({ down: { ...get().down, [feature]: why } }),
}))

/** True while the feature hasn't failed this session. */
export const useAiFeatureUp = (feature: AiFeature): boolean => useAiStatus((s) => s.down[feature] === undefined)

/** A refusal or failure that means "AI isn't available here", as opposed to an ordinary error. */
export function aiDownReason(error: unknown): string | null {
  if (error instanceof AiFeatureDown) return error.message
  if (error instanceof ApiError && (error.code === 'feature-disabled' || error.status === 503)) return problemCopy(error.problem).message
  return null
}

/** An AI operation that failed (ai-unavailable, ai-output-rejected): its Problem's detail. */
export class AiFeatureDown extends Error {}

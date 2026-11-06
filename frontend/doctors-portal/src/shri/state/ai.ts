/**
 * The AI fabric and the forced screen states live in the old build's store
 * (`src/store/ai.ts`), so there is one switch and one forced state — the same
 * ones `window.__forceState` and the old harness drive. The kill switch is per
 * session there (it is not persisted), and a forced AI-OFF counts as off.
 */

import type { DeclaredState } from '@/atlas/states'
import { selectAiActive, useAI } from '@/store/ai'
import { useUI } from '@/store/ui'

/** Whether AI is live right now: the kill switch is on and AI-OFF is not forced. */
export const useAiActive = () => useAI(selectAiActive)

/** The state the whole app is being shown in (DEV), or null. */
export const useForcedState = () => useAI((s) => s.forcedState)

export const forceState = (s: DeclaredState | null) => useAI.getState().forceState(s)

/** The user menu's switch — the old app bar's copy, word for word (`src/shell/AppBar.tsx:311-320`). */
export function setAiFabric(on: boolean) {
  useAI.getState().setAiEnabled(on)
  useUI.getState().toast({
    tone: on ? 'success' : 'caution',
    title: on ? 'AI fabric on' : 'AI fabric off — AI-OFF state',
    detail: on ? 'Every touchpoint is back.' : 'Affordances are hidden, not greyed. Hard stops still fire.',
  })
}

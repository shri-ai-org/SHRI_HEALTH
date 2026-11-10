// The single in-memory operational store. This is the ONE place Patient,
// Doctor, Appointment, Visit and Queue state lives — every screen reads from
// it via selectors.ts and every user action changes it via actions.ts.
// Nothing outside this file ever mutates `state` directly.
//
// This is deliberately the simplest structure that gives real, correct
// behavior: a mutable module-level reference, replaced (not mutated in
// place) on every write, plus a plain pub/sub so React can subscribe via
// `useSyncExternalStore` (src/hooks/useStore.ts) — no state-management
// library needed for a single-store app this size.
//
// DEV NOTE: when a real backend exists, `getState()`/`subscribe()` stay
// exactly as they are — only actions.ts's function bodies change, from
// "compute the next state locally" to "call the API, then reconcile the
// response into state" (or apply a server-sent event). No component needs
// to change.
import { createSeedState } from './seedData'
import type { AppState } from '../types/store'

let state: AppState = createSeedState()
const listeners = new Set<() => void>()

export function getState(): AppState {
  return state
}

export function setState(nextStateOrUpdater: AppState | ((current: AppState) => AppState)): void {
  state = typeof nextStateOrUpdater === 'function' ? nextStateOrUpdater(state) : nextStateOrUpdater
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Dev-only escape hatch (not wired to any UI) for resetting between manual
// test runs — never called from application code.
export function __resetStoreForTesting(): void {
  state = createSeedState()
  for (const listener of listeners) listener()
}

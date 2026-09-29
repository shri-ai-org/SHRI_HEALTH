/**
 * The stroke case's live state — the clock, the stamps, the checklist answers.
 *
 * Two rules from the atlas drive the shape of this store:
 *
 *   "the stream is APPEND-ONLY" (S-18-06) — a stamp is added, never edited. A
 *   correction is an audited amendment through the reconciliation screen.
 *
 *   "local times are RECONCILED AGAINST THE SERVER CLOCK, NEVER TRUSTED"
 *   (DD-012) — so the clock here runs from a server base, and a stamp records
 *   the server-derived case time rather than the browser's wall clock.
 */

import { create } from 'zustand'

import { STROKE_NOW } from '@/data/stroke'

export interface Stamp {
  key: string
  label: string
  /** Case time, derived from the server base — never Date.now(). */
  at: Date
  by: string
  /** Set where the stamp was captured offline and is awaiting reconciliation. */
  pending?: boolean
}

export interface BreachReason {
  intervalKey: string
  /** Structured capture AT THE MOMENT OF BREACH, not reconstructed at audit. */
  reason: string
  detail?: string
  at: Date
  by: string
}

interface StrokeState {
  /** Seconds elapsed since STROKE_NOW. The clock actually runs. */
  elapsedSec: number
  running: boolean
  stamps: Stamp[]
  breachReasons: BreachReason[]
  /** Checklist answers the user has changed, keyed by criterion. */
  criteria: Record<string, string>
  /** BP treated to target — the sub-flow that unblocks the BP criterion. */
  bpTreated: { systolic: number; diastolic: number; at: Date; by: string } | null
  /** The mandatory independent second check on the thrombolytic dose. */
  secondCheckBy: string | null
  /** Resources held by the single-act reservation. All four or none. */
  reservationHeld: boolean
  reservationAt: Date | null
  /** ASPECTS regions the human has adjusted, kept alongside the model score. */
  aspectsHuman: Record<string, boolean>
  /** Tasks moved on the parallel board. */
  taskColumns: Record<string, string>
  /** A recorded disagreement on EVT selection. */
  evtDisagreement: { by: string; reason: string; at: Date } | null

  tick: () => void
  setRunning: (v: boolean) => void
  /** Server time on the case clock. */
  caseNow: () => Date
  stamp: (key: string, label: string, by: string) => void
  isStamped: (key: string) => boolean
  captureBreach: (r: Omit<BreachReason, 'at'>) => void
  answerCriterion: (key: string, answer: string) => void
  treatBp: (systolic: number, diastolic: number, by: string) => void
  setSecondCheck: (by: string) => void
  holdReservation: () => void
  releaseReservation: () => void
  setAspectsRegion: (key: string, affected: boolean) => void
  moveTask: (id: string, column: string) => void
  recordEvtDisagreement: (by: string, reason: string) => void
  reset: () => void
}

export const useStroke = create<StrokeState>()((set, get) => ({
  elapsedSec: 0,
  running: true,
  stamps: [],
  breachReasons: [],
  criteria: {},
  bpTreated: null,
  secondCheckBy: null,
  reservationHeld: false,
  reservationAt: null,
  aspectsHuman: {},
  taskColumns: {},
  evtDisagreement: null,

  tick: () => {
    if (!get().running) return
    set({ elapsedSec: get().elapsedSec + 1 })
  },
  setRunning: (running) => set({ running }),

  caseNow: () => new Date(STROKE_NOW.getTime() + get().elapsedSec * 1000),

  stamp: (key, label, by) => {
    // Append-only: a key already stamped is not re-stamped.
    if (get().stamps.some((s) => s.key === key)) return
    set({ stamps: [...get().stamps, { key, label, at: get().caseNow(), by }] })
  },

  isStamped: (key) => get().stamps.some((s) => s.key === key),

  captureBreach: (r) => set({ breachReasons: [...get().breachReasons, { ...r, at: get().caseNow() }] }),

  answerCriterion: (key, answer) => set({ criteria: { ...get().criteria, [key]: answer } }),

  treatBp: (systolic, diastolic, by) => set({ bpTreated: { systolic, diastolic, at: get().caseNow(), by } }),

  setSecondCheck: (by) => set({ secondCheckBy: by }),

  holdReservation: () => set({ reservationHeld: true, reservationAt: get().caseNow() }),
  releaseReservation: () => set({ reservationHeld: false, reservationAt: null }),

  setAspectsRegion: (key, affected) => set({ aspectsHuman: { ...get().aspectsHuman, [key]: affected } }),

  moveTask: (id, column) => set({ taskColumns: { ...get().taskColumns, [id]: column } }),

  recordEvtDisagreement: (by, reason) => set({ evtDisagreement: { by, reason, at: get().caseNow() } }),

  reset: () =>
    set({
      elapsedSec: 0,
      running: true,
      stamps: [],
      breachReasons: [],
      criteria: {},
      bpTreated: null,
      secondCheckBy: null,
      reservationHeld: false,
      reservationAt: null,
      aspectsHuman: {},
      taskColumns: {},
      evtDisagreement: null,
    }),
}))

/** Minutes between two case times, for the interval clocks. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000))
}

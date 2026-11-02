/**
 * Z8 overlay state: the assistant panel, the explainability drawer, the
 * patient search palette and toasts.
 *
 * §6.1 constrains the bubble's behaviour and the panel's placement:
 *   "? opens from anywhere · Esc closes AND LEAVES THE PAGE STATE UNTOUCHED"
 *   "the bubble NEVER AUTO-OPENS"
 *   "shifts up when a C-33 toast is present"
 */

import { create } from 'zustand'

import type { AssistantAnswer } from '@/data/assistant'

export interface ThreadTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  answer?: AssistantAnswer
  at: string
  /** Set where the user has reported the answer as wrong. */
  reported?: boolean
}

/** What the C-42 explainability drawer is currently explaining. */
export interface ExplainTarget {
  touchpointId: string
  capabilityId: string
  /** Panel 1 — the plain-language claim. */
  claim: string
  confidence: number
  band: string
  computedAt: string
  /** Panel 2 — what it used, each clickable back to its source. */
  inputs: { label: string; source: string }[]
  /** Panel 3 — why: drivers with direction and weight, or retrieved evidence. */
  drivers?: { label: string; direction: 'up' | 'down'; weight: number }[]
  evidence?: string[]
  /** Panel 4 — limits & provenance. */
  model: string
  limits: string[]
}

export interface Toast {
  id: string
  tone: 'info' | 'success' | 'caution' | 'critical'
  title: string
  detail?: string
}

interface UIState {
  assistantOpen: boolean
  /** Screen the assistant was opened from — the panel header names it. */
  assistantFrom: { screenId: string; patientId?: string } | null
  thread: ThreadTurn[]
  /** An unread proactive nudge shows a dot. The bubble still never auto-opens. */
  assistantNudge: boolean

  explain: ExplainTarget | null
  /** GP-03 — one palette, opened from `/`, the app bar or the sidebar. */
  searchOpen: boolean
  toasts: Toast[]
  /** Z6 right rail collapsed to a 48px tab with a badge (lg breakpoint). */
  railCollapsed: boolean

  openAssistant: (from: { screenId: string; patientId?: string }) => void
  closeAssistant: () => void
  pushTurn: (turn: Omit<ThreadTurn, 'id' | 'at'>) => void
  reportAnswer: (turnId: string) => void
  clearThread: () => void
  setNudge: (v: boolean) => void

  openExplain: (t: ExplainTarget) => void
  closeExplain: () => void
  openSearch: () => void
  closeSearch: () => void
  toast: (t: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
  toggleRail: () => void
}

let seq = 0
const nextId = () => `u${++seq}`

export const useUI = create<UIState>()((set, get) => ({
  assistantOpen: false,
  assistantFrom: null,
  thread: [],
  assistantNudge: false,

  explain: null,
  searchOpen: false,
  toasts: [],
  /** Collapsed by default: the rail is context, and context is one tap away. */
  railCollapsed: true,

  /**
   * Also called when the page changes under an open panel. A conversation about
   * one patient is never left showing under another (guardrail 4), so a change
   * of patient starts a fresh one.
   */
  openAssistant: (assistantFrom) => {
    const samePatient = get().assistantFrom?.patientId === assistantFrom.patientId
    set({ assistantOpen: true, assistantFrom, assistantNudge: false, ...(samePatient ? {} : { thread: [] }) })
  },
  /** Closing leaves the thread intact — "leaves the page state untouched". */
  closeAssistant: () => set({ assistantOpen: false }),

  pushTurn: (turn) =>
    set({ thread: [...get().thread, { ...turn, id: nextId(), at: new Date().toISOString() }] }),

  reportAnswer: (turnId) =>
    set({ thread: get().thread.map((t) => (t.id === turnId ? { ...t, reported: true } : t)) }),

  clearThread: () => set({ thread: [] }),
  setNudge: (assistantNudge) => set({ assistantNudge }),

  openExplain: (explain) => set({ explain }),
  closeExplain: () => set({ explain: null }),
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),

  toast: (t) => {
    const id = nextId()
    set({ toasts: [...get().toasts, { ...t, id }] })
    window.setTimeout(() => get().dismissToast(id), 6000)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  toggleRail: () => set({ railCollapsed: !get().railCollapsed }),
}))

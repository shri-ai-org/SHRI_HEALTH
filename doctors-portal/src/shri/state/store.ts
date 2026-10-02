/**
 * Shared UI state (§14): filters, overlays, theme. One store, persisted under
 * `shri.ui`. What the old build already owns is read from its stores instead,
 * so there is one of each: the AI fabric and forced states (`useAI`, via
 * `./ai`), the toast stack and the explain target (`useUI`), seen marks and
 * voice notes (`useClinical`), break-glass (`useSession`), admissions
 * (`useAdmissions`). What is left here is presentation.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { DeclaredState } from '@/atlas/states'
import { maybePatient } from '@/data/kit'
import type { AttentionItem } from '@/data/myday'
import { useAI } from '@/store/ai'
import { useUI, type Toast } from '@/store/ui'

import { NOW } from '../lib/clock'
import { listedAttentionFor } from '../logic/attention'
import type { PatientFilter, PatientTab, ThemeId } from '../mocks/types'

import { setAiFabric } from './ai'

export type NoteModalState =
  | { kind: 'patient'; patientId: string; listening: boolean }
  | { kind: 'todo'; listening: boolean }

export type MenuId = 'notifications' | 'user'

export interface ShriState {
  /* ---- persisted */
  theme: ThemeId
  railOpen: boolean
  assistantNudge: boolean

  /* ---- session */
  patientTab: PatientTab
  patientFilter: PatientFilter | null
  /** The attention item the Quick-Panel is open on — its reason, its finding, its band. */
  quickPanel: AttentionItem | null
  noteModal: NoteModalState | null
  peekDay: string | null
  peekPinned: boolean
  searchOpen: boolean
  assistantOpen: boolean
  /** The patient the Admit modal is open for. */
  admitPatient: string | null
  menu: MenuId | null
  moreOpen: boolean
  attentionSort: 'ai' | 'time'
  /** The calendar card: one week (the default) or the whole month, around `calendarAnchor` (`yyyy-MM-dd`). */
  calendarView: 'week' | 'month'
  calendarAnchor: string
  /** The day whose detail the week view shows; kept across the switch to the month and back. */
  selectedDay: string
  calendarDir: 1 | -1
  /** Height of the toast stack, so the assistant bubble can lift clear of it. */
  toastLift: number
  /** Height of a screen's sticky action bar (Z7a), so the toast and the bubble float above it and never cover its primary action. */
  barLift: number

  /* ---- actions */
  setTheme: (t: ThemeId) => void
  toggleTheme: () => void
  setAiOn: (on: boolean) => void
  toggleRail: () => void

  setPatientTab: (t: PatientTab) => void
  setPatientFilter: (f: PatientFilter | null) => void
  applyKpiFilter: (tab: PatientTab, filter: PatientFilter | null) => void
  clearFilter: () => void

  openQuickPanel: (item: AttentionItem) => void
  closeQuickPanel: () => void

  openNoteModal: (m: NoteModalState) => void
  closeNoteModal: () => void

  openPeek: (day: string) => void
  pinPeek: (day: string) => void
  closePeek: () => void
  goMonth: (dir: 1 | -1) => void
  goWeek: (dir: 1 | -1) => void
  setCalendarView: (v: 'week' | 'month') => void
  /** Choose a day (the anchor follows it, so the week or month that holds it is shown). */
  selectDay: (iso: string) => void
  goToday: () => void
  /** The calendar's one dialog at a time: block time (from a date), or move / cancel one appointment. */
  scheduleDialog: ScheduleDialog | null
  openScheduleDialog: (d: ScheduleDialog) => void
  closeScheduleDialog: () => void

  openSearch: () => void
  closeSearch: () => void
  openAssistant: () => void
  closeAssistant: () => void
  toggleAssistant: () => void
  openAdmit: (patientId: string) => void
  closeAdmit: () => void
  setMenu: (m: MenuId | null) => void
  toggleMenu: (m: MenuId) => void
  setMoreOpen: (open: boolean) => void
  setAttentionSort: (s: 'ai' | 'time') => void
  /** A one-line toast onto the shared stack (`useUI`). */
  showToast: (text: string, tone?: Toast['tone']) => void
  setToastLift: (px: number) => void
  setBarLift: (px: number) => void
  /** Esc — closes the top-most overlay, in the order the spec stacks them. */
  closeTop: () => void
}

export type ScheduleDialog =
  | { kind: 'block'; from?: string }
  | { kind: 'unblock'; blockId: string }
  | { kind: 'move'; appointmentId: string }
  | { kind: 'cancel'; appointmentId: string }

const KEY = 'shri.ui'
/**
 * v2: the AI switch left for the old build's `useAI`, where it is per session.
 * v3: persona, facility and language left for the old build's `useSession`.
 * v4: seen marks, break-glass, to-dos and dictated drafts left for the old
 *     build's `useClinical` and `useSession`.
 * v5: admissions left for the old build's `useAdmissions`.
 */
const VERSION = 5
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const TODAY_ISO = isoOf(NOW)
const dateOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * DEV-only hooks for headless screenshots, same shape as `src/e2e.ts`:
 *   ?theme=dark   ?ai=off   ?state=OFFLINE   ?reset=1
 * They write the persisted key BEFORE the store below reads it.
 */
if (import.meta.env.DEV) {
  const q = new URLSearchParams(window.location.search)
  if (q.has('theme') || q.has('reset')) {
    try {
      const existing = q.has('reset') ? {} : (JSON.parse(localStorage.getItem(KEY) ?? '{}') as { state?: Record<string, unknown>; version?: number })
      const state = { ...(existing.state ?? {}) }
      const theme = q.get('theme')
      if (theme === 'light' || theme === 'dark') state.theme = theme
      localStorage.setItem(KEY, JSON.stringify({ ...existing, state, version: existing.version ?? VERSION }))
    } catch {
      /* a blocked localStorage just means defaults */
    }
  }
  // The AI switch and the forced state are the old build's (per session, never persisted).
  if (q.get('ai') === 'off') useAI.getState().setAiEnabled(false)
  const forced = q.get('state')
  if (forced) useAI.getState().forceState(forced as DeclaredState)
}

/**
 * The attention item behind a DEV `?open=qp:<patient id>`: the one My Day
 * ranks for that patient, or — so a screenshot can reach anyone — a plain one.
 */
function devAttention(patientId: string): AttentionItem {
  return listedAttentionFor(patientId) ?? { id: `dev-${patientId}`, patientId, urgency: 'pending', reason: 'Opened from a link', detail: '', since: NOW }
}

/**
 * DEV-only: `?open=qp:SD-P-03` · `note:todo` · `note:SD-P-03` · `search` ·
 * `admit:SD-P-01` · `assistant` · `peek:2026-09-28` · `menu:user` ·
 * `rail` · `tab:ip` · `filter:waiting` — comma-separated. Lets a headless
 * screenshot land on an overlay without a click path.
 */
function devOpen(): Partial<ShriState> {
  if (!import.meta.env.DEV) return {}
  const q = new URLSearchParams(window.location.search).get('open')
  if (!q) return {}
  const out: Partial<ShriState> = {}
  for (const token of q.split(',')) {
    const [k, v] = token.split(':')
    // Patient ids are the old kit's; an unknown one opens nothing rather than a panel about no one.
    if (k === 'qp' && v && maybePatient(v)) out.quickPanel = devAttention(v)
    else if (k === 'note' && v === 'todo') out.noteModal = { kind: 'todo', listening: false }
    else if (k === 'note' && v && maybePatient(v)) out.noteModal = { kind: 'patient', patientId: v, listening: false }
    else if (k === 'search') out.searchOpen = true
    else if (k === 'admit' && v && maybePatient(v)) out.admitPatient = v
    else if (k === 'assistant') out.assistantOpen = true
    else if (k === 'peek' && v) {
      out.peekDay = v
      out.peekPinned = true
    } else if (k === 'menu' && (v === 'notifications' || v === 'user')) out.menu = v
    else if (k === 'rail') out.railOpen = true
    else if (k === 'tab' && (v === 'opd' || v === 'ip')) out.patientTab = v
    else if (k === 'filter' && (v === 'waiting' || v === 'inroom' || v === 'admissions' || v === 'icu')) out.patientFilter = v
  }
  return out
}

/** DEV-only: whether `?open=` names a screen's own overlay (`hardstop`, `override` on S-06-07; `critical` on S-09-04) — the same headless landing. */
export function devOpens(token: string): boolean {
  if (!import.meta.env.DEV) return false
  const q = new URLSearchParams(window.location.search).get('open')
  return q ? q.split(',').includes(token) : false
}

export const useShri = create<ShriState>()(
  persist(
    (set, get) => ({
      theme: 'light',
      railOpen: false,
      assistantNudge: true,

      patientTab: 'opd',
      patientFilter: null,
      quickPanel: null,
      noteModal: null,
      peekDay: null,
      peekPinned: false,
      searchOpen: false,
      assistantOpen: false,
      admitPatient: null,
      menu: null,
      moreOpen: false,
      attentionSort: 'ai',
      calendarView: 'week',
      calendarAnchor: TODAY_ISO,
      selectedDay: TODAY_ISO,
      calendarDir: 1,
      toastLift: 0,
      barLift: 0,
      ...devOpen(),

      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === 'light' ? 'dark' : 'light' }),
      setAiOn: (on) => {
        setAiFabric(on)
        // Nothing AI-marked stays open; it would only reappear when the fabric comes back.
        if (!on) {
          set({ assistantOpen: false })
          useUI.getState().closeExplain()
        }
      },
      toggleRail: () => set({ railOpen: !get().railOpen }),

      setPatientTab: (patientTab) => set({ patientTab }),
      setPatientFilter: (patientFilter) => set({ patientFilter }),
      applyKpiFilter: (patientTab, patientFilter) => {
        // A second click on the active filter card clears it — the ✓ then reads as a toggle.
        const same = get().patientFilter === patientFilter && get().patientTab === patientTab && patientFilter !== null
        set({ patientTab, patientFilter: same ? null : patientFilter })
      },
      clearFilter: () => set({ patientFilter: null }),

      openQuickPanel: (quickPanel) => set({ quickPanel, menu: null, searchOpen: false }),
      closeQuickPanel: () => set({ quickPanel: null }),

      openNoteModal: (noteModal) => set({ noteModal }),
      // The microphone is the arbiter's (`logic/dictation`): closing the box's owner unmounts it, which closes the mic.
      closeNoteModal: () => set({ noteModal: null }),

      openPeek: (peekDay) => {
        if (get().peekPinned) return
        set({ peekDay })
      },
      pinPeek: (peekDay) => set({ peekDay, peekPinned: true, menu: null }),
      closePeek: () => set({ peekDay: null, peekPinned: false }),
      goMonth: (dir) => {
        const a = dateOf(get().calendarAnchor)
        set({ calendarAnchor: isoOf(new Date(a.getFullYear(), a.getMonth() + dir, 1)), calendarDir: dir, peekDay: null, peekPinned: false })
      },
      goWeek: (dir) => {
        const a = dateOf(get().calendarAnchor)
        const next = isoOf(new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7 * dir))
        // The selected day moves with the week, weekday for weekday, so the detail always belongs to the week in view.
        const sel = dateOf(get().selectedDay)
        set({ calendarAnchor: next, selectedDay: isoOf(new Date(sel.getFullYear(), sel.getMonth(), sel.getDate() + 7 * dir)), calendarDir: dir, peekDay: null, peekPinned: false })
      },
      setCalendarView: (calendarView) => set({ calendarView, calendarAnchor: get().selectedDay, peekDay: null, peekPinned: false }),
      selectDay: (iso) => {
        const dir: 1 | -1 = iso >= get().selectedDay ? 1 : -1
        set({ selectedDay: iso, calendarAnchor: iso, calendarDir: dir })
      },
      scheduleDialog: null,
      // A pinned day peek gives way to the dialog opened from it, so the dialog is the one thing in front.
      openScheduleDialog: (scheduleDialog) => set({ scheduleDialog, peekDay: null, peekPinned: false }),
      closeScheduleDialog: () => set({ scheduleDialog: null }),
      goToday: () => {
        const dir: 1 | -1 = get().calendarAnchor < TODAY_ISO ? 1 : -1
        set({ calendarAnchor: TODAY_ISO, selectedDay: TODAY_ISO, calendarDir: dir, peekDay: null, peekPinned: false })
      },

      openSearch: () => set({ searchOpen: true, menu: null }),
      closeSearch: () => set({ searchOpen: false }),
      openAssistant: () => set({ assistantOpen: true, assistantNudge: false, menu: null }),
      closeAssistant: () => set({ assistantOpen: false }),
      toggleAssistant: () => (get().assistantOpen ? get().closeAssistant() : get().openAssistant()),
      openAdmit: (admitPatient) => set({ admitPatient }),
      closeAdmit: () => set({ admitPatient: null }),
      setMenu: (menu) => set({ menu }),
      toggleMenu: (m) => set({ menu: get().menu === m ? null : m }),
      setMoreOpen: (moreOpen) => set({ moreOpen }),
      setAttentionSort: (attentionSort) => set({ attentionSort }),
      showToast: (text, tone = 'success') => useUI.getState().toast({ tone, title: text }),
      setToastLift: (toastLift) => set({ toastLift }),
      setBarLift: (barLift) => set({ barLift }),

      closeTop: () => {
        const s = get()
        if (s.noteModal) return set({ noteModal: null })
        if (s.admitPatient) return set({ admitPatient: null })
        if (s.searchOpen) return set({ searchOpen: false })
        if (s.quickPanel) return set({ quickPanel: null })
        if (s.peekPinned) return set({ peekDay: null, peekPinned: false })
        if (s.assistantOpen) return set({ assistantOpen: false })
        if (s.menu) return set({ menu: null })
        if (s.moreOpen) return set({ moreOpen: false })
      },
    }),
    {
      name: KEY,
      version: VERSION,
      migrate: (persisted, from) => {
        const state = { ...(persisted as Record<string, unknown>) }
        if (from < 2) delete state.aiOn
        if (from < 3) {
          delete state.persona
          delete state.facilityCode
          delete state.language
        }
        if (from < 4) {
          for (const k of ['todos', 'todoSeq', 'dictatedDrafts', 'draftSeq', 'seen', 'brokeGlass']) delete state[k]
        }
        if (from < 5) delete state.admissions
        return state as unknown as ShriState
      },
      partialize: (s) => ({
        theme: s.theme,
        railOpen: s.railOpen,
        assistantNudge: s.assistantNudge,
      }),
    },
  ),
)

/** Whether any scrim-backed overlay is up (§6). */
export const selectScrim = (s: ShriState) =>
  Boolean(s.quickPanel || s.noteModal || s.searchOpen || s.admitPatient || s.peekPinned)

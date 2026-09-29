/**
 * Who is calling, where from, in what language, and how the surface looks.
 *
 * On the theme: §5.3 makes night mandatory on the ICU, discharge, stroke and
 * radiology-reading screens. Night is the DEFAULT for this build, and light is
 * the explicit alternative behind the Z1 toggle. Where a clinician has switched
 * to light, a night-mandatory screen surfaces a dismissible prompt in Z4 rather
 * than switching the theme underneath them. The rule stays visible and one
 * click away; it never overrides the person.
 *
 * On notes: voice is the default way into every note field (`notesInput`), and
 * typing is always one tap away. The preference is per person and persists.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { PersonaId } from '@/atlas/personas'
import { PERSONA_SPECS } from '@/atlas/personas'
import type { LanguageCode } from '@/data/kit'
import { STAFF_FOR_PERSONA, staff } from '@/data/kit'

export type Theme = 'light' | 'night'
export type Density = 'compact' | 'comfortable'
/** How a clinician prefers to fill a note field. Voice first; typing always available. */
export type NotesInput = 'voice' | 'type'

interface SessionState {
  /**
   * S-02-01. §3.2 rule 3: "default is deny, evaluated at request time — never
   * baked into a token." So this flag says only that someone authenticated; it
   * grants nothing. Every screen still checks its own capability.
   */
  signedIn: boolean
  /** Consecutive failures, for the LOCKED state. */
  failedAttempts: number
  /** ISO, while the account is held after repeated failures. */
  lockedUntil: string | null
  persona: PersonaId
  /** GP-07 — switching facility changes authorization scope and must be unmistakable. */
  facilityCode: string
  /** GP-08 — per user; patient documents follow the PATIENT's preference. */
  language: LanguageCode
  theme: Theme
  /** §5.4 — density is a typographic token, defaulted per persona. */
  density: Density
  /** The default input for every note field. */
  notesInput: NotesInput
  /** True once the user has dismissed the night-theme prompt this session. */
  nightPromptDismissed: boolean
  /** Z2 collapsed to the 64px icon rail. */
  navCollapsed: boolean
  /**
   * Patients the user has break-glassed into. GP-10's amber banner renders
   * while one is open.
   */
  breakGlassPatients: Record<string, { reason: string; at: string }>

  /** Returns false on a rejected attempt; the caller shows ONE uniform message. */
  signIn: (email: string, password: string) => boolean
  signOut: () => void
  setPersona: (p: PersonaId) => void
  setFacility: (code: string) => void
  setLanguage: (l: LanguageCode) => void
  setTheme: (t: Theme) => void
  toggleTheme: () => void
  setDensity: (d: Density) => void
  setNotesInput: (m: NotesInput) => void
  dismissNightPrompt: () => void
  toggleNav: () => void
  grantBreakGlass: (patientId: string, reason: string) => void
  revokeBreakGlass: (patientId: string) => void
}

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      signedIn: false,
      failedAttempts: 0,
      lockedUntil: null,
      persona: 'P-04',
      facilityCode: 'ICH',
      language: 'EN',
      theme: 'night',
      density: 'compact',
      notesInput: 'voice',
      nightPromptDismissed: false,
      navCollapsed: false,
      breakGlassPatients: {},

      /**
       * There is no backend, so this checks only the shape of what was typed:
       * an address, and a password of at least eight characters. What matters
       * for the mockup is the BEHAVIOUR around the refusal — a single uniform
       * message and a lock after repeated failures — which is specified and is
       * implemented here and in S-02-01.
       */
      signIn: (email, password) => {
        const locked = get().lockedUntil !== null && new Date(get().lockedUntil!) > new Date()
        if (locked) return false

        const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()) && password.length >= 8
        if (ok) {
          set({ signedIn: true, failedAttempts: 0, lockedUntil: null })
          return true
        }

        const failedAttempts = get().failedAttempts + 1
        set({
          failedAttempts,
          // Five is the threshold; the atlas states the duration, not the count.
          lockedUntil: failedAttempts >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null,
        })
        return false
      },

      /** Signing out drops the break-glass grants with the session, as it must. */
      signOut: () => set({ signedIn: false, failedAttempts: 0, lockedUntil: null, breakGlassPatients: {} }),

      setPersona: (persona) =>
        set({
          persona,
          density: PERSONA_SPECS[persona].density,
          facilityCode: staff(STAFF_FOR_PERSONA[persona]).facilityCode,
          // A new persona gets the prompt again — the rule is per-person.
          nightPromptDismissed: false,
        }),
      setFacility: (facilityCode) => set({ facilityCode }),
      setLanguage: (language) => set({ language }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === 'light' ? 'night' : 'light' }),
      setDensity: (density) => set({ density }),
      setNotesInput: (notesInput) => set({ notesInput }),
      dismissNightPrompt: () => set({ nightPromptDismissed: true }),
      toggleNav: () => set({ navCollapsed: !get().navCollapsed }),

      grantBreakGlass: (patientId, reason) =>
        set({
          breakGlassPatients: {
            ...get().breakGlassPatients,
            [patientId]: { reason, at: new Date().toISOString() },
          },
        }),
      revokeBreakGlass: (patientId) => {
        const next = { ...get().breakGlassPatients }
        delete next[patientId]
        set({ breakGlassPatients: next })
      },
    }),
    {
      name: 'indostates.session',
      /**
       * v1: night became the default and the hub moved to Coimbatore. v2: a
       * device that had `theme: 'light'` persisted from BEFORE v1 shipped — the
       * local dev server and the LAN `Network:` URL are separate browser
       * origins, each with its own `localStorage`, so a device that only ever
       * opened the LAN link kept its pre-v1 light default even after v1 landed
       * everywhere else. Forcing the reset again at v2 catches that origin too.
       * A toggle after this point is a real choice and stays untouched.
       */
      version: 2,
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Partial<SessionState>
        if (version < 2) {
          return { ...s, theme: 'night', facilityCode: 'ICH', notesInput: 'voice' } as SessionState
        }
        return s as SessionState
      },
    },
  ),
)

/** The signed-in staff member for the current persona. */
export function useCurrentStaff() {
  const persona = useSession((s) => s.persona)
  return staff(STAFF_FOR_PERSONA[persona])
}

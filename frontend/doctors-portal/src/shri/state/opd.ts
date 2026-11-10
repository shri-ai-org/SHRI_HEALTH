/**
 * Today's outpatient session as it happens: who has been called in (a
 * consultation or teleconsult started) and whose consultation has finished.
 * The seeded clinic list says where everyone stood at 08:40; this is what the
 * doctor has done since, so every card that shows the queue — My Day's counts
 * and list, My patients, Telehealth — moves together (`logic/opd.ts`).
 * Persisted, like the rest of the session's clinical state.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface OpdState {
  /** Called in, or their consultation opened: in the room from then. */
  startedAt: Record<string, string>
  /** Consultation over — the teleconsult ended, or the note signed (read from the note itself). */
  finishedAt: Record<string, string>
  start: (patientId: string) => void
  finish: (patientId: string) => void
  /** Forgets these patients' marks — the video visits, which start fresh on every load. */
  forget: (patientIds: string[]) => void
}

export const useOpd = create<OpdState>()(
  persist(
    (set, get) => ({
      startedAt: {},
      finishedAt: {},
      // Starting twice keeps the first time; a finished consultation is not reopened by looking at the note again.
      start: (patientId) => {
        if (get().startedAt[patientId] || get().finishedAt[patientId]) return
        set({ startedAt: { ...get().startedAt, [patientId]: new Date().toISOString() } })
      },
      finish: (patientId) => {
        if (get().finishedAt[patientId]) return
        set({ finishedAt: { ...get().finishedAt, [patientId]: new Date().toISOString() } })
      },
      forget: (ids) => {
        const startedAt = { ...get().startedAt }
        const finishedAt = { ...get().finishedAt }
        for (const id of ids) {
          delete startedAt[id]
          delete finishedAt[id]
        }
        set({ startedAt, finishedAt })
      },
    }),
    { name: 'shri.opd', version: 1 },
  ),
)

/**
 * Cohorts the doctor saved: a name and the filters that make it (the page's
 * own query string), so a cohort reopens exactly as it was built. Kept on this
 * device. Only the filters are stored — never the patients they matched,
 * which follow the record as it changes.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface SavedCohort {
  id: string
  name: string
  /** The filters, as the page's query string (no leading ?). */
  query: string
  savedAt: string
}

interface CohortsState {
  saved: SavedCohort[]
  save: (name: string, query: string, at: string) => SavedCohort
  remove: (id: string) => void
}

let seq = 0

export const useCohorts = create<CohortsState>()(
  persist(
    (set, get) => ({
      saved: [],
      save: (name, query, at) => {
        seq += 1
        const cohort = { id: `CO-${Date.now().toString(36)}-${seq}`, name: name.trim(), query, savedAt: at }
        set({ saved: [cohort, ...get().saved.filter((c) => c.name.toLowerCase() !== cohort.name.toLowerCase())] })
        return cohort
      },
      remove: (id) => set({ saved: get().saved.filter((c) => c.id !== id) }),
    }),
    { name: 'shri.cohorts', version: 1 },
  ),
)

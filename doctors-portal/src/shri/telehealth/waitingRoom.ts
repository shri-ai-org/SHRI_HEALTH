// Who is waiting in a video call for the doctor: a patient who has joined their
// visit's room from the patient portal before the doctor did. The portal says so
// (for now its stand-in, PatientDemoPage); the doctor is told on every screen
// (WaitingBar, the bell, Video visits) until they join or the patient leaves.
//
// Kept in this browser's storage and shared between its windows, so a patient
// window beside the doctor's tells the doctor at once. Across devices the backend
// will carry it.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface Waiting {
  visitId: string
  patientId: string
  /** When they came into the room. */
  since: number
}

interface WaitingState {
  waiting: Record<string, Waiting>
  arrive: (visitId: string, patientId: string) => void
  leave: (visitId: string) => void
}

const KEY = 'shri.waiting'

export const useWaiting = create<WaitingState>()(
  persist(
    (set) => ({
      waiting: {},
      arrive: (visitId, patientId) =>
        set((s) => (s.waiting[visitId] ? s : { waiting: { ...s.waiting, [visitId]: { visitId, patientId, since: Date.now() } } })),
      leave: (visitId) =>
        set((s) => {
          if (!s.waiting[visitId]) return s
          const { [visitId]: _gone, ...rest } = s.waiting
          return { waiting: rest }
        }),
    }),
    { name: KEY, version: 1 },
  ),
)

// Another window of this browser changed it: read it again.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) void useWaiting.persist.rehydrate()
  })
}

/** Everyone waiting, longest first. */
export const waitingList = (w: Record<string, Waiting>) => Object.values(w).sort((a, b) => a.since - b.since)

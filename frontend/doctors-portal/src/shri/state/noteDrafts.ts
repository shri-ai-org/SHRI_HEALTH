/**
 * Notes being written, kept on this device as they change — a dictated or typed
 * draft survives closing the box or reloading the page, and is gone once it is
 * saved or discarded. One draft per place: the To-do, or a patient's note.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface NoteDraftsState {
  drafts: Record<string, { text: string; at: string }>
  keep: (key: string, text: string) => void
  clear: (key: string) => void
}

export const useNoteDrafts = create<NoteDraftsState>()(
  persist(
    (set, get) => ({
      drafts: {},
      keep: (key, text) => {
        const { [key]: _, ...rest } = get().drafts
        set({ drafts: text.trim() === '' ? rest : { ...rest, [key]: { text, at: new Date().toISOString() } } })
      },
      clear: (key) => {
        const { [key]: _, ...rest } = get().drafts
        set({ drafts: rest })
      },
    }),
    { name: 'shri.noteDrafts', version: 1 },
  ),
)

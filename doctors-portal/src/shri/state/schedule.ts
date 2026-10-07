/**
 * The doctor's own changes to their calendar, layered over the seeded
 * appointment book (which stays as it is): time they have blocked, and what
 * they have done to a booked appointment — moved it to another slot, asked the
 * front office to rebook it with the patient, or cancelled it with a reason.
 * A move books a new appointment and marks the old one as moved, so the
 * history keeps both. Persisted with the rest of the session's clinical state;
 * `logic/schedule.ts` reads it for every screen and sends the notices.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { Appointment } from '@/data/record'

export const BLOCK_REASONS = ['Annual leave', 'Study leave', 'Conference', 'Theatre list', 'Administrative', 'Sick leave', 'Personal'] as const
export type BlockReason = (typeof BLOCK_REASONS)[number]

export interface Block {
  id: string
  /** First and last day, `yyyy-MM-dd`, inclusive. */
  from: string
  to: string
  /** All day, or `start`–`end` (HH:mm) on each day of the range. */
  allDay: boolean
  start?: string
  end?: string
  reason: BlockReason
  /** For the front office and the rota owner — never shown to a patient. */
  note?: string
  by: string
  at: string
}

export type AppointmentChange =
  | { kind: 'cancelled'; reason: string; by: string; at: string }
  | { kind: 'moved'; to: string; by: string; at: string }
  | { kind: 'rebooking'; by: string; at: string }

/** An appointment booked here, stored with its time as ISO. */
export interface BookedHere extends Omit<Appointment, 'at'> {
  at: string
  /** The appointment it replaces, when it is a move. */
  movedFrom?: string
  /** How long it was booked for, where the doctor chose the slot; otherwise the clinic's slot length. */
  minutes?: number
}

interface ScheduleState {
  blocks: Block[]
  changes: Record<string, AppointmentChange>
  booked: BookedHere[]
  addBlock: (b: Block) => void
  removeBlock: (id: string) => void
  setChange: (appointmentId: string, change: AppointmentChange) => void
  book: (a: BookedHere) => void
}

export const useSchedule = create<ScheduleState>()(
  persist(
    (set, get) => ({
      blocks: [],
      changes: {},
      booked: [],
      addBlock: (b) => set({ blocks: [...get().blocks, b] }),
      removeBlock: (id) => set({ blocks: get().blocks.filter((b) => b.id !== id) }),
      setChange: (appointmentId, change) => set({ changes: { ...get().changes, [appointmentId]: change } }),
      book: (a) => set({ booked: [...get().booked, a] }),
    }),
    { name: 'shri.schedule', version: 1 },
  ),
)

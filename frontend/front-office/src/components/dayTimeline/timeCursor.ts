// The red time cursor on a list of doctors' days: one minute of the day, shared
// by the axis that carries its handle and every row that draws its line, so it
// always moves as one. It moves only when the desk drags it (or uses the keys)
// on the shared axis. null means "not moved yet": it then stands at the time
// now. The blue Now pin is separate and never moves.
import { useSyncExternalStore } from 'react'
import type { Span } from './dayModel'

let pinned: number | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Put the cursor at a minute (null: back to the time now). */
export function setTimeCursor(next: number | null): void {
  if (next === pinned) return
  pinned = next
  for (const listener of listeners) listener()
}

/** Where the desk put the cursor — null while it has not been moved. */
export function useTimeCursor(): number | null {
  return useSyncExternalStore(subscribe, () => pinned)
}

/** The minute of day of a timestamp. */
export function minuteOfDay(timestamp: number): number {
  const d = new Date(timestamp)
  return d.getHours() * 60 + d.getMinutes()
}

/** Where the cursor stands on a day's hours: as moved, else at `clock` — kept within the hours. */
export function cursorMinute(moved: number | null, clock: number, [start, end]: Span): number {
  return Math.min(end, Math.max(start, moved ?? clock))
}

/** The cursor moves in five-minute steps. */
export const CURSOR_STEP = 5

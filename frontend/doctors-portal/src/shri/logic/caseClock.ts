// ported from src/screens/m18/CaseClock.tsx:14-83 — the stroke case clock.
//
// DD-012 governs the time: the clock is server-authoritative and the event
// stream append-only; a stamp records the server-derived case time, never the
// browser's wall clock. Case time is STROKE_NOW plus the store's elapsed
// seconds, advanced once a second while a stroke screen that runs the clock is
// mounted.
//
// Left out, as a forecast (decision 8): AI-209's "projected to breach" — the
// old `projected` flag and `atRisk` counting it. An interval needs attention
// here only when it HAS breached: over its target, unstamped.

import { useEffect, useMemo } from 'react'

import { CASE_INTERVALS, STROKE_NOW, type ClockInterval, type IntervalState } from '@/data/stroke'
import { minutesBetween, useStroke } from '@/store/stroke'

/**
 * The current case time. It selects `elapsedSec` — a primitive — and derives
 * the Date from it; selecting `caseNow()` would hand back a fresh Date every
 * render, which never compares equal and re-renders forever.
 */
export function useCaseNow(): Date {
  const elapsedSec = useStroke((s) => s.elapsedSec)
  return useMemo(() => new Date(STROKE_NOW.getTime() + elapsedSec * 1000), [elapsedSec])
}

/** Runs the case clock for as long as a stroke screen is mounted. */
export function useCaseClock(): Date {
  const tick = useStroke((s) => s.tick)
  useEffect(() => {
    const t = window.setInterval(tick, 1000)
    return () => window.clearInterval(t)
  }, [tick])
  return useCaseNow()
}

export interface LiveInterval extends ClockInterval {
  elapsed: number | null
  stamp: Date | undefined
  state: IntervalState
}

/** The live state of one interval, from the stamps rather than the seed — so stamping the needle closes DTN. */
export function liveInterval(interval: ClockInterval, caseNow: Date, stamped: (key: string) => Date | undefined): LiveInterval {
  const stampKey = interval.key === 'dtn' ? 'needle' : interval.key === 'dido' ? 'door-out' : interval.key
  const stamp = interval.stampedAt ?? stamped(stampKey)
  const elapsed = interval.startedAt ? minutesBetween(interval.startedAt, stamp ?? caseNow) : null
  let state = interval.state
  if (stamp) state = 'DONE'
  else if (interval.startedAt && interval.targetMin !== null && elapsed !== null && elapsed > interval.targetMin) state = 'BREACH'
  else if (interval.startedAt && !stamp) state = interval.state === 'PENDING' ? 'PENDING' : 'RUNNING'
  return { ...interval, elapsed, stamp, state }
}

/** An interval that needs attention now: over its target and unstamped. Recorded, not predicted. */
export const atRisk = (i: { state: IntervalState }) => i.state === 'BREACH'

export function useLiveIntervals(): LiveInterval[] {
  const caseNow = useCaseNow()
  const stamps = useStroke((s) => s.stamps)
  const stamped = (key: string) => stamps.find((s) => s.key === key)?.at
  return CASE_INTERVALS.map((i) => liveInterval(i, caseNow, stamped))
}

export function shortLabel(key: string): string {
  switch (key) {
    case 'd2ct':
      return 'D2CT'
    case 'dtn':
      return 'DTN'
    case 'dido':
      return 'DIDO'
    default:
      return key.toUpperCase()
  }
}

// Where each video visit stands, in the words the screens use, and one rule for it
// so the list, the counts and the visit page always agree:
//
//   Waiting     booked, the call not started yet
//   In call     the call is open in this page
//   Call ended  the call is over; the doctor still has the visit to finish
//   Done        the doctor marked it done

import { useTele } from './teleStore'

export type VisitStatus = 'waiting' | 'incall' | 'ended' | 'done'

export const STATUS_WORD: Record<VisitStatus, string> = {
  waiting: 'Waiting',
  incall: 'In call',
  ended: 'Call ended',
  done: 'Done',
}

export const STATUS_CLASS: Record<VisitStatus, string> = {
  waiting: 'bg-sh-warn-bg text-sh-warn-fg',
  incall: 'bg-sh-pend-bg text-sh-pend-fg',
  ended: 'bg-sh-crit-bg text-sh-crit-fg',
  done: 'bg-sh-norm-bg text-sh-norm-fg',
}

/** A function from patient to their visit's status, kept current. */
export function useVisitStatus(): (patientId: string) => VisitStatus {
  const activeSid = useTele((s) => s.activeSid)
  const sessions = useTele((s) => s.sessions)
  const latest = useTele((s) => s.latest)
  const done = useTele((s) => s.done)
  return (patientId) => {
    if (activeSid && sessions[activeSid]?.patientId === patientId) return 'incall'
    if (done[patientId]) return 'done'
    const last = latest[patientId] ? sessions[latest[patientId]] : undefined
    if (last?.endedAt) return 'ended'
    return 'waiting'
  }
}

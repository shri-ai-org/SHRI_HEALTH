// Where each video visit stands, in the words the screens use, and one rule for it
// so the list, the counts and the visit page always agree:
//
//   Waiting     booked, the call not started yet
//   In the waiting room   the patient is in the video call, waiting for the doctor
//   In call     the call is open in this page
//   Call ended  the call is over; the doctor still has the visit to finish
//   Done        the doctor marked it done

import { useTele } from './teleStore'
import { useWaiting } from './waitingRoom'

export type VisitStatus = 'waiting' | 'lobby' | 'incall' | 'ended' | 'done'

export const STATUS_WORD: Record<VisitStatus, string> = {
  waiting: 'Waiting',
  lobby: 'In the waiting room',
  incall: 'In call',
  ended: 'Call ended',
  done: 'Done',
}

export const STATUS_CLASS: Record<VisitStatus, string> = {
  waiting: 'bg-sh-warn-bg text-sh-warn-fg',
  lobby: 'bg-sh-accent text-sh-accent-ink',
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
  const waiting = useWaiting((s) => s.waiting)
  return (patientId) => {
    if (activeSid && sessions[activeSid]?.patientId === patientId) return 'incall'
    if (done[patientId]) return 'done'
    if (Object.values(waiting).some((w) => w.patientId === patientId)) return 'lobby'
    const last = latest[patientId] ? sessions[latest[patientId]] : undefined
    if (last?.endedAt) return 'ended'
    return 'waiting'
  }
}

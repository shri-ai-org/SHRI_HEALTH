// A reload of the doctor's portal is a fresh start for the video visits: every
// visit Waiting again (teleStore keeps nothing across loads), their OPD marks
// gone so Patients Today and the timeline agree, nobody left on the waiting list
// (the room watch finds anyone really there within seconds), and a new
// demonstration code (demoCode.ts) — new rooms nobody has been in.

import { TELECONSULT_QUEUE } from '@/data/clinical'

import { useOpd } from '../state/opd'

import { demoCode } from './demoCode'
import { useWaiting } from './waitingRoom'

let done = false

export function freshStart() {
  if (done) return
  done = true
  useOpd.getState().forget(TELECONSULT_QUEUE.map((r) => r.patientId))
  useWaiting.setState({ waiting: {} })
  demoCode()
}

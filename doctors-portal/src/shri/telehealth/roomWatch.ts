// On the hospital's own Jitsi, the server itself says who is waiting: every few
// seconds the doctor's portal asks it how many people are in each of today's
// visit rooms (`/room-size`, prosody's muc_size module, exposed by the Jitsi web
// container — deploy notes in the server's ~/setup). Someone in a visit's room
// that is not this doctor's open call is a patient waiting; an empty room is not.
// That works whatever device the patient joins from. On the public meet.jit.si
// there is no such question to ask, so it is off, and only a patient window in
// this browser (the patient portal's stand-in) tells the doctor.

import { useEffect } from 'react'

import { isPublicJitsi, jitsiDomain } from './jitsi'
import { useTele } from './teleStore'
import { roomOfVisit, VISITS } from './visits'
import { useWaiting } from './waitingRoom'

const EVERY_MS = 5000

/** How many people are in a room on the hospital's Jitsi; null where it cannot say, so nothing changes. */
async function roomSize(room: string): Promise<number | null> {
  try {
    const r = await fetch(`https://${jitsiDomain()}/room-size?room=${encodeURIComponent(room.toLowerCase())}`, { cache: 'no-store' })
    if (r.status === 404) return 0
    if (!r.ok) return null
    const j = (await r.json()) as { participants?: unknown }
    return typeof j.participants === 'number' ? j.participants : null
  } catch {
    return null
  }
}

export function useRoomWatch() {
  useEffect(() => {
    if (isPublicJitsi()) return
    let alive = true
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        for (const v of VISITS) {
          const room = roomOfVisit(v.id)
          const tele = useTele.getState()
          // A visit whose call has ended: the patient may stay in the room for their prescription — not waiting for a call.
          const last = tele.latest[v.patientId] ? tele.sessions[tele.latest[v.patientId]] : undefined
          if (!room || tele.done[v.patientId] || last?.endedAt) {
            useWaiting.getState().leave(v.id)
            continue
          }
          const n = await roomSize(room)
          if (!alive || n === null) continue
          const mine = tele.activeSid ? useTele.getState().sessions[tele.activeSid]?.meetCode : undefined
          if (n > 0 && room !== mine) useWaiting.getState().arrive(v.id, v.patientId)
          else useWaiting.getState().leave(v.id)
        }
      } finally {
        busy = false
      }
    }
    void tick()
    const t = window.setInterval(() => void tick(), EVERY_MS)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])
}

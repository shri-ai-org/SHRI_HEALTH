/**
 * Hands a signed tele-prescription to the patient's portal page, after the call,
 * through the visit's own video room: where this page is still in the call it is
 * sent down that line; otherwise the portal joins the room quietly — no camera, no
 * microphone, nothing on screen — sends it, waits for the patient's page to say it
 * arrived, and leaves. The doctor is told either way, and the delivery is kept
 * with what was sent on their behalf (the bell). Mounted once, in the shell, so
 * it carries on while the doctor moves to the next screen.
 */

import { useEffect, useRef } from 'react'

import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { useNotifications } from '../state/notifications'

import { callLink } from './callLink'
import { JitsiRoom } from './JitsiRoom'
import { useCourier, type RxJob } from './rxCourier'

const RESEND_MS = 2000
const GIVE_UP_MS = 30_000

export function RxCourier() {
  const job = useCourier((s) => s.jobs[0])
  return job ? <Delivery key={job.rx.id} job={job} /> : null
}

function Delivery({ job }: { job: RxJob }) {
  const toast = useUI((s) => s.toast)
  const sendNotice = useNotifications((s) => s.send)
  const done = useCourier((s) => s.done)
  const me = useCurrentStaff()
  /** Already in this room's call: no need to join it again. */
  const inCall = useRef(callLink.has(job.room)).current
  const timer = useRef(0)

  useEffect(() => {
    const first = job.patientName.split(' ')[0]
    let finished = false
    const finish = (delivered: boolean) => {
      if (finished) return
      finished = true
      window.clearInterval(timer.current)
      off()
      window.clearTimeout(giveUp)
      if (delivered) {
        sendNotice({
          severity: 'routine',
          kind: 'instructions',
          recipient: 'patient',
          title: 'Tele-prescription sent',
          detail: `${job.patientName}: ${job.rx.items.join(', ')}. Delivered to the patient portal.`,
          to: `/tele/session/${job.visitId}`,
        })
        toast({ tone: 'success', title: 'Prescription delivered', detail: `${first} has it in the patient portal.` })
      } else {
        toast({
          tone: 'caution',
          title: 'Prescription not delivered to the portal',
          detail: `${first}’s patient portal page is not open, so it could not be handed over. The prescription is signed and published to ABDM.`,
        })
      }
      done(job.rx.id)
    }
    const off = callLink.on((m, room) => {
      if (room === job.room && m.k === 'rx-ack' && m.id === job.rx.id) finish(true)
    })
    const giveUp = window.setTimeout(() => finish(false), GIVE_UP_MS)
    if (inCall) start()
    return () => {
      finished = true
      window.clearInterval(timer.current)
      window.clearTimeout(giveUp)
      off()
    }
    // One delivery per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** In the room: the prescription goes out now and every two seconds, until the patient's page says it has it. */
  function start() {
    const send = () => callLink.send(job.room, { k: 'rx', rx: job.rx })
    send()
    window.clearInterval(timer.current)
    timer.current = window.setInterval(send, RESEND_MS)
  }

  if (inCall) return null
  return (
    <div aria-hidden="true" className="pointer-events-none fixed -left-[10000px] top-0 h-[240px] w-[320px] opacity-0" data-rx-courier={job.rx.id}>
      <JitsiRoom room={job.room} displayName={`${me?.name ?? 'Your doctor'} (sending your prescription)`} quiet onJoined={start} className="size-full" />
    </div>
  )
}

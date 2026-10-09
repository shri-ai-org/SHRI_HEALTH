/**
 * A patient is waiting in their video call: said across the top of every screen,
 * under the app bar, until the doctor joins or the patient leaves — who, for how
 * long, what the visit is for, and Join now, which opens the visit with the call
 * already started. The same patients the bell and Video visits show as waiting
 * (waitingRoom.ts).
 */

import { Video } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'

import { patient } from '@/data/kit'

import { cn } from '../lib/cn'
import { Icon, Pill } from '../ui/primitives'

import { visitById } from './visits'
import { waitingList, useWaiting } from './waitingRoom'

const waitedFor = (ms: number) => {
  const min = Math.floor(ms / 60_000)
  return min < 1 ? 'Waiting for less than a minute' : `Waiting for ${min} minute${min === 1 ? '' : 's'}`
}

export function WaitingBar({ className }: { className?: string }) {
  const navigate = useNavigate()
  const waiting = useWaiting(useShallow((s) => waitingList(s.waiting)))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!waiting.length) return
    const t = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(t)
  }, [waiting.length])
  if (!waiting.length) return null

  return (
    <div className={cn('flex flex-col gap-[8px]', className)} role="status" aria-live="polite">
      {waiting.map((w) => {
        const p = patient(w.patientId)
        const reason = visitById(w.visitId)?.reason
        return (
          <div key={w.visitId} className="flex flex-wrap items-center gap-[14px] rounded-[20px] bg-sh-norm-bg px-[18px] py-[12px] text-sh-norm-fg" data-waiting={w.visitId}>
            <span className="relative flex size-[40px] shrink-0 items-center justify-center rounded-full bg-sh-norm text-white" aria-hidden="true">
              <span className="absolute inset-0 rounded-full bg-sh-norm opacity-50 motion-safe:animate-ping" />
              <Icon icon={Video} size={19} className="relative" />
            </span>
            <div className="min-w-[200px] flex-1">
              <p className="text-[16px] font-semibold">{p.name} is waiting in the video call.</p>
              <p className="text-[13px] opacity-90">
                {waitedFor(now - w.since)}
                {reason ? `. The visit is for ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.` : '.'}
              </p>
            </div>
            <Pill variant="primary" size="xl" icon={Video} onClick={() => navigate(`/tele/session/${w.visitId}`, { state: { join: true } })} aria-label={`Join now: ${p.name} is waiting`}>
              Join now
            </Pill>
          </div>
        )
      })}
    </div>
  )
}

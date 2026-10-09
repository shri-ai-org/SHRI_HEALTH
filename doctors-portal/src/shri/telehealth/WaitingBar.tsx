/**
 * A patient is waiting in their video call: a floating call alert over every
 * screen, top right — who, for how long, what the visit is for — with Connect,
 * which opens the visit with the call already started, and Later, which puts the
 * alert away (the bell and the dot on Video visits still say so). It stays until
 * the doctor joins or the patient leaves. The same patients the bell and Video
 * visits show as waiting (waitingRoom.ts); the chime and the notice on this
 * computer when Shri Health is in the background are waitingAlerts.ts.
 */

import { BellRing, Video, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'

import { patient } from '@/data/kit'

import { Icon, Pill } from '../ui/primitives'

import { visitById } from './visits'
import { alertsAsked, askForAlerts } from './waitingAlerts'
import { waitingList, useWaiting } from './waitingRoom'

const waitedFor = (ms: number) => {
  const min = Math.floor(ms / 60_000)
  return min < 1 ? 'Waiting for less than a minute' : `Waiting for ${min} minute${min === 1 ? '' : 's'}`
}

export function WaitingBar() {
  const navigate = useNavigate()
  const waiting = useWaiting(useShallow((s) => waitingList(s.waiting)))
  const [now, setNow] = useState(() => Date.now())
  /** Alerts put away with Later, by visit and arrival — a new arrival alerts again. */
  const [later, setLater] = useState<string[]>([])
  const [asked, setAsked] = useState(alertsAsked)
  useEffect(() => {
    if (!waiting.length) return
    const t = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(t)
  }, [waiting.length])
  const shown = waiting.filter((w) => !later.includes(`${w.visitId}@${w.since}`))

  return (
    <div
      className="pointer-events-none fixed right-[max(26px,var(--sa-r))] top-[calc(var(--shell-pt)_+_78px)] z-[45] flex w-[min(440px,calc(100vw_-_32px))] flex-col gap-[10px] max-sm:left-[16px] max-sm:right-[16px] max-sm:top-[calc(var(--sa-t,0px)_+_76px)] max-sm:w-auto"
      role="status"
      aria-live="assertive"
    >
      <AnimatePresence initial={false}>
        {shown.map((w) => {
          const p = patient(w.patientId)
          const reason = visitById(w.visitId)?.reason
          return (
            <motion.div
              key={`${w.visitId}@${w.since}`}
              initial={{ opacity: 0, y: -12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.98 }}
              transition={{ duration: 0.18 }}
              className="pointer-events-auto rounded-[22px] bg-sh-card p-[16px] text-sh-text shadow-sh-pop ring-2 ring-sh-norm"
              data-waiting={w.visitId}
            >
              <div className="flex items-start gap-[12px]">
                <span className="relative flex size-[44px] shrink-0 items-center justify-center rounded-full bg-sh-norm text-white" aria-hidden="true">
                  <span className="absolute inset-0 rounded-full bg-sh-norm opacity-50 motion-safe:animate-ping" />
                  <Icon icon={Video} size={20} className="relative" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-semibold">{p.name} is waiting in the video call.</p>
                  <p className="mt-[2px] text-[13px] text-sh-text-2">
                    {waitedFor(now - w.since)}
                    {reason ? `. The visit is for ${reason.charAt(0).toLowerCase()}${reason.slice(1)}.` : '.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setLater((l) => [...l, `${w.visitId}@${w.since}`])}
                  aria-label={`Later: put away the alert for ${p.name}`}
                  title="Later. The bell and Video visits still show it."
                  className="-mr-[6px] -mt-[6px] flex size-[36px] shrink-0 items-center justify-center rounded-full text-sh-text-3 hover:bg-sh-hover hover:text-sh-text"
                >
                  <Icon icon={X} size={16} />
                </button>
              </div>
              <div className="mt-[12px] flex flex-wrap items-center gap-[10px]">
                <Pill variant="accent" size="xl" icon={Video} onClick={() => navigate(`/tele/session/${w.visitId}`, { state: { join: true } })} aria-label={`Connect: ${p.name} is waiting`}>
                  Connect
                </Pill>
                {!asked && (
                  <button
                    type="button"
                    onClick={() => void askForAlerts().then(() => setAsked(true))}
                    className="inline-flex items-center gap-[6px] text-[13px] text-sh-text-2 underline underline-offset-2 hover:text-sh-text"
                  >
                    <Icon icon={BellRing} size={14} />
                    Alert me when Shri Health is in the background
                  </button>
                )}
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}

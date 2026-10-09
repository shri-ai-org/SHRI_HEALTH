/**
 * `/demo/patient` — a stand-in for the patient portal, for demonstrations, until
 * the real portal exists. The patient picks their video visit and joins it: they
 * are in the visit's own room (visits.roomOfVisit, the same one the doctor's page
 * opens), waiting, and the doctor is told on every screen at once (waitingRoom.ts).
 * When the doctor comes in, the patient sees them large and themselves small in a
 * corner — the same video card the doctor has (JitsiRoom).
 *
 * The waiting notice reaches a doctor in another window of this browser; across
 * devices the backend will carry it. The video itself works between any two
 * devices, since both sides open the same room.
 *
 * Outside the doctor's shell: no sidebar, no doctor's tools.
 */

import { ArrowLeft, PhoneOff, Video } from 'lucide-react'
import { useEffect, useState } from 'react'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'

import { Avatar, Card, Icon, Pill } from '../ui/primitives'

import { JitsiRoom } from './JitsiRoom'
import { roomOfVisit, visitById, VISITS } from './visits'
import { useWaiting } from './waitingRoom'

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

export function PatientDemoPage() {
  const [visitId, setVisitId] = useState<string | null>(null)
  const [inCall, setInCall] = useState(false)
  const arrive = useWaiting((s) => s.arrive)
  const leave = useWaiting((s) => s.leave)
  const visit = visitId ? visitById(visitId) : undefined
  const p = visit ? patient(visit.patientId) : undefined
  const room = visitId ? roomOfVisit(visitId) : undefined
  const doctor = p?.consultant ?? 'your doctor'

  // In the room: waiting for the doctor until they come in. Leaving, or closing the window, ends the wait.
  useEffect(() => {
    if (!inCall || !visit) return
    arrive(visit.id, visit.patientId)
    const gone = () => leave(visit.id)
    window.addEventListener('pagehide', gone)
    return () => {
      window.removeEventListener('pagehide', gone)
      gone()
    }
  }, [inCall, visit, arrive, leave])

  return (
    <div className="min-h-dvh bg-sh-surface px-[max(16px,var(--sa-l))] pb-[32px] pt-[24px] text-sh-text">
      <main className="mx-auto flex w-full max-w-[1040px] flex-col gap-[16px]">
        <header className="flex flex-wrap items-center gap-[12px]">
          <span className="flex size-[40px] items-center justify-center rounded-full bg-sh-accent text-sh-accent-ink" aria-hidden="true">
            <Icon icon={Video} size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[22px] font-semibold">Patient portal</h1>
            <p className="text-[13px] text-sh-text-3">A demonstration page that stands in for the patient portal, until the real one is ready.</p>
          </div>
        </header>

        {!visit || !p ? (
          <Card>
            <h2 className="text-[18px] font-semibold">Who is joining?</h2>
            <p className="mt-[4px] text-[14px] text-sh-text-2">Pick the patient whose video visit this is. Open this page in a second window, beside the doctor’s, to see the doctor told at once.</p>
            <ul className="mt-[16px] flex flex-col gap-[10px]" aria-label="Today’s video visits">
              {VISITS.map((v) => {
                const who = patient(v.patientId)
                return (
                  <li key={v.id} className="flex flex-wrap items-center gap-[14px] rounded-[18px] bg-sh-inner px-[16px] py-[12px]">
                    <Avatar initials={initials(who.name)} size={48} variant="pend" />
                    <div className="min-w-[180px] flex-1">
                      <p className="text-[16px] font-semibold">{who.name}</p>
                      <p className="text-[13px] text-sh-text-3">
                        {formatTime(v.scheduledAt)} with {who.consultant ?? 'your doctor'} · {v.reason}
                      </p>
                    </div>
                    <Pill variant="primary" size="lg" onClick={() => setVisitId(v.id)} aria-label={`I am ${who.name}`}>
                      This is me
                    </Pill>
                  </li>
                )
              })}
            </ul>
          </Card>
        ) : !inCall ? (
          <Card className="p-[24px]">
            <button type="button" onClick={() => setVisitId(null)} className="mb-[12px] inline-flex items-center gap-[6px] self-start text-[13px] text-sh-text-2 hover:text-sh-text">
              <Icon icon={ArrowLeft} size={14} />
              Someone else
            </button>
            <h2 className="text-[20px] font-semibold">
              Your video visit with {doctor}, {p.name.split(' ')[0]}
            </h2>
            <p className="mt-[6px] text-[14px] text-sh-text-2">
              Booked for {formatTime(visit.scheduledAt)}. The visit is for {visit.reason.charAt(0).toLowerCase()}
              {visit.reason.slice(1)}.
            </p>
            <p className="mt-[6px] text-[14px] text-sh-text-2">When you join, you wait in the call, and {doctor} is told you are there. Your browser asks once for the camera and microphone.</p>
            <div className="mt-[18px]">
              <Pill variant="accent" size="xl" icon={Video} disabled={!room} onClick={() => setInCall(true)}>
                Join the video call
              </Pill>
            </div>
          </Card>
        ) : (
          <Card className="gap-[12px] p-[12px]">
            <JitsiRoom
              room={room!}
              displayName={p.name}
              waitingFor={`Waiting for ${doctor}. They have been told you are here.`}
              onOthers={(n) => n > 0 && leave(visit.id)}
              onLeft={() => setInCall(false)}
              className="aspect-video w-full"
            />
            <div className="flex flex-wrap items-center gap-[12px] px-[8px] pb-[4px]">
              <p className="min-w-[200px] flex-1 text-[14px] text-sh-text-2">You are in your video visit with {doctor}.</p>
              <Pill variant="crit" size="xl" icon={PhoneOff} onClick={() => setInCall(false)}>
                Leave the call
              </Pill>
            </div>
          </Card>
        )}
      </main>
    </div>
  )
}

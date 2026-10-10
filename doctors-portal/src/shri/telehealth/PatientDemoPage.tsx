/**
 * `/demo/patient` — a stand-in for the patient portal, for demonstrations, until
 * the real portal exists. The patient picks their video visit, types the
 * demonstration code the doctor's screen shows (demoCode.ts — new on every load
 * of the doctor's portal, so each demonstration has rooms of its own), and connects:
 *
 *   waiting     in the visit's room for that code (visits.roomOfVisit, the same
 *               one the doctor's page opens); the doctor is told on every screen
 *               (waitingRoom.ts in this browser, the room count on any device);
 *   in the call the doctor large, the patient small in a corner (JitsiRoom); while
 *               the doctor records, this browser writes down what the patient
 *               says and sends it to the doctor line by line (callLink.ts), and
 *               the page says so;
 *   after       the doctor — whoever the patient first met in the call — has left
 *               (someone else coming or going does not end it): the camera and microphone off, the page
 *               stays in the room so the signed prescription can reach it
 *               (RxCourier), shows it, and tells the doctor it arrived.
 *
 * Outside the doctor's shell: no sidebar, no doctor's tools.
 */

import { ArrowLeft, Mic, PhoneOff, Pill as PillIcon, Video } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'

import { cn } from '../lib/cn'
import { Avatar, Card, Icon, Pill } from '../ui/primitives'

import { callLink, type SentRx } from './callLink'
import { lastDemoCode } from './demoCode'
import { JitsiRoom } from './JitsiRoom'
import { speechLoop, speechSupported, type SpeechLoop } from './speechLoop'
import { roomOfVisit, visitById, VISITS } from './visits'
import { useWaiting } from './waitingRoom'

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

type Phase = 'waiting' | 'connected' | 'ended'

export function PatientDemoPage() {
  const [visitId, setVisitId] = useState<string | null>(null)
  const [inCall, setInCall] = useState(false)
  /** The doctor's screen shows it; a doctor's page in this browser has already left it here. */
  const [code, setCode] = useState(lastDemoCode)
  const visit = visitId ? visitById(visitId) : undefined
  const p = visit ? patient(visit.patientId) : undefined
  const room = visitId && /^\d{4}$/.test(code) ? roomOfVisit(visitId, code) : undefined
  const doctor = p?.consultant ?? 'your doctor'

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
            <h2 className="text-[18px] font-semibold">Who is connecting?</h2>
            <p className="mt-[4px] text-[14px] text-sh-text-2">Pick the patient whose video visit this is. Open this page on another computer or phone, or in a second window, to see the doctor told at once.</p>
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
        ) : !inCall || !room ? (
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
            <p className="mt-[6px] text-[14px] text-sh-text-2">When you connect, you wait in the call, and {doctor} is told you are there. Your browser asks once for the camera and microphone.</p>
            <label className="mt-[16px] flex flex-col gap-[6px] text-[14px] font-medium" htmlFor="demo-code">
              Demo code from the doctor’s screen
              <input
                id="demo-code"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="4 digits"
                className="h-[48px] w-[160px] rounded-[14px] border border-sh-line-strong bg-sh-card px-[14px] text-[20px] tracking-[0.3em] tabular-nums text-sh-text focus:border-sh-accent focus:outline-none"
              />
              <span className="text-[13px] font-normal text-sh-text-3">Video visits and the visit page show it. It changes each time the doctor’s portal is reloaded.</span>
            </label>
            <div className="mt-[18px]">
              <Pill variant="accent" size="xl" icon={Video} disabled={!room} onClick={() => setInCall(true)}>
                Connect
              </Pill>
            </div>
          </Card>
        ) : (
          <InVisit visitId={visit.id} patientId={visit.patientId} name={p.name} doctor={doctor} room={room} onLeave={() => setInCall(false)} />
        )}
      </main>
    </div>
  )
}

function InVisit({ visitId, patientId, name, doctor, room, onLeave }: { visitId: string; patientId: string; name: string; doctor: string; room: string; onLeave: () => void }) {
  const arrive = useWaiting((s) => s.arrive)
  const leave = useWaiting((s) => s.leave)
  const [phase, setPhase] = useState<Phase>('waiting')
  const [writing, setWriting] = useState<'off' | 'on' | 'unavailable'>('off')
  const [rx, setRx] = useState<SentRx | null>(null)
  const loop = useRef<SpeechLoop | null>(null)
  const phaseRef = useRef<Phase>('waiting')
  /** Whoever the patient first met in the call — the doctor. Only their leaving ends it. */
  const doctorId = useRef<string | null>(null)
  useEffect(() => {
    phaseRef.current = phase
  })

  // Waiting for the doctor until they come in; leaving, or closing the window, ends the wait.
  useEffect(() => {
    arrive(visitId, patientId)
    const gone = () => leave(visitId)
    window.addEventListener('pagehide', gone)
    return () => {
      window.removeEventListener('pagehide', gone)
      gone()
    }
  }, [visitId, patientId, arrive, leave])

  const stopWriting = () => {
    loop.current?.stop()
    loop.current = null
    setWriting('off')
  }

  // What comes over the call: write down what the patient says, or stop; the prescription.
  useEffect(() => {
    let n = 0
    const off = callLink.on((m, r) => {
      if (r !== room) return
      if (m.k === 'transcribe') {
        if (!m.on || phaseRef.current !== 'connected') {
          loop.current?.stop()
          loop.current = null
          setWriting('off')
          return
        }
        if (loop.current) return
        if (!speechSupported()) return setWriting('unavailable')
        loop.current = speechLoop({
          lang: 'en-IN',
          onFinal: (text, startMs, endMs) => callLink.send(room, { k: 'line', id: `${Date.now().toString(36)}${(n++).toString(36)}`, text, startMs, endMs }),
          onFail: () => {
            loop.current = null
            setWriting('unavailable')
          },
        })
        setWriting(loop.current ? 'on' : 'unavailable')
      }
      if (m.k === 'rx') {
        setRx(m.rx)
        callLink.send(room, { k: 'rx-ack', id: m.rx.id })
      }
    })
    return () => {
      off()
      loop.current?.stop()
      loop.current = null
    }
  }, [room])

  const onPerson = (id: string, inRoom: boolean) => {
    // After the call, someone coming in is the doctor's portal bringing the prescription — not a new call.
    if (phaseRef.current === 'ended') return
    if (inRoom && phaseRef.current === 'waiting') {
      doctorId.current = id
      leave(visitId)
      phaseRef.current = 'connected'
      setPhase('connected')
    } else if (!inRoom && id === doctorId.current) {
      stopWriting()
      phaseRef.current = 'ended'
      setPhase('ended')
    }
  }

  const ended = phase === 'ended'
  return (
    <div className="flex flex-col gap-[16px]">
      <Card className={cn('gap-[12px] p-[12px]', ended && 'p-0')}>
        <JitsiRoom
          room={room}
          displayName={name}
          waitingFor={`Waiting for ${doctor}. They have been told you are here.`}
          muted={ended}
          onPerson={onPerson}
          onLeft={onLeave}
          className={ended ? 'pointer-events-none fixed -left-[10000px] top-0 h-[240px] w-[320px] opacity-0' : 'aspect-video w-full'}
        />
        {!ended && (
          <div className="flex flex-wrap items-center gap-[12px] px-[8px] pb-[4px]">
            <p className="min-w-[200px] flex-1 text-[14px] text-sh-text-2">
              {phase === 'connected' ? `You are in your video visit with ${doctor}.` : `You are waiting for ${doctor}.`}
            </p>
            <Pill variant="crit" size="xl" icon={PhoneOff} onClick={onLeave}>
              Leave the call
            </Pill>
          </div>
        )}
        {!ended && writing !== 'off' && (
          <p
            className={cn('mx-[8px] mb-[4px] flex items-start gap-[8px] rounded-[12px] px-[12px] py-[10px] text-[14px]', writing === 'on' ? 'bg-sh-accent-soft text-sh-text' : 'bg-sh-warn-bg text-sh-warn-fg')}
            data-writing={writing}
          >
            <Icon icon={Mic} size={16} className="mt-[2px] shrink-0" />
            {writing === 'on'
              ? `${doctor} is recording this visit, as you agreed. What you say is written down and sent to them.`
              : `This browser cannot write down what you say. ${doctor} still hears you, and the visit is still recorded.`}
          </p>
        )}
      </Card>

      {ended && (
        <Card className="p-[24px]" data-after-call="">
          <h2 className="text-[20px] font-semibold">Your call with {doctor} has ended.</h2>
          <p className="mt-[6px] text-[14px] text-sh-text-2">
            {rx ? 'Your prescription is below.' : 'Keep this page open. If your doctor writes you a prescription, it comes here.'} Your camera and microphone are off.
          </p>
          <div className="mt-[14px]">
            <Pill variant="control" size="lg" icon={PhoneOff} onClick={onLeave}>
              Close the visit
            </Pill>
          </div>
        </Card>
      )}

      {rx && (
        <Card className="p-[24px]" data-rx={rx.id}>
          <div className="flex items-center gap-[12px]">
            <span className="flex size-[44px] items-center justify-center rounded-full bg-sh-norm-bg text-sh-norm-fg" aria-hidden="true">
              <Icon icon={PillIcon} size={20} />
            </span>
            <div>
              <h2 className="text-[18px] font-semibold">Your prescription from {rx.doctor}</h2>
              <p className="text-[13px] text-sh-text-3">
                Signed at {formatTime(new Date(rx.signedAt))}, after a {rx.mode === 'video' ? 'video' : 'telephone'} consultation.
              </p>
            </div>
          </div>
          <ul className="mt-[14px] flex flex-col gap-[8px]">
            {rx.items.map((item) => (
              <li key={item} className="rounded-[14px] bg-sh-inner px-[14px] py-[10px] text-[15px] font-medium">
                {item}
              </li>
            ))}
          </ul>
          <p className="mt-[12px] text-[13px] text-sh-text-3">The signed prescription is also printed with the doctor’s registration number and published to ABDM.</p>
        </Card>
      )}
    </div>
  )
}

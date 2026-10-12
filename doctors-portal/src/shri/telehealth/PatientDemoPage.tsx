/**
 * `/demo/patient` — a stand-in for the patient portal, for demonstrations, until
 * the real portal exists. The patient picks their video visit, types the
 * demonstration code the doctor's screen shows (demoCode.ts — new on every load
 * of the doctor's portal, so each demonstration has rooms of its own; the page
 * hears it from the doctors' portals open right now, CodeBeacon, and fills it in),
 * and connects:
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
 *               (RxCourier), shows it, and tells the doctor it arrived. The doctor
 *               coming back in is a new call: camera and microphone on again.
 *               Close the visit goes back to the list of visits.
 *
 * Outside the doctor's shell: no sidebar, no doctor's tools.
 */

import { ArrowLeft, CheckCircle2, Loader, Mic, PhoneOff, Pill as PillIcon, Video } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'

import { cn } from '../lib/cn'
import { Avatar, Card, Icon, Pill } from '../ui/primitives'

import { callLink, type SentRx } from './callLink'
import { DIRECTORY_ROOM, lastDemoCode } from './demoCode'
import { isPublicJitsi } from './jitsi'
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

/** 4:05, or 1:02:05 — how long the call has run. */
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(s / 60) % 60).padStart(s >= 3600 ? 2 : 1, '0')
  return `${s >= 3600 ? `${Math.floor(s / 3600)}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`
}
const lasted = (ms: number) => {
  const min = Math.round(ms / 60_000)
  return min < 1 ? 'less than a minute' : `${min} minute${min === 1 ? '' : 's'}`
}

interface HeardCode {
  code: string
  doctor: string
  /** When the doctor's portal made it. */
  at: number
  /** When it was last heard; a portal closed or reloaded stops being heard. */
  heard: number
}

/** The codes doctors' portals are saying right now, newest first — heard in the demo directory room. */
function useDoctorCodes(listen: boolean): HeardCode[] {
  const [codes, setCodes] = useState<HeardCode[]>([])
  useEffect(() => {
    if (!listen) return
    const seen = new Map<string, HeardCode>()
    const show = () => setCodes([...seen.values()].filter((c) => Date.now() - c.heard < 12_000).sort((a, b) => b.at - a.at))
    const off = callLink.on((m, room) => {
      // Four digits, made no later than now: a code claiming the future cannot jump to the top.
      if (room !== DIRECTORY_ROOM || m.k !== 'code' || !/^\d{4}$/.test(m.code) || !(m.at <= Date.now() + 60_000)) return
      seen.set(m.code, { code: m.code, doctor: m.doctor, at: m.at, heard: Date.now() })
      show()
    })
    const t = window.setInterval(show, 2000)
    return () => {
      off()
      window.clearInterval(t)
    }
  }, [listen])
  return listen ? codes : []
}

export function PatientDemoPage() {
  const [visitId, setVisitId] = useState<string | null>(null)
  const [inCall, setInCall] = useState(false)
  /** The visit just closed, said above the list. */
  const [closed, setClosed] = useState<string | null>(null)
  /** The doctor's screen shows it; a doctor's page in this browser has already left it here. */
  const [typed, setCode] = useState(lastDemoCode)
  /** The patient typed or picked a code themselves: leave it as it is. */
  const [chose, setChose] = useState(false)
  const listening = !inCall && !isPublicJitsi()
  const heard = useDoctorCodes(listening)
  // The newest code from a doctor's screen, until the patient chooses otherwise.
  const code = chose ? typed : (heard[0]?.code ?? typed)
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
            {closed && (
              <p className="mt-[10px] flex items-center gap-[8px] rounded-[14px] bg-sh-norm-bg px-[14px] py-[10px] text-[14px] text-sh-norm-fg" data-closed-visit="">
                <Icon icon={CheckCircle2} size={16} />
                {closed}
              </p>
            )}
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
                    <Pill variant="primary" size="lg" onClick={() => {
                        setClosed(null)
                        setVisitId(v.id)
                      }} aria-label={`I am ${who.name}`}>
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
                onChange={(e) => {
                  setChose(true)
                  setCode(e.target.value.replace(/\D/g, '').slice(0, 4))
                }}
                placeholder="4 digits"
                className="h-[48px] w-[160px] rounded-[14px] border border-sh-line-strong bg-sh-card px-[14px] text-[20px] tracking-[0.3em] tabular-nums text-sh-text focus:border-sh-accent focus:outline-none"
              />
              <span className="text-[13px] font-normal text-sh-text-3">Video visits and the visit page show it. It changes each time the doctor’s portal is reloaded.</span>
            </label>
            {listening && heard.length === 0 && (
              <p className="mt-[12px] text-[13px] text-sh-text-3" data-heard-codes="">
                Looking for the code on the doctor’s screen. It appears here by itself within about half a minute; you can also type it.
              </p>
            )}
            {heard.length > 0 && (
              <div className="mt-[12px]" data-heard-codes={heard.map((h) => h.code).join(',')}>
                <p className="text-[13px] text-sh-text-2">Codes on doctors’ screens right now. The newest is filled in; tap another to use it.</p>
                <div className="mt-[8px] flex flex-wrap gap-[8px]">
                  {heard.map((h) => (
                    <button
                      key={h.code}
                      type="button"
                      onClick={() => {
                        setChose(true)
                        setCode(h.code)
                      }}
                      aria-pressed={code === h.code}
                      className={cn(
                        'rounded-[14px] border px-[12px] py-[8px] text-left text-[13px]',
                        code === h.code ? 'border-sh-accent bg-sh-accent-soft text-sh-text' : 'border-sh-line text-sh-text-2 hover:bg-sh-hover',
                      )}
                    >
                      <span className="block text-[17px] font-semibold tracking-[0.2em] tabular-nums text-sh-text">{h.code}</span>
                      {h.doctor} · made at {formatTime(new Date(h.at))}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-[18px]">
              <Pill variant="accent" size="xl" icon={Video} disabled={!room}
                onClick={() => {
                  // The code is fixed as connected: the room stays the same for the whole call.
                  setCode(code)
                  setChose(true)
                  setInCall(true)
                }}
              >
                Connect
              </Pill>
            </div>
          </Card>
        ) : (
          <InVisit
            visitId={visit.id}
            patientId={visit.patientId}
            name={p.name}
            doctor={doctor}
            room={room}
            onLeave={() => setInCall(false)}
            onClose={() => {
              setInCall(false)
              setVisitId(null)
              setClosed(`Your video visit with ${doctor} is closed.`)
            }}
          />
        )}
      </main>
      {/* Listening, out of sight, for the codes doctors' portals are saying. */}
      {listening && (
        <div aria-hidden="true" className="pointer-events-none fixed -left-[10000px] top-0 h-[240px] w-[320px] opacity-0">
          <JitsiRoom room={DIRECTORY_ROOM} displayName="Patient demo page" quiet className="size-full" />
        </div>
      )}
    </div>
  )
}

function InVisit({
  visitId,
  patientId,
  name,
  doctor,
  room,
  onLeave,
  onClose,
}: {
  visitId: string
  patientId: string
  name: string
  doctor: string
  room: string
  onLeave: () => void
  onClose: () => void
}) {
  const arrive = useWaiting((s) => s.arrive)
  const leave = useWaiting((s) => s.leave)
  const [phase, setPhase] = useState<Phase>('waiting')
  const [writing, setWriting] = useState<'off' | 'on' | 'unavailable'>('off')
  const [rx, setRx] = useState<SentRx | null>(null)
  /** When the call with the doctor began, and ended. */
  const [span, setSpan] = useState<{ from: number; to?: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const loop = useRef<SpeechLoop | null>(null)
  const phaseRef = useRef<Phase>('waiting')
  /** Whoever the patient first met in the call — the doctor. Only their leaving ends it. */
  const doctorId = useRef<string | null>(null)
  useEffect(() => {
    phaseRef.current = phase
  })

  // The call's clock, while it runs.
  useEffect(() => {
    if (phase !== 'connected') return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [phase])

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
        let lastPartial = 0
        loop.current = speechLoop({
          lang: 'en-IN',
          onFinal: (text, startMs, endMs) => callLink.send(room, { k: 'line', id: `${Date.now().toString(36)}${(n++).toString(36)}`, text, startMs, endMs }),
          // The words being heard, at most every 300 ms, so the doctor reads them as they are said.
          onInterim: (text) => {
            if (text && Date.now() - lastPartial < 300) return
            lastPartial = Date.now()
            callLink.send(room, { k: 'partial', text })
          },
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

  const onPerson = (id: string, inRoom: boolean, who = '') => {
    // The doctor's portal bringing the prescription after the call is not the doctor.
    if (inRoom && who.includes('sending your prescription')) return
    if (inRoom && phaseRef.current !== 'connected') {
      // The doctor came in — at first, or calling back after the call.
      doctorId.current = id
      leave(visitId)
      phaseRef.current = 'connected'
      setPhase('connected')
      setSpan({ from: Date.now() })
      setNow(Date.now())
    } else if (!inRoom && id === doctorId.current && phaseRef.current === 'connected') {
      stopWriting()
      phaseRef.current = 'ended'
      setPhase('ended')
      setSpan((x) => (x ? { ...x, to: Date.now() } : x))
    }
  }

  const ended = phase === 'ended'
  return (
    <div className="flex flex-col gap-[16px]">
      {/* After the call the room stays, out of sight, so the prescription can still arrive. */}
      <div className={ended ? 'contents' : 'flex flex-col gap-[12px] rounded-sh-card bg-sh-card p-[12px] text-sh-text'} data-call-card={phase}>
        {!ended && (
          <div className="flex flex-wrap items-center gap-[12px] px-[8px] pt-[4px]">
            <span className="relative flex size-[10px] shrink-0" aria-hidden="true">
              <span className={cn('absolute inset-0 rounded-full', phase === 'connected' ? 'bg-sh-norm' : 'bg-sh-warn')} />
              {phase === 'waiting' && <span className="absolute inset-0 rounded-full bg-sh-warn opacity-60 motion-safe:animate-ping" />}
            </span>
            <p className="min-w-0 flex-1 text-[15px] font-semibold" data-call-status="">
              {phase === 'connected' ? `In your video visit with ${doctor}` : `Your video visit with ${doctor}`}
              {phase === 'connected' && span && (
                <span className="ml-[10px] font-normal tabular-nums text-sh-text-3" data-call-clock="">
                  {clock(now - span.from)}
                </span>
              )}
            </p>
            <Pill variant="crit" size="lg" icon={PhoneOff} onClick={onLeave}>
              Leave the call
            </Pill>
          </div>
        )}
        <JitsiRoom
          room={room}
          displayName={name}
          waitingFor={`Waiting for ${doctor}. They have been told you are here.`}
          muted={ended}
          onPerson={onPerson}
          onLeft={() => (phaseRef.current === 'ended' ? onClose() : onLeave())}
          className={
            ended
              ? 'pointer-events-none fixed -left-[10000px] top-0 h-[240px] w-[320px] opacity-0'
              : 'aspect-video w-full max-sm:aspect-auto max-sm:h-[min(68dvh,620px)]'
          }
        />
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
      </div>

      {ended && (
        <Card className="p-[24px]" data-after-call="">
          <div className="flex flex-wrap items-center gap-[14px]">
            <span className="flex size-[48px] shrink-0 items-center justify-center rounded-full bg-sh-norm-bg text-sh-norm-fg" aria-hidden="true">
              <Icon icon={CheckCircle2} size={24} />
            </span>
            <div className="min-w-[200px] flex-1">
              <h2 className="text-[20px] font-semibold">Visit finished</h2>
              <p className="mt-[2px] text-[14px] text-sh-text-2" data-call-length="">
                Your call with {doctor} lasted {lasted(span?.to && span.from ? span.to - span.from : 0)}. Your camera and microphone are off.
              </p>
            </div>
            <Pill variant="control" size="lg" onClick={onClose}>
              Close the visit
            </Pill>
          </div>
          {!rx && (
            <p className="mt-[16px] flex items-start gap-[10px] rounded-[14px] bg-sh-inner px-[14px] py-[12px] text-[14px] text-sh-text-2" data-rx-waiting="">
              <Icon icon={Loader} size={16} className="mt-[2px] shrink-0 motion-safe:animate-spin" />
              Waiting for your prescription. If {doctor} writes you one, it appears here; keep this page open. If {doctor} calls you back, the call starts here by itself.
            </p>
          )}
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

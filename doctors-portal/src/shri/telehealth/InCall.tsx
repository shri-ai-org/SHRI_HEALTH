/**
 * During the call, in two parts of the visit page:
 *
 *   CallBar    across the top: who the call is with, for how long and whether
 *              they have joined, with Start recording and End call;
 *   CallVideo  the video card, left of the record: the visit's Jitsi room with
 *              the patient filling it and the doctor small in a corner, and
 *              under it, while it records, who is being heard.
 *
 * Recording is one button — the patient agreed in the patient portal — and the
 * browser asks once to share this tab. Where the patient declined, or has not
 * answered, the button is not offered and the page says why.
 */

import { AlertTriangle, CheckCircle2, Circle, Info, Loader, Mic, PhoneOff, Square, Volume2, XCircle, type LucideIcon } from 'lucide-react'
import { useEffect, useState, type RefObject } from 'react'

import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { Card, Icon, Pill } from '../ui/primitives'

import { captureSupported, startCapture, stopCapture } from './capture'
import { JitsiRoom } from './JitsiRoom'
import { isBrave, useSpeechCheck, type SpeechState } from './speechCheck'
import { consentOf, useTele, type ChannelState } from './teleStore'
import type { Speaker } from './teleTypes'
import { ConsentLine } from './VisitSetup'

const clock = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:` : '') + `${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

const HEARD: Record<ChannelState, string> = { off: 'not heard', connecting: 'connecting…', live: 'being heard', browser: 'being heard (English only)', error: 'stopped' }

function Heard({ speaker, label, icon }: { speaker: Speaker; label: string; icon: typeof Mic }) {
  const state = useTele((s) => s.live?.channels[speaker] ?? 'off')
  const lvl = useTele((s) => s.live?.levels[speaker] ?? 0)
  const on = state === 'live' || state === 'browser'
  return (
    <div className="flex items-center gap-[10px] rounded-[12px] bg-sh-inner px-[12px] py-[8px]" data-channel={speaker} data-state={state}>
      <Icon icon={icon} size={15} className={on ? 'text-sh-norm-fg' : 'text-sh-text-3'} />
      <span className="text-[14px] font-medium">{label}</span>
      <span className="flex h-[14px] items-end gap-[2px]" aria-hidden="true">
        {[0.08, 0.2, 0.35, 0.55, 0.75].map((t) => (
          <span key={t} className={cn('w-[3px] rounded-[2px]', lvl > t && on ? 'bg-sh-norm' : 'bg-sh-line-strong')} style={{ height: `${5 + t * 12}px` }} />
        ))}
      </span>
      <span className={cn('text-[13px]', state === 'error' ? 'text-sh-warn-fg' : 'text-sh-text-3')}>{HEARD[state]}</span>
    </div>
  )
}

const SPEECH: Record<SpeechState, (first: string) => { icon: LucideIcon; cls: string; text: string }> = {
  checking: () => ({ icon: Loader, cls: 'text-sh-text-3', text: 'Checking the live transcript…' }),
  ready: (f) => ({ icon: CheckCircle2, cls: 'text-sh-norm-fg', text: `The live transcript is ready. Shri will write down what you and ${f} say, in Tamil and English.` }),
  busy: () => ({ icon: AlertTriangle, cls: 'text-sh-warn-fg', text: 'The speech service is busy with other doctors. You can start; the words follow as soon as it is free.' }),
  browser: (f) => ({
    icon: Info,
    cls: 'text-sh-text-3',
    text: `The browser writes down your words, in English only. ${f}’s words are not written down, but the recording keeps both voices.`,
  }),
  none: () => ({
    icon: XCircle,
    cls: 'text-sh-crit-fg',
    text: `${isBrave() ? 'Brave blocks speech-to-text' : 'This browser cannot turn speech into text'}, so nothing will be written down. The video can still be recorded. Open this page in Google Chrome or Microsoft Edge to have your words written down.`,
  }),
}

/** Across the top of the visit page, for as long as the call is open. */
export function CallBar({
  sid,
  patientId,
  firstName,
  startedAt,
  others,
  videoBox,
  onEnd,
}: {
  sid: string
  patientId: string
  firstName: string
  startedAt: number
  /** How many other people are in the room. */
  others: number
  /** The video's box — what a recording is cropped to. */
  videoBox: RefObject<HTMLDivElement | null>
  /** End call: asks first. */
  onEnd: () => void
}) {
  const toast = useUI((s) => s.toast)
  const consent = useTele((s) => consentOf(s, patientId))
  const live = useTele((s) => (s.live?.sid === sid ? s.live : undefined))
  const [starting, setStarting] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  async function record() {
    setStarting(true)
    try {
      await startCapture(sid, { cropTo: videoBox.current ?? undefined })
    } catch (e) {
      toast({ tone: 'caution', title: 'Recording did not start', detail: (e as Error).message })
    } finally {
      setStarting(false)
    }
  }

  const callSec = Math.max(0, Math.floor((now - startedAt) / 1000))
  const recSec = live ? Math.max(0, Math.floor((now - live.startedAt) / 1000)) : 0
  const canRecord = consent === 'given' && captureSupported()

  return (
    <Card className="flex-row flex-wrap items-center gap-[12px] px-[20px] py-[14px]">
      <span className="relative flex size-[12px]" aria-hidden="true">
        <span className="absolute inline-flex size-full rounded-full bg-sh-norm opacity-60 motion-safe:animate-ping" />
        <span className="relative inline-flex size-[12px] rounded-full bg-sh-norm" />
      </span>
      <div className="min-w-[220px] flex-1">
        <p className="text-[18px] font-semibold">In call with {firstName}</p>
        <p className="text-[13px] tabular-nums text-sh-text-3" data-call-clock data-joined={others > 0 || undefined}>
          {clock(callSec)} · {others > 0 ? `${firstName} is connected` : `Waiting for ${firstName} to connect from the patient portal`}
        </p>
      </div>
      {live ? (
        <span className="flex items-center gap-[10px]">
          <span className="flex items-center gap-[8px] text-[15px] font-semibold text-sh-crit-fg">
            <Icon icon={Circle} size={11} className={cn('fill-current', live.recording === 'recording' && 'motion-safe:animate-pulse')} />
            {live.recording === 'finalising' ? 'Saving…' : 'Recording'}
            <span className="font-normal tabular-nums text-sh-text-2">{clock(recSec)}</span>
          </span>
          <Pill variant="control" size="xl" icon={Square} disabled={live.recording === 'finalising'} onClick={() => void stopCapture()}>
            Stop recording
          </Pill>
        </span>
      ) : (
        canRecord && (
          <Pill variant="primary" size="xl" icon={starting ? Loader : Circle} disabled={starting} onClick={() => void record()}>
            {starting ? 'Starting…' : 'Start recording'}
          </Pill>
        )
      )}
      <Pill variant="crit" size="xl" icon={PhoneOff} onClick={onEnd}>
        End call
      </Pill>
    </Card>
  )
}

/** The video card: the patient large, the doctor small in a corner; under it, who is heard, or why recording is not offered. */
export function CallVideo({
  sid,
  patientId,
  firstName,
  room,
  doctorName,
  videoBox,
  onOthers,
  onLeftRoom,
}: {
  sid: string
  patientId: string
  firstName: string
  room: string
  doctorName: string
  videoBox: RefObject<HTMLDivElement | null>
  onOthers: (n: number) => void
  /** The doctor left from inside the video itself. */
  onLeftRoom: () => void
}) {
  const consent = useTele((s) => consentOf(s, patientId))
  const live = useTele((s) => (s.live?.sid === sid ? s.live : undefined))
  const speech = useSpeechCheck(!live && consent === 'given')
  const sp = SPEECH[speech](firstName)

  return (
    <Card className="gap-0 p-[12px]">
      <JitsiRoom room={room} displayName={doctorName} waitingFor={`Waiting for ${firstName} to connect`} onOthers={onOthers} onLeft={onLeftRoom} boxRef={videoBox} className="aspect-video w-full" />

      <div className="px-[8px] pb-[4px] pt-[14px]">
        {live ? (
          <div className="flex flex-col gap-[10px]">
            <div className="flex flex-wrap gap-[8px]">
              <Heard speaker="doctor" label="You" icon={Mic} />
              <Heard speaker="patient" label={firstName} icon={Volume2} />
            </div>
            {live.notices.map((n) => (
              <p key={n} className="flex gap-[8px] rounded-[12px] bg-sh-warn-bg px-[12px] py-[8px] text-[13px] text-sh-warn-fg">
                <Icon icon={AlertTriangle} size={14} className="mt-[2px] shrink-0" />
                {n}
              </p>
            ))}
          </div>
        ) : consent !== 'given' ? (
          <ConsentLine consent={consent} firstName={firstName} />
        ) : !captureSupported() ? (
          <p className="text-[14px] text-sh-warn-fg">This browser cannot record. Open this page in Google Chrome or Microsoft Edge.</p>
        ) : (
          <div className="flex flex-col gap-[8px]">
            <p className="text-[14px] text-sh-text-2">
              {firstName} agreed to recording in the patient portal. When you press Start recording, Chrome asks once to share this tab with its sound: click Allow. The video and
              both voices are recorded, and the conversation is written down as it is said.
            </p>
            <p className={cn('flex items-start gap-[8px] rounded-[12px] bg-sh-inner px-[12px] py-[10px] text-[13px]', sp.cls)} data-speech={speech}>
              <Icon icon={sp.icon} size={15} className={cn('mt-[1px] shrink-0', speech === 'checking' && 'motion-safe:animate-spin')} />
              {sp.text}
            </p>
          </div>
        )}
      </div>
    </Card>
  )
}

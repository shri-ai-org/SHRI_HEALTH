/**
 * During the call: one bar that says who the call is with and for how long,
 * with Open video (back to the Meet tab) and End call; under it, the recording —
 * off until the patient has agreed and the doctor presses Start recording, with
 * the three clicks Chrome's share window needs written out beside the button.
 */

import { AlertTriangle, CheckCircle2, Circle, Loader, Mic, PhoneOff, Square, Type, Video, Volume2, XCircle, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { Card, Icon, Pill } from '../ui/primitives'

import { captureSupported, startCapture, stopCapture } from './capture'
import { openMeet } from './meet'
import { isBrave, useSpeechCheck, type SpeechState } from './speechCheck'
import { consentOf, useTele, type ChannelState } from './teleStore'
import type { Speaker } from './teleTypes'
import { ConsentButtons } from './VisitSetup'

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
  ready: (f) => ({ icon: CheckCircle2, cls: 'text-sh-norm-fg', text: `Live transcript ready — Shri will write down what you and ${f} say, in Tamil and English.` }),
  busy: () => ({ icon: AlertTriangle, cls: 'text-sh-warn-fg', text: 'The speech service is busy with other doctors. You can start; the words follow as soon as it is free.' }),
  browser: (f) => ({
    icon: AlertTriangle,
    cls: 'text-sh-warn-fg',
    text: `The Shri speech service is not running, so only your own words — in English — can be written down, not ${f}’s. Ask IT to start the Shri speech service.`,
  }),
  none: () => ({
    icon: XCircle,
    cls: 'text-sh-crit-fg',
    text: `Nothing can be written down: the Shri speech service is not running${isBrave() ? ', and Brave blocks the browser’s own speech-to-text' : ''}. The video can still be recorded. Ask IT to start the speech service${isBrave() ? ', or open this page in Google Chrome' : ''}.`,
  }),
}

export function InCall({ sid, patientId, firstName, meetUri, startedAt, onEnd }: { sid: string; patientId: string; firstName: string; meetUri?: string; startedAt: number; onEnd: () => void }) {
  const toast = useUI((s) => s.toast)
  const consent = useTele((s) => consentOf(s, patientId))
  const live = useTele((s) => (s.live?.sid === sid ? s.live : undefined))
  const [starting, setStarting] = useState<'video' | 'text' | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  async function start(mode: 'video' | 'text') {
    setStarting(mode)
    try {
      await startCapture(sid, { textOnly: mode === 'text' })
    } catch (e) {
      toast({ tone: 'caution', title: mode === 'text' ? 'The live transcript did not start' : 'Recording did not start', detail: (e as Error).message })
    } finally {
      setStarting(null)
    }
  }

  const callSec = Math.max(0, Math.floor((now - startedAt) / 1000))
  const recSec = live ? Math.max(0, Math.floor((now - live.startedAt) / 1000)) : 0
  const speech = useSpeechCheck(!live && consent === 'given')
  const sp = SPEECH[speech](firstName)

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center gap-[12px] px-[20px] py-[16px]">
        <span className="relative flex size-[12px]" aria-hidden="true">
          <span className="absolute inline-flex size-full rounded-full bg-sh-norm opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex size-[12px] rounded-full bg-sh-norm" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[18px] font-semibold">In call with {firstName}</p>
          <p className="text-[13px] tabular-nums text-sh-text-3" data-call-clock>
            {clock(callSec)} · video is in the Google Meet tab
          </p>
        </div>
        {meetUri && (
          <Pill variant="control" size="lg" icon={Video} onClick={() => openMeet(meetUri)}>
            Open video
          </Pill>
        )}
        <Pill variant="crit" size="lg" icon={PhoneOff} onClick={onEnd}>
          End call
        </Pill>
      </div>

      <div className="border-t border-sh-line px-[20px] py-[16px]">
        {live ? (
          <div className="flex flex-col gap-[12px]">
            <div className="flex flex-wrap items-center gap-[12px]">
              <span className="flex items-center gap-[8px] text-[15px] font-semibold text-sh-crit-fg">
                <Icon icon={Circle} size={11} className={cn('fill-current', live.recording === 'recording' && 'motion-safe:animate-pulse')} />
                {live.recording === 'finalising' ? 'Saving the recording…' : live.recording === 'recording' ? 'Recording video and text' : 'Live transcript on'}
                <span className="tabular-nums font-normal text-sh-text-2">{clock(recSec)}</span>
              </span>
              <Pill variant="control" size="md" icon={Square} className="ml-auto" disabled={live.recording === 'finalising'} onClick={() => void stopCapture()}>
                {live.recording === 'off' ? 'Stop live transcript' : 'Stop recording'}
              </Pill>
            </div>
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
        ) : consent === undefined ? (
          <div className="flex flex-col gap-[10px]">
            <p className="text-[15px] font-medium">Recording is off. Ask {firstName} first: “Can we record this call?”</p>
            <ConsentButtons patientId={patientId} size="md" />
          </div>
        ) : consent === 'declined' ? (
          <p className="text-[14px] text-sh-text-2">
            Not recording — {firstName} said no.{' '}
            <button type="button" className="text-sh-text-3 underline" onClick={() => useTele.getState().setConsent(patientId, 'given')}>
              They changed their mind
            </button>
          </p>
        ) : !captureSupported() ? (
          <p className="text-[14px] text-sh-warn-fg">This browser cannot record. Open this page in Google Chrome or Microsoft Edge.</p>
        ) : (
          <div className="flex flex-wrap items-start gap-[20px]">
            <div className="flex flex-col gap-[8px]">
              <Pill variant="primary" size="xl" icon={starting === 'video' ? Loader : Circle} disabled={starting !== null} onClick={() => void start('video')}>
                {starting === 'video' ? 'Starting…' : 'Start recording'}
              </Pill>
              <Pill variant="control" size="lg" icon={starting === 'text' ? Loader : Type} disabled={starting !== null || speech === 'none'} onClick={() => void start('text')}>
                {starting === 'text' ? 'Starting…' : 'Live transcript only'}
              </Pill>
              <span className="max-w-[240px] text-[12px] text-sh-text-3">
                Start recording keeps the video and the words. Live transcript only keeps just the words, as text. {firstName} agreed to both.
              </span>
            </div>
            <ol className="flex min-w-[240px] flex-1 flex-col gap-[6px] text-[14px] text-sh-text-2" aria-label="What to click after Start recording">
              {['A window opens. Click the Google Meet tab.', 'Turn on “Also share tab audio” — so Shri hears the patient.', 'Click Share.'].map((t, i) => (
                <li key={t} className="flex items-center gap-[10px]">
                  <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-sh-inner text-[12px] font-semibold">{i + 1}</span>
                  {t}
                </li>
              ))}
            </ol>
            <p className={cn('flex w-full items-start gap-[8px] rounded-[12px] bg-sh-inner px-[12px] py-[10px] text-[13px]', sp.cls)} data-speech={speech}>
              <Icon icon={sp.icon} size={15} className={cn('mt-[1px] shrink-0', speech === 'checking' && 'motion-safe:animate-spin')} />
              {sp.text}
            </p>
          </div>
        )}
      </div>
    </Card>
  )
}

/**
 * Before the call: one card and one button. The call opens here, inside Shri
 * Health, in the visit's own private room; the patient is told to connect from the
 * patient portal. Whether the call may be recorded is the patient's answer in
 * that portal — shown here, never asked by the doctor.
 */

import { CircleCheck, CircleHelp, CircleX, Video, type LucideIcon } from 'lucide-react'

import { cn } from '../lib/cn'
import { Card, Icon, Pill } from '../ui/primitives'

import { DemoCodeNote } from './DemoCodeNote'
import { isPublicJitsi } from './jitsi'

type Consent = 'given' | 'declined' | undefined

const CONSENT: Record<'given' | 'declined' | 'none', { icon: LucideIcon; cls: string; text: (first: string) => string }> = {
  given: { icon: CircleCheck, cls: 'text-sh-norm-fg', text: (f) => `${f} agreed to recording in the patient portal. You can record the call with one click.` },
  declined: { icon: CircleX, cls: 'text-sh-crit-fg', text: (f) => `${f} declined recording in the patient portal, so this call cannot be recorded. Write your notes as usual.` },
  none: { icon: CircleHelp, cls: 'text-sh-warn-fg', text: (f) => `${f} has not answered the recording question in the patient portal yet. You can record once they agree.` },
}

export function ConsentLine({ consent, firstName, className }: { consent: Consent; firstName: string; className?: string }) {
  const c = CONSENT[consent ?? 'none']
  return (
    <p className={cn('flex items-start gap-[10px] text-[14px]', className)} data-consent={consent ?? 'none'}>
      <Icon icon={c.icon} size={17} className={cn('mt-[1px] shrink-0', c.cls)} />
      <span className="text-sh-text-2">{c.text(firstName)}</span>
    </p>
  )
}

export function VisitSetup({ firstName, consent, onStart }: { firstName: string; consent: Consent; onStart: () => void }) {
  return (
    <Card className="p-[24px]">
      <h2 className="text-[20px] font-semibold">Video visit with {firstName}</h2>
      <p className="mt-[6px] max-w-[640px] text-[14px] text-sh-text-2">
        The call opens here, inside Shri Health, in a private room for this visit. {firstName} is told to connect from the patient portal.
      </p>

      <div className="mt-[18px] rounded-[14px] bg-sh-inner px-[16px] py-[12px]">
        <p className="mb-[6px] text-[12px] font-semibold uppercase tracking-[0.06em] text-sh-text-3">Recording</p>
        <ConsentLine consent={consent} firstName={firstName} />
      </div>

      <DemoCodeNote className="mt-[14px] bg-sh-inner" />

      <div className="mt-[20px] flex flex-wrap items-center gap-[14px]">
        <Pill variant="accent" size="xl" icon={Video} onClick={onStart}>
          Connect
        </Pill>
        <span className="text-[13px] text-sh-text-3">Your browser asks once for the camera and microphone.</span>
      </div>
      {isPublicJitsi() && (
        <p className="mt-[14px] text-[12px] text-sh-text-3">
          This demo is using the public Jitsi service, which makes the first person in a call sign in, in a separate window, before the video starts. The hospital&rsquo;s own Jitsi server
          needs no sign-in, opens the video right here, and keeps every call on the hospital&rsquo;s server.
        </p>
      )}
    </Card>
  )
}

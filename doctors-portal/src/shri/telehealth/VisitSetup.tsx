/**
 * Before the call: three numbered steps, in plain words, each done when it shows
 * a tick. 1 · a Google Meet link, made here (Google sign-in) or pasted, and sent
 * to the patient — copied, or on WhatsApp. 2 · the patient's answer to "may we
 * record?". 3 · Start video call, which opens Meet in a new tab.
 */

import { Check, ClipboardPaste, Copy, ExternalLink, Loader, MessageCircle, Video, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { TextInput } from '../ui/forms'
import { Card, Icon, Pill } from '../ui/primitives'

import { createMeetSpace, googleConfigured, meetCode, meetLink, preloadGoogle } from './meet'
import { consentOf, useTele } from './teleStore'

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-[16px]" data-step={n} data-done={done || undefined}>
      <span
        className={cn(
          'flex size-[36px] shrink-0 items-center justify-center rounded-full text-[15px] font-semibold',
          done ? 'bg-sh-norm-bg text-sh-norm-fg' : 'bg-sh-inner text-sh-text-2',
        )}
        aria-hidden="true"
      >
        {done ? <Icon icon={Check} size={18} /> : n}
      </span>
      <div className="min-w-0 flex-1 pb-[4px] pt-[6px]">
        <h3 className="text-[16px] font-semibold">{title}</h3>
        <div className="mt-[10px] flex flex-col gap-[10px]">{children}</div>
      </div>
    </li>
  )
}

export function ConsentButtons({ patientId, size = 'lg' }: { patientId: string; size?: 'md' | 'lg' }) {
  const consent = useTele((s) => consentOf(s, patientId))
  const setConsent = useTele((s) => s.setConsent)
  return (
    <div className="flex flex-wrap gap-[8px]" role="group" aria-label="Permission to record">
      <Pill variant={consent === 'given' ? 'primary' : 'control'} size={size} icon={Check} aria-pressed={consent === 'given'} onClick={() => setConsent(patientId, 'given')}>
        Yes, agreed
      </Pill>
      <Pill variant={consent === 'declined' ? 'primary' : 'control'} size={size} icon={X} aria-pressed={consent === 'declined'} onClick={() => setConsent(patientId, 'declined')}>
        No
      </Pill>
    </div>
  )
}

export function VisitSetup({ patientId, firstName, doctorName, onStart }: { patientId: string; firstName: string; doctorName?: string; onStart: (uri: string) => void }) {
  const toast = useUI((s) => s.toast)
  const uri = useTele((s) => s.meetUri[patientId] ?? '')
  const setMeetUri = useTele((s) => s.setMeetUri)
  const consent = useTele((s) => consentOf(s, patientId))
  const [pasting, setPasting] = useState(false)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const code = meetCode(uri)
  const link = code ? meetLink(code) : ''

  useEffect(() => preloadGoogle(), [])

  async function create() {
    setCreating(true)
    try {
      const s = await createMeetSpace()
      setMeetUri(patientId, s.meetingUri)
      toast({ tone: 'success', title: 'Meeting link ready', detail: `Now send it to ${firstName}.` })
    } catch (e) {
      toast({ tone: 'caution', title: 'The meeting link was not made', detail: (e as Error).message })
    } finally {
      setCreating(false)
    }
  }

  const markInvited = useTele((s) => s.markInvited)

  async function copy() {
    markInvited(patientId)
    try {
      await navigator.clipboard.writeText(link)
      toast({ tone: 'success', title: 'Link copied', detail: `Paste it in a message to ${firstName}.` })
    } catch {
      toast({ tone: 'caution', title: 'Could not copy', detail: `Select the link and copy it by hand: ${link}` })
    }
  }

  const message = `Hello ${firstName}, your video visit${doctorName ? ` with ${doctorName}` : ''} is ready. Please join here: ${link}`
  const draftCode = meetCode(draft)

  return (
    <Card className="p-[24px]">
      <h2 className="text-[20px] font-semibold">Get ready for the call</h2>
      <p className="mt-[4px] text-[14px] text-sh-text-3">Three steps. Each one gets a tick when it is done.</p>

      <ol className="mt-[24px] flex flex-col gap-[28px]">
        <Step n={1} title="Meeting link" done={Boolean(code)}>
          {code ? (
            <>
              <div className="flex flex-wrap items-center gap-[10px] rounded-[14px] bg-sh-inner px-[14px] py-[10px]">
                <Icon icon={Video} size={16} className="text-sh-accent-ink" />
                <span className="min-w-0 flex-1 truncate text-[15px] font-medium" data-meet-link>
                  {link.replace('https://', '')}
                </span>
                <button type="button" className="text-[13px] text-sh-text-3 underline hover:text-sh-text" onClick={() => setMeetUri(patientId, '')}>
                  Change
                </button>
              </div>
              <div className="flex flex-wrap gap-[8px]">
                <Pill variant="control" size="lg" icon={Copy} onClick={() => void copy()}>
                  Copy link
                </Pill>
                <Pill variant="control" size="lg" icon={MessageCircle} onClick={() => {
                    markInvited(patientId)
                    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener')
                  }}
                >
                  Send on WhatsApp
                </Pill>
              </div>
              <p className="text-[13px] text-sh-text-3">Send this link to {firstName}. They open it on their phone or computer to join.</p>
            </>
          ) : (
            <>
              <div className="flex flex-wrap gap-[8px]">
                {googleConfigured() ? (
                  <Pill variant="primary" size="lg" icon={creating ? Loader : Video} disabled={creating} onClick={() => void create()}>
                    {creating ? 'Making the link…' : 'Create meeting link'}
                  </Pill>
                ) : (
                  <Pill variant="primary" size="lg" icon={ExternalLink} onClick={() => window.open('https://meet.google.com/new', '_blank', 'noopener')}>
                    Open Google Meet
                  </Pill>
                )}
                {!pasting && (
                  <Pill variant="ghost" size="lg" icon={ClipboardPaste} onClick={() => setPasting(true)}>
                    I already have a link
                  </Pill>
                )}
              </div>
              {!pasting && (
                <p className="text-[13px] text-sh-text-3">
                  {googleConfigured()
                    ? 'The first time, Google asks you to sign in. After that it is one click.'
                    : 'Google Meet makes a new meeting in a new tab. Copy its link and paste it here.'}
                </p>
              )}
              {pasting && (
                <form
                  className="flex flex-wrap gap-[8px]"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (draftCode) {
                      setMeetUri(patientId, meetLink(draftCode))
                      setPasting(false)
                      setDraft('')
                    }
                  }}
                >
                  <TextInput
                    aria-label="Meeting link"
                    autoFocus
                    className="h-[44px] min-w-[240px] flex-1 bg-sh-card"
                    placeholder="meet.google.com/abc-mnop-xyz"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                  />
                  <Pill type="submit" variant="primary" size="lg" disabled={!draftCode}>
                    Use this link
                  </Pill>
                  {draft.trim() && !draftCode && <p className="w-full text-[13px] text-sh-crit-fg">That is not a Google Meet link. It looks like meet.google.com/abc-mnop-xyz</p>}
                </form>
              )}
            </>
          )}
        </Step>

        <Step n={2} title="Permission to record" done={consent !== undefined}>
          <p className="text-[14px] text-sh-text-2">
            Ask {firstName}: <span className="font-medium text-sh-text">“Can we record this call, to keep a record of your visit?”</span>
          </p>
          <ConsentButtons patientId={patientId} />
          {consent === 'declined' && <p className="text-[13px] text-sh-text-3">That is fine. The call will not be recorded, so write your notes as usual.</p>}
        </Step>

        <Step n={3} title="Start the call" done={false}>
          <div>
            <Pill variant="accent" size="xl" icon={Video} disabled={!code} onClick={() => onStart(link)}>
              Start video call
            </Pill>
          </div>
          <p className="text-[13px] text-sh-text-3">
            {code
              ? `Google Meet opens in a new tab. When ${firstName} asks to join, click Admit. Then come back to this tab.`
              : 'First make or paste the meeting link (step 1).'}
          </p>
        </Step>
      </ol>
    </Card>
  )
}

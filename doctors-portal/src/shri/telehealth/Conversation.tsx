/**
 * The conversation, as chat bubbles: the patient on the left, the doctor on the
 * right, each with a name and the time; words still being heard show faintly as
 * the newest bubble. It follows the conversation unless the doctor scrolls up to
 * read, and says plainly where it is saved.
 */

import { Check, CloudOff, Download, Loader, MessagesSquare } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { cn } from '../lib/cn'
import { Card, Icon, Pill } from '../ui/primitives'

import { clockOf, fileStem, liveTranscriptText, saveFile, type RecordHeader } from './reconcile'
import { useTele } from './teleStore'
import type { Speaker } from './teleTypes'

function Saved({ pending }: { pending: number }) {
  const sync = useTele((s) => s.sync)
  const [icon, word, cls] =
    sync === 'syncing' || (sync === 'server' && pending)
      ? [Loader, 'Saving…', 'text-sh-text-3']
      : sync === 'server'
        ? [Check, 'Saved', 'text-sh-norm-fg']
        : [CloudOff, 'Saved on this computer only', 'text-sh-warn-fg']
  return (
    <span className={cn('inline-flex items-center gap-[4px] text-[13px]', cls)} data-saved={sync}>
      <Icon icon={icon} size={13} />
      {word}
    </span>
  )
}

function Bubble({ mine, who, at, text, faint }: { mine: boolean; who: string; at?: number; text: string; faint?: boolean }) {
  return (
    <li className={cn('flex max-w-[82%] flex-col gap-[3px]', mine ? 'items-end self-end' : 'items-start self-start')} data-speaker={mine ? 'doctor' : 'patient'} data-faint={faint || undefined}>
      <span className="px-[4px] text-[12px] text-sh-text-3">
        {who}
        {at ? ` · ${clockOf(at).slice(0, 5)}` : ''}
      </span>
      <span
        className={cn(
          'rounded-[18px] px-[14px] py-[9px] text-[15px] leading-[1.45]',
          mine ? 'rounded-br-[6px] bg-sh-accent-soft text-sh-text' : 'rounded-bl-[6px] bg-sh-inner text-sh-text',
          faint && 'italic opacity-60',
        )}
      >
        {text}
      </span>
    </li>
  )
}

export function Conversation({ sid, firstName, header, className }: { sid: string; firstName: string; header: RecordHeader; className?: string }) {
  const rec = useTele((s) => s.sessions[sid])
  const live = useTele((s) => (s.live?.sid === sid ? s.live : undefined))
  const list = useRef<HTMLOListElement>(null)
  const stick = useRef(true)
  const segs = rec?.segments ?? []
  const partials = live ? (Object.entries(live.partials) as [Speaker, string][]).filter(([, t]) => t) : []
  const heard = partials.map(([, t]) => t).join('|')

  useEffect(() => {
    const el = list.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [segs.length, heard])

  if (!rec) return null
  const name = (s: Speaker) => (s === 'doctor' ? 'You' : s === 'patient' ? firstName : 'Call')

  return (
    <Card
      titleSize="sm"
      title="Live transcript"
      className={className}
      right={
        <span className="flex flex-wrap items-center justify-end gap-[12px]">
          <span className="text-[13px] tabular-nums text-sh-text-3">{segs.length === 1 ? '1 line' : `${segs.length} lines`}</span>
          {(segs.length > 0 || live) && <Saved pending={rec.unsynced.length} />}
          <Pill
            variant="control"
            size="md"
            icon={Download}
            disabled={!segs.length}
            onClick={() => saveFile(`${fileStem(header.patient, rec.startedAt)}-transcript.txt`, liveTranscriptText(header, segs))}
            title={live ? 'Everything said so far. Download again later for the rest.' : undefined}
          >
            Download as text
          </Pill>
        </span>
      }
    >
      <ol
        ref={list}
        aria-label="Live transcript"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
        className="flex h-[420px] flex-col gap-[12px] overflow-y-auto rounded-[16px] border border-sh-line bg-sh-card p-[16px]"
      >
        {!segs.length && !partials.length && (
          <li className="m-auto flex max-w-[340px] flex-col items-center gap-[8px] text-center text-[14px] text-sh-text-3">
            <Icon icon={MessagesSquare} size={28} className="text-sh-line-strong" />
            {live ? `Listening. What you and ${firstName} say appears here after each pause.` : `When you start recording, what you and ${firstName} say appears here.`}
          </li>
        )}
        {segs.map((s) => (
          <Bubble key={s.id} mine={s.speaker === 'doctor'} who={name(s.speaker)} at={s.startMs} text={s.text} />
        ))}
        {partials.map(([speaker, t]) => (
          <Bubble key={`p-${speaker}`} mine={speaker === 'doctor'} who={name(speaker)} text={`${t}…`} faint />
        ))}
      </ol>
    </Card>
  )
}

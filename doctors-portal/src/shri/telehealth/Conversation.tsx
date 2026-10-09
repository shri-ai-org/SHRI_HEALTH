/**
 * The conversation, as chat bubbles: the patient on the left, the doctor on the
 * right, each with a name and the time; words still being heard show faintly as
 * the newest bubble. It follows the conversation unless the doctor scrolls up to
 * read, and says plainly where it is saved.
 *
 * Until the visit is marked done, the doctor can correct any line by typing — the
 * pencil beside it. A corrected line says so, and keeps the words first heard.
 */

import { Check, CloudOff, Download, Loader, MessagesSquare, PenLine } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '../lib/cn'
import { Card, Icon, Pill } from '../ui/primitives'

import { clockOf, fileStem, liveTranscriptText, saveFile, type RecordHeader } from './visitRecord'
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

function Bubble({
  mine,
  who,
  at,
  text,
  faint,
  heard,
  onEdit,
}: {
  mine: boolean
  who: string
  at?: number
  text: string
  faint?: boolean
  /** The words first heard, where the doctor corrected the line. */
  heard?: string
  onEdit?: () => void
}) {
  return (
    <li className={cn('flex max-w-[82%] flex-col gap-[3px]', mine ? 'items-end self-end' : 'items-start self-start')} data-speaker={mine ? 'doctor' : 'patient'} data-faint={faint || undefined} data-corrected={heard !== undefined || undefined}>
      <span className="flex items-center gap-[6px] px-[4px] text-[12px] text-sh-text-3">
        {who}
        {at ? ` · ${clockOf(at).slice(0, 5)}` : ''}
        {heard !== undefined && (
          <span className="font-medium text-sh-text-2" title={`First heard as: ${heard}`}>
            · Corrected
          </span>
        )}
        {onEdit && (
          <button type="button" onClick={onEdit} aria-label={`Correct this line: ${text}`} title="Correct this line" className="-my-[6px] flex size-[28px] items-center justify-center rounded-full text-sh-text-3 hover:bg-sh-inner hover:text-sh-text">
            <Icon icon={PenLine} size={13} />
          </button>
        )}
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

/** One line, being corrected: the words in a box, Save or Cancel (Ctrl+Enter, Escape). */
function EditLine({ mine, who, text, onSave, onCancel }: { mine: boolean; who: string; text: string; onSave: (t: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(text)
  const changed = value.trim() !== '' && value.trim() !== text
  return (
    <li className={cn('flex w-[82%] flex-col gap-[6px]', mine ? 'self-end' : 'self-start')} data-editing="">
      <span className="px-[4px] text-[12px] text-sh-text-3">Correcting what {who === 'You' ? 'you' : who} said</span>
      <textarea
        autoFocus
        rows={3}
        value={value}
        aria-label={`Correct what ${who === 'You' ? 'you' : who} said`}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && changed) onSave(value.trim())
        }}
        className="w-full resize-y rounded-[14px] border border-sh-line-strong bg-sh-card px-[12px] py-[9px] text-[15px] leading-[1.45] text-sh-text focus:border-sh-accent focus:outline-none"
      />
      <span className="flex justify-end gap-[8px]">
        <Pill variant="control" size="md" onClick={onCancel}>
          Cancel
        </Pill>
        <Pill variant="primary" size="md" disabled={!changed} onClick={() => onSave(value.trim())}>
          Save correction
        </Pill>
      </span>
    </li>
  )
}

export function Conversation({
  sid,
  firstName,
  header,
  editableBy,
  className,
}: {
  sid: string
  firstName: string
  header: RecordHeader
  /** Who may correct lines — the doctor, until the visit is marked done. Absent: the lines are locked. */
  editableBy?: string
  className?: string
}) {
  const rec = useTele((s) => s.sessions[sid])
  const correct = useTele((s) => s.correctSegment)
  const [editing, setEditing] = useState<string | null>(null)
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
        {segs.map((s) =>
          editing === s.id && editableBy ? (
            <EditLine
              key={s.id}
              mine={s.speaker === 'doctor'}
              who={name(s.speaker)}
              text={s.text}
              onCancel={() => setEditing(null)}
              onSave={(t) => {
                correct(sid, s.id, t, editableBy)
                setEditing(null)
              }}
            />
          ) : (
            <Bubble key={s.id} mine={s.speaker === 'doctor'} who={name(s.speaker)} at={s.startMs} text={s.text} heard={s.heard} onEdit={editableBy ? () => setEditing(s.id) : undefined} />
          ),
        )}
        {partials.map(([speaker, t]) => (
          <Bubble key={`p-${speaker}`} mine={speaker === 'doctor'} who={name(speaker)} text={`${t}…`} faint />
        ))}
      </ol>
      {segs.length > 0 && (
        <p className="mt-[10px] text-[13px] text-sh-text-3">
          {editableBy ? 'To correct a line, press the pencil beside it. Lines can be corrected until the visit is marked done.' : 'The visit is marked done, so the lines can no longer be corrected.'}
        </p>
      )}
    </Card>
  )
}

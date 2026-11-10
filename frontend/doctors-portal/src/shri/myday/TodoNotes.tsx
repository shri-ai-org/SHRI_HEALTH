/**
 * §5.8 — the doctor's own reminders: the old build's to-do notes (voice notes
 * attached to no patient, `useClinical` under `UNATTACHED`). Only the mic and +
 * add one; ticking strikes it through; delete is immediate and says what went,
 * as the old build's did. Open notes first, newest first.
 */

import { Check, Mic, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { formatDateTime, formatTime } from '@/data/format'
import { UNATTACHED, useClinical, type VoiceNote } from '@/store/clinical'
import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { useShri } from '../state/store'
import { Card, Icon, PillTag, RoundButton } from '../ui/primitives'

import { useMyDay } from './useMyDay'

const preview = (body: string) => (body.length > 60 ? `${body.slice(0, 60).trimEnd()}…` : body)

// ported from src/components/myday.tsx:581-585 (`savedAt`): a note is stamped
// with the device's clock when it is saved, so "today" is the device's today.
function savedAt(iso: string): string {
  const at = new Date(iso)
  const today = new Date()
  return at.toDateString() === today.toDateString() ? `Saved ${formatTime(at)}` : `Saved ${formatDateTime(at)}`
}

export function TodoNotes({ className }: { className?: string }) {
  const { todos } = useMyDay()
  const toggleDone = useClinical((s) => s.toggleVoiceNoteDone)
  const remove = useClinical((s) => s.deleteVoiceNote)
  const toast = useUI((s) => s.toast)
  const openNoteModal = useShri((s) => s.openNoteModal)

  const byNewest = (a: VoiceNote, b: VoiceNote) => b.at.localeCompare(a.at)
  const open = todos.filter((t) => !t.done).sort(byNewest)
  const done = todos.filter((t) => t.done).sort(byNewest)
  const ordered = [...open, ...done]

  function deleteNote(n: VoiceNote) {
    remove(UNATTACHED, n.id)
    toast({ tone: 'info', title: 'To-do note deleted', detail: `“${preview(n.body)}”` })
  }

  return (
    <Card className={cn('pb-[80px]', className)} aria-labelledby="sh-todo-title">
      <header className="mb-[14px] flex min-h-[34px] items-center gap-[10px]">
        <h2 id="sh-todo-title" className="text-[19px]/[1.2] font-medium tracking-[-0.012em] text-sh-text">
          To-do
        </h2>
        {open.length > 0 ? (
          <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-sh-control px-[7px] text-[12px] font-semibold tabular-nums text-sh-text">
            {open.length}
          </span>
        ) : (
          todos.length > 0 && (
            <PillTag tone="norm" size="xs" icon={Check} className="font-medium">
              All done
            </PillTag>
          )
        )}
        <div className="ml-auto flex items-center gap-[6px]">
          <RoundButton icon={Mic} size={40} variant="accent" label="Dictate a to-do note" onClick={() => openNoteModal({ kind: 'todo', listening: true })} />
          <RoundButton icon={Plus} size={40} variant="primary" label="Type a to-do note" strokeWidth={2.2} onClick={() => openNoteModal({ kind: 'todo', listening: false })} />
        </div>
      </header>

      {ordered.length === 0 ? (
        <p className="text-[14px] text-sh-text-2">Nothing noted for today yet. Use the mic, or + to type.</p>
      ) : (
        <ul aria-label="To-do notes" className="sh-scrollbar -mx-[4px] flex min-h-0 flex-1 flex-col gap-[6px] overflow-y-auto px-[4px]">
          {ordered.map((t) => (
            <TodoRow key={t.id} note={t} onToggle={() => toggleDone(UNATTACHED, t.id)} onDelete={() => deleteNote(t)} />
          ))}
        </ul>
      )}
    </Card>
  )
}

/** One to-do: a tick, the words (three lines, more on tap), when it was saved, and a way to delete it. */
function TodoRow({ note: t, onToggle, onDelete }: { note: VoiceNote; onToggle: () => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const textRef = useRef<HTMLSpanElement>(null)
  const expandedRef = useRef(expanded)
  const done = t.done === true
  // The old row's accessible name: the words, one line, 48 characters.
  const name = t.body.replace(/\s+/g, ' ').slice(0, 48)

  // Whether three lines hide anything — measured, so a short note never offers "Show more".
  useEffect(() => {
    expandedRef.current = expanded
    const el = textRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!expandedRef.current) setClamped(el.scrollHeight > el.clientHeight + 1)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [t.body, expanded])

  return (
    <li className={cn('flex items-start gap-[2px] rounded-[14px] py-[3px] pr-[4px]', !done && 'bg-sh-inner')}>
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Mark as not done: ${name}` : `Mark as done: ${name}`}
        onClick={onToggle}
        className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-full"
      >
        <span
          className={cn(
            'inline-flex size-[22px] items-center justify-center rounded-[7px] transition-colors duration-150',
            done ? 'bg-sh-accent text-sh-accent-ink' : 'border-2 border-(--todo-box-border) bg-white shdark:bg-sh-card',
          )}
          aria-hidden="true"
        >
          {done && <Icon icon={Check} size={14} strokeWidth={3} />}
        </span>
      </button>
      <span className="min-w-0 flex-1 pb-[7px] pt-[11px]">
        <span
          ref={textRef}
          className={cn('whitespace-pre-line break-words text-[14px]/[20px]', expanded ? 'block' : 'sh-clamp-3', done ? 'text-sh-muted line-through' : 'text-sh-text')}
        >
          {t.body}
        </span>
        <span className="mt-[2px] flex flex-wrap items-center gap-x-[6px] text-[11px]/[14px] text-sh-muted">
          <span className="tabular-nums">{savedAt(t.at)}</span>
          {done && (
            <>
              <span aria-hidden="true">·</span>
              <span>Done</span>
            </>
          )}
          {(clamped || expanded) && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex min-h-[32px] items-center font-semibold text-sh-text-2 hover:text-sh-text hover:underline"
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            </>
          )}
        </span>
      </span>
      <RoundButton
        icon={Trash2}
        size={36}
        iconSize={16}
        variant="ghost"
        label="Delete this to-do note"
        className="mt-[4px] text-sh-muted hover:text-sh-crit-fg"
        onClick={onDelete}
      />
    </li>
  )
}

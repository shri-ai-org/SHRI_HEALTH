/**
 * The record overview's Notes card (row 1, under Test results) — the patient's
 * own clinical notes, dictated or typed, the way the To-do card takes the
 * doctor's: the accent mic dictates (Tamil and English, written in English), +
 * types. Each note is a draft until signed — it can be edited, with the mic
 * adding to it, or discarded first; signed, it is part of the record. Drafts
 * first, then the signed, newest first. The Notes tab has every note.
 */

import { Mic, NotebookPen, Plus } from 'lucide-react'
import { Link } from 'react-router-dom'

import type { Patient } from '@/data/kit'

import { cn } from '../lib/cn'
import { useVoiceNotesFor } from '../logic/record'
import { useShri } from '../state/store'
import { EmptyState } from '../ui/EmptyState'
import { Card, CountBubble, RoundButton } from '../ui/primitives'

import { VoiceNoteRow } from './VoiceNoteRow'

export function NotesCard({ patient: p, className }: { patient: Patient; className?: string }) {
  const open = useShri((s) => s.openNoteModal)
  const all = useVoiceNotesFor(p.id)
  const notes = [...all.filter((n) => n.status === 'draft'), ...all.filter((n) => n.status !== 'draft')]
  const drafts = all.length - all.filter((n) => n.status === 'signed').length

  return (
    <Card
      titleSize="sm"
      title="Notes"
      aria-label={`Notes on ${p.name}`}
      right={
        <>
          {drafts > 0 && <CountBubble className="bg-sh-warn-bg text-sh-warn-fg">{drafts}</CountBubble>}
          <RoundButton icon={Mic} size={40} variant="accent" label={`Dictate a note on ${p.name}`} onClick={() => open({ kind: 'patient', patientId: p.id, listening: true })} />
          <RoundButton icon={Plus} size={40} variant="primary" strokeWidth={2.2} label={`Type a note on ${p.name}`} onClick={() => open({ kind: 'patient', patientId: p.id, listening: false })} />
        </>
      }
      className={cn('min-h-0', className)}
    >
      {notes.length === 0 ? (
        <EmptyState compact icon={NotebookPen} why="No notes yet. Use the mic, or + to type — each stays a draft you can edit until you sign it." />
      ) : (
        <ul className="-mx-[4px] flex min-h-0 flex-1 flex-col gap-[10px] overflow-y-auto px-[4px]" aria-label="Notes, drafts first">
          {notes.map((n, i) => (
            <VoiceNoteRow key={n.id} patient={p} note={n} first={i === 0} compact />
          ))}
        </ul>
      )}
      <Link to={`/patient/${p.uhid}/notes`} className="mt-auto inline-flex min-h-[44px] items-center self-start pt-[6px] text-[13px] font-medium text-sh-text-2 underline-offset-2 hover:underline">
        All notes
      </Link>
    </Card>
  )
}

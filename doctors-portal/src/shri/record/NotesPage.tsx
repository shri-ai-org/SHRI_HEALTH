/**
 * S-06-14 · Consultation notes — `/patient/:id/notes` (`src/screens/m06/record/
 * S0614.tsx`): what was written last time, and what was dictated today, in one
 * place. Three groups, newest first: notes dictated today (drafts until signed
 * — signing here is what takes them off My Day's "to sign" list), today's
 * consultation note if one has been started, and every earlier SOAP note. An
 * earlier note opens to its four sections; closed, it is one line.
 */

import { ChevronDown, ChevronRight, FileText, Mic, PenLine, Signature, Stethoscope } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { formatDate, formatTime } from '@/data/format'
import type { Patient } from '@/data/kit'
import { pastNotesFor, type PastNote } from '@/data/record'

import { useMayOpenPath } from '../app/landing'
import { consultPath, noteActionLabel, useSessionNotesFor, useVoiceNotesFor } from '../logic/record'
import { useShri } from '../state/store'
import { EmptyState } from '../ui/EmptyState'
import { Card, CountBubble, Icon, Pill, PillTag, RoundButton } from '../ui/primitives'

import { RecordFrame } from './RecordFrame'
import { VoiceNoteRow } from './VoiceNoteRow'

const SOAP: { key: 'subjective' | 'objective' | 'assessment' | 'plan'; label: string }[] = [
  { key: 'subjective', label: 'Subjective' },
  { key: 'objective', label: 'Objective' },
  { key: 'assessment', label: 'Assessment' },
  { key: 'plan', label: 'Plan' },
]

export function NotesPage() {
  const { id } = useParams()
  const openNoteModal = useShri((s) => s.openNoteModal)
  return (
    <RecordFrame
      id={id}
      section="notes"
      actions={(p) => (
        <RoundButton icon={Mic} size={48} iconSize={19} variant="accent" label="Add note" onClick={() => openNoteModal({ kind: 'patient', patientId: p.id, listening: true })} />
      )}
    >
      {(p) => <Notes patient={p} />}
    </RecordFrame>
  )
}

function Notes({ patient: p }: { patient: Patient }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const voice = useVoiceNotesFor(p.id)
  const session = useSessionNotesFor(p.id)
  const past = pastNotesFor(p.id)
  const consult = consultPath(p)
  const canConsult = consult !== undefined && may(consult)

  if (voice.length === 0 && session.length === 0 && past.length === 0) {
    return (
      <Card titleSize="sm" title="Consultation notes">
        <EmptyState
          icon={FileText}
          why={`Nothing has been written on ${p.name}’s record yet. A dictated note, or a consultation note once started, will appear here.`}
          action={
            canConsult && (
              <Pill variant="control" size="lg" icon={Stethoscope} onClick={() => navigate(consult)}>
                {noteActionLabel(p)}
              </Pill>
            )
          }
        />
      </Card>
    )
  }

  return (
    <>
      {voice.length > 0 && (
        <Card
          titleSize="sm"
          title={
            <span className="inline-flex items-center gap-[10px]">
              Dictated
              <CountBubble className={voice.some((n) => n.status === 'draft') ? 'bg-sh-pend-bg text-sh-pend-fg' : 'bg-sh-control'}>{voice.length}</CountBubble>
            </span>
          }
        >
          <ul className="flex flex-col">
            {voice.map((n, i) => (
              <VoiceNoteRow key={n.id} patient={p} note={n} first={i === 0} />
            ))}
          </ul>
        </Card>
      )}

      {session.map(({ encounter, record }) => (
        <Card
          key={encounter.id}
          titleSize="sm"
          title={
            <span className="inline-flex items-center gap-[10px]">
              This visit
              <PillTag tone={record.status === 'signed' ? 'norm' : 'warn'} size="sm" icon={record.status === 'signed' ? Signature : PenLine}>
                {record.status === 'signed' ? `Signed ${record.signedAt ? formatTime(new Date(record.signedAt)) : ''}` : 'Draft'}
              </PillTag>
            </span>
          }
          right={
            canConsult && (
              <Pill variant="control" size="md" icon={ChevronRight} onClick={() => navigate(consult)}>
                Open the note
              </Pill>
            )
          }
        >
          <dl className="grid grid-cols-1 gap-[12px] sm:grid-cols-2">
            {SOAP.filter((s) => (record.text[s.key] ?? '').trim() !== '').map((s) => (
              <div key={s.key} className="min-w-0">
                <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">{s.label}</dt>
                <dd className="mt-[4px] whitespace-pre-line text-[14px]/[1.5] text-sh-text-2">{record.text[s.key]}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ))}

      {past.length > 0 && (
        <Card
          titleSize="sm"
          title={
            <span className="inline-flex items-center gap-[10px]">
              Earlier notes
              <CountBubble className="bg-sh-control">{past.length}</CountBubble>
            </span>
          }
        >
          <ul className="-mx-[8px] flex flex-col">
            {past.map((n, i) => (
              <PastNoteRow key={n.id} note={n} first={i === 0} />
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}

function PastNoteRow({ note: n, first }: { note: PastNote; first: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={first ? undefined : 'border-t border-sh-line'}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[44px] w-full items-start gap-[12px] rounded-[14px] px-[8px] py-[12px] text-left transition-colors duration-150 hover:bg-sh-hover"
      >
        <Icon icon={open ? ChevronDown : ChevronRight} size={16} className="mt-[2px] shrink-0 text-sh-text-3" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-[8px] gap-y-[2px]">
            <span className="text-[14px] font-semibold text-sh-text">{n.kind}</span>
            <span className="text-[13px] text-sh-text-3">{n.setting}</span>
          </span>
          {!open && <span className="mt-[2px] block truncate text-[13px] text-sh-text-2">{n.assessment}</span>}
          <span className="mt-[2px] block text-[12px] tabular-nums text-sh-text-3">
            {formatDate(n.at)} {formatTime(n.at)} · {n.by}
          </span>
        </span>
      </button>
      {open && (
        <dl className="grid grid-cols-1 gap-[12px] px-[16px] pb-[16px] sm:grid-cols-2 sm:pl-[44px]">
          {SOAP.map((s) => (
            <div key={s.key} className="min-w-0">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">{s.label}</dt>
              <dd className="mt-[4px] text-[14px]/[1.5] text-sh-text-2">{n[s.key]}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}

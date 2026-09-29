/**
 * S-06-09 · Co-sign — `/clinician/cosign` (`src/screens/m06/S0609.tsx`):
 * "What still needs a consultant's signature."
 *
 * CMP-NABH-03 makes countersigning an accreditation requirement rather than a
 * courtesy, and CMP-NABH-10 governs what happens when you disagree: you do not
 * edit the registrar's entry, you append your own.
 *
 * Where the old queue fell short, this one does what its words say: a
 * registrar's note joins it under its own patient; co-signing signs that note
 * with both names on it, and returning sends it back to the author's drafts
 * with the comment recorded against it — both on the audit trail, and the
 * return sent to the author. The order the header names is the order the rows
 * are in, and every row's actions are real buttons, reachable by keyboard.
 */

import { Check, Info, Signature, TriangleAlert, Undo2, Users } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { COSIGN_QUEUE, type CoSignRow } from '@/data/clinical'
import { NOW, formatDateTime, formatElapsed } from '@/data/format'
import { patient } from '@/data/kit'
import { useAudit } from '@/store/audit'
import { useClinical, type NoteRecord } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { usePublishSummary } from '../logic/discharge'
import { encounterLabel, maybeEncounter } from '../logic/encounter'
import { recordPath } from '../logic/record'
import { useAiActive } from '../state/ai'
import { useNotifications } from '../state/notifications'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { EmptyState } from '../ui/EmptyState'
import { Card, CountBubble, Icon, Pill, PillTag } from '../ui/primitives'
import { RankedSort } from '../ui/RankedSort'
import { VoiceField } from '../ui/VoiceField'

/**
 * A queue entry; a registrar's entry from this session carries its encounter,
 * the record it lives under, and where it is read. A discharge summary is a
 * kind the old queue never held (its summary was signed by whoever wrote it).
 */
interface QueueRow extends Omit<CoSignRow, 'documentKind'> {
  documentKind: CoSignRow['documentKind'] | 'Discharge summary'
  encounterId?: string
  /** The clinical-record key the entry is kept under — the encounter's note, or its `:assessment`. */
  noteKey?: string
  /** The screen the entry is written on. */
  path?: string
}

/**
 * Entries a registrar saved for co-sign join the queue under their own patient
 * (the old queue filed every one under SD-P-01) and as what they are — a
 * consultation note, a progress note, an admission assessment. The id carries
 * the moment it was saved, so an entry returned and saved again comes back.
 */
function sessionRows(notes: Record<string, NoteRecord>): QueueRow[] {
  return Object.entries(notes)
    .filter(([, n]) => n.status === 'cosign-pending')
    .flatMap(([key, n]) => {
      const [encId, part] = key.split(':')
      const enc = maybeEncounter(encId)
      if (!enc) return []
      const assessment = part === 'assessment'
      const summary = part === 'discharge'
      return [
        {
          id: `CS-${key}-${n.signedAt ?? 'draft'}`,
          patientId: enc.patientId,
          documentKind: summary
            ? ('Discharge summary' as const)
            : assessment
              ? ('Admission assessment' as const)
              : enc.type === 'IP'
                ? ('Inpatient progress note' as const)
                : ('Consultation note' as const),
          authoredBy: n.signedBy ?? 'Registrar',
          authoredByPersona: 'P-05 Resident',
          authoredAt: n.signedAt ? new Date(n.signedAt) : NOW,
          qualityFlags: [],
          kind: 'cosign' as const,
          encounterId: enc.id,
          noteKey: key,
          path: summary
            ? `/encounter/${enc.id}/discharge-summary`
            : assessment
              ? `/ip/encounter/${enc.id}/assessment`
              : enc.type === 'IP'
                ? `/ip/encounter/${enc.id}/note`
                : `/encounter/${enc.id}/note`,
        },
      ]
    })
}

export function CoSignPage() {
  const navigate = useNavigate()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const send = useNotifications((s) => s.send)
  const aiActive = useAiActive()
  const notes = useClinical((s) => s.notes)
  const coSigned = useClinical((s) => s.coSigned)
  const resolveCoSign = useClinical((s) => s.resolveCoSign)
  const publishSummary = usePublishSummary()

  const [aiSort, setAiSort] = useState(true)
  const [acting, setActing] = useState<{ row: QueueRow; outcome: 'co-signed' | 'returned' } | null>(null)
  const [returnNote, setReturnNote] = useState('')

  const all = [...sessionRows(notes), ...COSIGN_QUEUE].filter((r) => !coSigned[r.id])
  // The order the header names: quality flags first only while AI-114 is live to rank them.
  const byAi = aiActive && aiSort
  const oldest = (a: QueueRow, b: QueueRow) => a.authoredAt.getTime() - b.authoredAt.getTime()
  const rows = [...all].sort(byAi ? (a, b) => b.qualityFlags.length - a.qualityFlags.length || oldest(a, b) : oldest)
  const actioned = Object.entries(coSigned).reverse()

  function decide() {
    if (!acting) return
    const { row, outcome } = acting
    const comment = outcome === 'returned' ? returnNote.trim() : undefined
    if (outcome === 'returned' && (comment ?? '').length < 3) return
    const p = patient(row.patientId)
    const enc = maybeEncounter(row.encounterId)
    resolveCoSign({
      itemId: row.id,
      by: me.name,
      registrationNo: me.identifier,
      outcome,
      comment,
      patientId: row.patientId,
      documentKind: row.documentKind,
      encounterId: row.noteKey,
    })
    const what = `${row.documentKind} by ${row.authoredBy}${enc ? ` · ${encounterLabel(enc)}` : ''}`
    audit({
      event: outcome === 'co-signed' ? 'NOTE.COSIGNED' : 'NOTE.RETURNED',
      actor: me.name,
      actorId: me.id,
      subject: row.patientId,
      detail: outcome === 'co-signed' ? `${what} · stamped ${me.identifierKind} ${me.identifier}` : `${what} · “${comment}”`,
    })
    // A co-signed discharge summary goes out as a signed one does — to the patient and the referring doctor.
    if (outcome === 'co-signed' && row.documentKind === 'Discharge summary' && row.encounterId) publishSummary(row.patientId, row.encounterId)
    if (outcome === 'returned') {
      // "The author is notified" — kept as sent, with what needs changing.
      send({
        severity: 'routine',
        kind: 'cosign',
        title: `Returned to ${row.authoredBy}`,
        detail: `${row.documentKind} · ${p.name} — ${comment}`,
        to: row.path ?? recordPath(p, 'record'),
        recipient: 'author',
      })
    }
    toast({
      tone: outcome === 'co-signed' ? 'success' : 'caution',
      title: outcome === 'co-signed' ? 'Co-signed' : 'Returned to the author',
      detail: outcome === 'co-signed' ? `Stamped ${me.name} · ${me.identifier}` : 'The author has been notified. The entry remains in their drafts.',
    })
    setActing(null)
    setReturnNote('')
  }

  /** The old worklist's keyboard map: arrow keys move between rows, Enter opens one. */
  function onListKey(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-row]'))
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = items[e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)]
    if (next) {
      e.preventDefault()
      next.focus()
    }
  }

  return (
    <>
      <ScreenFrame
        screenId="S-06-09"
        heading="Co-sign"
        sub={`${rows.length} awaiting your signature · 24h target · CMP-NABH-03`}
        empty={
          <Card className="items-center px-[24px] py-[40px] text-center">
            <p className="text-[17px] font-medium text-sh-text">Nothing is waiting for your signature.</p>
            <p className="mx-auto mt-[8px] max-w-[440px] text-[14px] text-sh-text-2">
              A registrar saving a note that requires a consultant, or an addendum to a signed record, would appear here.
            </p>
          </Card>
        }
      >
        <div className="flex max-w-[896px] flex-col gap-[16px]">
          <div className="flex flex-wrap items-center justify-between gap-[12px]">
            <PillTag tone="neu" size="sm" icon={Users}>
              Your registrars
            </PillTag>
            <RankedSort
              aiSort={aiSort}
              onChange={setAiSort}
              aiLabel="Quality flags first"
              deterministicLabel="Oldest first"
              capabilityId="AI-114"
              label="Sort the co-sign queue"
            />
          </div>

          <Card className="p-[8px]">
            {rows.length === 0 ? (
              <EmptyState icon={Signature} why="Nothing is waiting for your signature. A registrar saving a note that requires a consultant would appear here." />
            ) : (
              <>
                <ul aria-label="Entries awaiting a consultant co-signature" onKeyDown={onListKey} className="flex flex-col">
                  {rows.map((row, i) => {
                    const p = patient(row.patientId)
                    const who = `${row.documentKind} for ${p.name} by ${row.authoredBy}`
                    return (
                      <li key={row.id} className={cn('flex flex-wrap items-center gap-x-[8px] gap-y-[6px] py-[6px]', i > 0 && 'border-t border-sh-line')}>
                        <button
                          type="button"
                          data-row
                          onClick={() => navigate(recordPath(p, 'record'))}
                          className="flex min-h-[60px] min-w-0 flex-1 basis-[280px] items-center gap-[12px] rounded-[14px] px-[10px] py-[6px] text-left transition-colors duration-150 hover:bg-sh-hover"
                        >
                          {/* The lead — how long it has waited — in a lozenge, so the eye runs down the column. */}
                          <span className="inline-flex h-[32px] min-w-[64px] shrink-0 items-center justify-center rounded-[10px] bg-sh-inner px-[10px] text-[13px] font-bold tabular-nums text-sh-text-2">
                            {formatElapsed((NOW.getTime() - row.authoredAt.getTime()) / 60000)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[15px] font-semibold text-sh-text">{p.name}</span>
                            <span className="block truncate text-[12px] text-sh-text-3">
                              {row.documentKind} · {row.authoredBy}
                            </span>
                          </span>
                          {/* One chip per flag, the flag's words, no ◆ — AI-114's provenance is on the chip's title. */}
                          <span className="flex shrink-0 flex-col items-end gap-[4px]">
                            {row.qualityFlags.length === 0 ? (
                              <PillTag tone="norm" size="sm" icon={Check}>
                                Clean
                              </PillTag>
                            ) : (
                              // Read before signing, so the whole flag, wrapping — never cut short.
                              row.qualityFlags.map((f) => (
                                <span
                                  key={f}
                                  title="AI-114 · CMP-NABH-05"
                                  className="inline-flex max-w-[300px] items-start gap-[6px] rounded-[12px] bg-sh-warn-bg px-[10px] py-[5px] text-[12px]/[1.4] font-medium text-sh-warn-fg"
                                >
                                  <Icon icon={TriangleAlert} size={13} className="mt-[1px] shrink-0" />
                                  {f}
                                </span>
                              ))
                            )}
                          </span>
                        </button>
                        <span className="flex shrink-0 items-center gap-[8px] pr-[6px]">
                          <Pill variant="ghost" size="md" icon={Undo2} aria-label={`Return — ${who}`} onClick={() => setActing({ row, outcome: 'returned' })}>
                            Return
                          </Pill>
                          <Pill variant="primary" size="md" icon={Signature} aria-label={`Co-sign — ${who}`} onClick={() => setActing({ row, outcome: 'co-signed' })}>
                            Co-sign
                          </Pill>
                        </span>
                      </li>
                    )
                  })}
                </ul>
                <p className="border-t border-sh-line px-[10px] pb-[4px] pt-[10px] text-[12px] tabular-nums text-sh-text-3">
                  {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
                  <span className="sr-only"> · arrow keys to move, Enter to open</span>
                </p>
              </>
            )}
          </Card>

          {/* CMP-NABH-10, in one line rather than a paragraph. */}
          <p className="flex items-start gap-[8px] px-[4px] text-[12px] text-sh-text-3">
            <Icon icon={Info} size={13} className="mt-[2px] shrink-0" />
            Disagreeing with an entry means appending your own addendum, never editing theirs.
          </p>

          {actioned.length > 0 && (
            <Card
              titleSize="sm"
              title={
                <span className="inline-flex items-center gap-[10px]">
                  Actioned this session
                  <CountBubble className="bg-sh-control">{actioned.length}</CountBubble>
                </span>
              }
            >
              <ul className="flex flex-col">
                {actioned.map(([itemId, info], i) => {
                  const p = info.patientId ? patient(info.patientId) : undefined
                  const signed = info.outcome === 'co-signed'
                  return (
                    <li key={itemId} className={cn('flex flex-wrap items-start justify-between gap-[8px] py-[10px]', i > 0 && 'border-t border-sh-line', i === 0 && 'pt-0')}>
                      <span className="flex min-w-0 items-start gap-[8px]">
                        <Icon icon={signed ? Check : Undo2} size={14} className={cn('mt-[3px] shrink-0', signed ? 'text-sh-norm-fg' : 'text-sh-warn-fg')} />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-[8px]">
                            <span className="text-[14px] font-medium text-sh-text">{p ? `${p.name} · ${info.documentKind}` : itemId}</span>
                            <PillTag tone={signed ? 'norm' : 'warn'} size="xs" className="font-semibold">
                              {info.outcome}
                            </PillTag>
                          </span>
                          {info.comment && <span className="mt-[2px] block text-[13px] text-sh-text-2">&ldquo;{info.comment}&rdquo;</span>}
                        </span>
                      </span>
                      <span className="text-[12px] tabular-nums text-sh-text-3">
                        {info.by} · {formatDateTime(new Date(info.at))}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}
        </div>
      </ScreenFrame>

      <ConfirmDialog
        open={acting !== null}
        title={acting?.outcome === 'co-signed' ? 'Co-sign this entry?' : 'Return this entry to the author?'}
        consequence={
          acting?.outcome === 'co-signed'
            ? `Your name and ${me.identifierKind} ${me.identifier} are stamped alongside the author's. The entry becomes part of the legal record and can afterwards only be amended, never edited.`
            : 'The author is notified and the entry stays unsigned in their drafts. Nothing is deleted, and your comment is recorded against it.'
        }
        confirmLabel={acting?.outcome === 'co-signed' ? 'Co-sign' : 'Return with a comment'}
        tone={acting?.outcome === 'co-signed' ? 'primary' : 'destructive'}
        // A return is recorded with what needs changing — the comment its button promises.
        confirmDisabled={acting?.outcome === 'returned' && returnNote.trim().length < 3}
        onConfirm={decide}
        onCancel={() => {
          setActing(null)
          setReturnNote('')
        }}
      >
        {acting?.outcome === 'returned' && (
          <VoiceField id="return-note" label="What needs changing" required rows={3} value={returnNote} onChange={setReturnNote} placeholder="What needs changing before you will sign it…" />
        )}
      </ConfirmDialog>
    </>
  )
}

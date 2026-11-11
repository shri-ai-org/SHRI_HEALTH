/**
 * One note dictated or typed on a patient — on the Notes tab (S-06-14) and the
 * record overview's Notes card. A draft can be edited (the note box reopens with
 * its words; the mic adds more), signed, or discarded; once signed it is part of
 * the record and never changes. Edit, sign and discard are each on the audit
 * trail. `compact` is the overview's: three lines of the note, the actions under it.
 */

import { PenLine, Signature, Trash2 } from 'lucide-react'

import { formatDate, formatTime } from '@/data/format'
import type { Patient } from '@/data/kit'
import { useAudit } from '@/store/audit'
import { useClinical, type VoiceNote } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { useShri } from '../state/store'
import { Diamond, Icon, Pill, PillTag, RoundButton } from '../ui/primitives'

export function VoiceNoteRow({ patient: p, note: n, first, compact = false }: { patient: Patient; note: VoiceNote; first: boolean; compact?: boolean }) {
  const me = useCurrentStaff()
  const sign = useClinical((s) => s.signVoiceNote)
  const remove = useClinical((s) => s.deleteVoiceNote)
  const openNoteModal = useShri((s) => s.openNoteModal)
  const record = useAudit((s) => s.record)
  const toast = useUI((s) => s.toast)
  const words = n.body.trim().split(/\s+/).length
  const draft = n.status === 'draft'

  function doSign() {
    sign(p.id, n.id, me.name)
    record({ event: 'NOTE.SIGNED', actor: me.name, actorId: me.id, subject: p.id, model: n.model, detail: `Dictated note signed · ${words} words` })
    toast({ tone: 'success', title: 'Note signed', detail: `${p.name} · now part of the record` })
  }

  function discard() {
    remove(p.id, n.id)
    // The save was on record, so the discard is too.
    record({ event: 'NOTE.DRAFT_DISCARDED', actor: me.name, actorId: me.id, subject: p.id, model: n.model, detail: `Unsigned draft discarded · ${words} words` })
    toast({ tone: 'info', title: 'Draft discarded', detail: p.name })
  }

  const actions = draft ? (
    <>
      <RoundButton icon={PenLine} size={36} iconSize={16} variant="control" label="Edit this draft" onClick={() => openNoteModal({ kind: 'patient', patientId: p.id, listening: false, noteId: n.id })} />
      <RoundButton icon={Trash2} size={36} iconSize={16} variant="ghost" label="Discard this draft" className="text-sh-text-3 hover:text-sh-crit-fg" onClick={discard} />
      <Pill variant="primary" size="md" icon={Signature} onClick={doSign}>
        Sign
      </Pill>
    </>
  ) : (
    <PillTag tone="norm" size="sm" icon={Signature}>
      Signed
    </PillTag>
  )

  return (
    <li className={first ? (compact ? undefined : 'pb-[12px]') : compact ? 'border-t border-sh-line pt-[10px]' : 'border-t border-sh-line py-[12px]'}>
      <div className={cn('flex gap-[12px]', compact ? 'items-start' : 'flex-wrap items-start')}>
        <span className="inline-flex size-[36px] shrink-0 items-center justify-center rounded-[12px] bg-sh-accent text-sh-accent-ink" aria-hidden="true">
          <Icon icon={draft ? PenLine : Signature} size={16} />
        </span>
        <div className={cn('min-w-0 flex-1', !compact && 'basis-[260px]')}>
          <p className={cn('whitespace-pre-line text-[14px]/[1.5] text-sh-text', compact && 'line-clamp-3')}>{n.body}</p>
          <p className="mt-[4px] flex flex-wrap items-center gap-x-[8px] gap-y-[2px] text-[12px] tabular-nums text-sh-text-3">
            <span>
              {n.by} · {formatDate(new Date(n.at))} {formatTime(new Date(n.at))}
            </span>
            <span className="inline-flex items-center gap-[4px]">
              <Diamond />
              {/^typed/i.test(n.model) ? 'typed' : 'dictated'}
              {n.editedAt ? ' · edited' : ''}
            </span>
            {draft && <span className="font-medium text-sh-warn-fg">Draft · not signed</span>}
            {!draft && n.signedAt && (
              <span>
                · signed {formatTime(new Date(n.signedAt))}
                {n.signedBy ? ` by ${n.signedBy}` : ''}
              </span>
            )}
          </p>
          {compact && <div className="mt-[8px] flex items-center gap-[6px]">{actions}</div>}
        </div>
        {!compact && <div className="flex shrink-0 items-center gap-[6px]">{actions}</div>}
      </div>
    </li>
  )
}

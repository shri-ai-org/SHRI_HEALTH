/**
 * §6.2 — one dictation / note modal for four entry points: Attention mic,
 * Quick-Panel "Add note", the To-do mic (opens already listening) and the
 * To-do "+" (opens ready to type). The box is the shared `VoiceField` in its
 * note layout; the transcript is the browser's own, and when recognition
 * cannot run the doctor is told why and types instead.
 *
 * Saving is the old build's (`src/components/dictation.tsx:711-757`): the note
 * goes into `useClinical`'s voice notes — a patient's as an unsigned draft, a
 * to-do under `UNATTACHED` — and two audit rows are written: that a transcript
 * existed (once per take), and what was committed, by whom, under G2. Nothing
 * leaves the modal until Save.
 */

import { AnimatePresence, motion } from 'framer-motion'
import { Mic, PenLine, X } from 'lucide-react'
import { useRef, useState } from 'react'

import type { ConfidenceBand } from '@/atlas/confidence'
import { patient } from '@/data/kit'
import { useAudit } from '@/store/audit'
import { UNATTACHED, useClinical } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import type { DictationPhase } from '../logic/dictation'
import { TYPED_MODEL } from '../logic/speech'
import { useShri, type NoteModalState } from '../state/store'
import { useModalFrame } from '../ui/frames'
import { useFocusTrap } from '../ui/hooks'
import { Icon, Pill, RoundButton } from '../ui/primitives'
import { VoiceField, type DictatedMeta, type VoiceFieldHandle } from '../ui/VoiceField'

export function NoteModal() {
  const m = useShri((s) => s.noteModal)
  return <AnimatePresence>{m && <Modal key="note" m={m} />}</AnimatePresence>
}

/** The old dialog's title and subtitle — with the patient's age, sex and UHID beside the name, so the note lands on the right chart. */
function heading(m: NoteModalState): { title: string; sub: string; name?: string } {
  if (m.kind === 'todo') return { title: 'To-do note', sub: 'Not attached to a patient' }
  const p = patient(m.patientId)
  return { title: 'Add note', sub: `${p.name} · ${p.age}/${p.sex} · ${p.uhid}`, name: p.name }
}

const wordsIn = (t: string) => (t.trim() === '' ? 0 : t.trim().split(/\s+/).length)

function Modal({ m }: { m: NoteModalState }) {
  const close = useShri((s) => s.closeNoteModal)
  const me = useCurrentStaff()
  const record = useAudit((s) => s.record)
  const saveVoiceNote = useClinical((s) => s.saveVoiceNote)
  const toast = useUI((s) => s.toast)
  const ref = useFocusTrap<HTMLDivElement>(true)
  const frame = useModalFrame(560)
  const { title, sub, name } = heading(m)
  const patientId = m.kind === 'patient' ? m.patientId : undefined

  const [text, setText] = useState('')
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const field = useRef<VoiceFieldHandle>(null)
  // Save reads these synchronously: stopping a take in progress lands its words and its run in the same tick.
  const textRef = useRef('')
  /** The last take that heard words. */
  const takeRef = useRef<DictatedMeta | null>(null)
  /** The doctor's own change since that take landed. */
  const editedRef = useRef(false)
  const words = wordsIn(text)

  function change(v: string, source?: 'dictation') {
    textRef.current = v
    if (source !== 'dictation') editedRef.current = true
    setText(v)
  }

  /** Audit event one of two: the transcript existed. */
  function dictated(meta: DictatedMeta) {
    takeRef.current = meta
    editedRef.current = false
    record({
      event: 'AI.SCRIBE.TRANSCRIPT_CREATED',
      actor: me.name,
      actorId: me.id,
      subject: patientId,
      model: meta.model,
      gate: 'G2',
      detail: `${meta.words} words · live recognition · ${meta.band}`,
    })
  }

  function save() {
    field.current?.stop()
    const body = textRef.current.trim()
    if (body === '') return
    const take = takeRef.current
    const model = take ? take.model : TYPED_MODEL
    const band: ConfidenceBand = take ? take.band : 'HIGH'
    saveVoiceNote({ patientId: patientId ?? UNATTACHED, body, by: me.name, model, band })
    /** Audit event two of two: what was committed, by whom, under which gate. */
    record({
      event: 'NOTE.DRAFT_SAVED',
      actor: me.name,
      actorId: me.id,
      subject: patientId,
      model,
      gate: 'G2',
      detail: `${take ? 'Dictated' : 'Typed'} note saved${take ? (editedRef.current ? ' after manual edit' : ' unedited') : ''} · ${body.split(/\s+/).length} words`,
    })
    toast({
      tone: 'success',
      title: name ? 'Note saved as a draft' : 'To-do note saved',
      detail: name ? `${name} · not signed` : 'On My Day, under To-do notes',
    })
    close()
  }

  function discard() {
    field.current?.stop()
    close()
  }

  return (
    <div ref={ref} className={cn(frame.outer, 'z-60')} style={frame.outerStyle}>
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={name ? `${title} · ${name}` : title}
        variants={frame.variants}
        initial="hidden"
        animate="shown"
        exit="exit"
        className={cn('rounded-sh-modal bg-sh-card p-[22px] text-sh-text shadow-sh-modal', frame.inner)}
      >
        <header className="flex items-center gap-[14px]">
          <span className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-full bg-sh-accent text-sh-accent-ink">
            <Icon icon={m.kind === 'todo' && !m.listening ? PenLine : Mic} size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[17px]/[1.2] font-medium tracking-[-0.012em] text-sh-text">{title}</h2>
            <p className="mt-[3px] truncate text-[12px] text-sh-text-3">{sub}</p>
          </div>
          <RoundButton icon={X} label="Close" size={38} onClick={discard} />
        </header>

        {/* On a phone the sheet is near full height, so the note box takes the room. */}
        <VoiceField
          id="dictation-draft"
          label="Your note"
          layout="note"
          value={text}
          onChange={change}
          onDictated={dictated}
          onPhase={setPhase}
          rows={7}
          autoStart={m.listening}
          autoFocus
          placeholder="Type, or press the microphone and speak…"
          typedPlaceholder="Type the note…"
          handle={field}
          className={cn('mt-[16px]', frame.phone && 'flex min-h-0 flex-1 flex-col')}
          boxClassName={cn('px-[14px] pt-[14px] text-[14px]/[1.5]', frame.phone && 'min-h-[200px] flex-1')}
        />

        <footer className="mt-[14px] flex items-center gap-[8px]">
          <span className="text-[12px] text-sh-text-3">{words > 0 ? `${words} ${words === 1 ? 'word' : 'words'} · not saved yet` : ' '}</span>
          <Pill variant="control" size="lg" icon={X} className="ml-auto" onClick={discard}>
            Discard
          </Pill>
          <Pill
            variant="primary"
            size="lg"
            disabled={phase === 'requesting' || words === 0}
            title={words === 0 ? 'Dictate or type the note first' : undefined}
            className="disabled:opacity-40"
            onClick={save}
          >
            Save
          </Pill>
        </footer>
      </motion.div>
    </div>
  )
}

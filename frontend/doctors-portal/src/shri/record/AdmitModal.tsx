/**
 * §7.6 Admit — one button, one small modal, one confirmation, as the old
 * build's (`src/components/admission.tsx`). The doctor chooses where (Ward or
 * ICU), how soon (a priority, which must be picked — a critical patient is
 * never filed as Routine by default), and may add a line. That is all the
 * doctor is asked: no bed, no payer, no forms. `POST /admissions/create`
 * (`@/api/admissions`) is idempotent per patient and writes the audit row; the
 * front desk and bed allocation take it from there, and the patient's banner
 * chip says where it has got to. The shell draws the scrim and handles Esc.
 */

import { AnimatePresence, motion } from 'framer-motion'
import { BedDouble, Check, X } from 'lucide-react'
import { useState } from 'react'

import { createAdmission } from '@/api/admissions'
import { PRIORITY_LABEL, TYPE_LABEL, type AdmissionPriority, type AdmissionType } from '@/data/admissions'
import { encounterForPatient } from '@/data/clinical'
import { ageSex } from '@/data/format'
import type { IcdCode } from '@/data/icd10'
import { patient, type Patient } from '@/data/kit'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { useProblemsFor } from '../logic/record'
import { useShri } from '../state/store'
import { Alert } from '../ui/Alert'
import { useModalFrame } from '../ui/frames'
import { IcdField } from '../ui/IcdPicker'
import { useFocusTrap } from '../ui/hooks'
import { Icon, Pill, RoundButton, ToneDot } from '../ui/primitives'
import { VoiceField } from '../ui/VoiceField'

const TYPES: AdmissionType[] = ['ward', 'icu']
const PRIORITIES: { id: AdmissionPriority; cls: string; tone: 'crit' | 'warn' | 'pend' }[] = [
  { id: 'critical', cls: 'sh-tone-crit', tone: 'crit' },
  { id: 'urgent', cls: 'sh-tone-warn', tone: 'warn' },
  { id: 'routine', cls: 'sh-tone-pend', tone: 'pend' },
]

export function AdmitModal() {
  const patientId = useShri((s) => s.admitPatient)
  const closeAdmit = useShri((s) => s.closeAdmit)
  return <AnimatePresence>{patientId && <Modal key={patientId} patient={patient(patientId)} onClose={closeAdmit} />}</AnimatePresence>
}

function Modal({ patient: p, onClose }: { patient: Patient; onClose: () => void }) {
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const ref = useFocusTrap<HTMLDivElement>(true)
  const frame = useModalFrame(480)
  const [type, setType] = useState<AdmissionType>('ward')
  const [priority, setPriority] = useState<AdmissionPriority | null>(null)
  const [note, setNote] = useState('')
  const [diagnosis, setDiagnosis] = useState<IcdCode[]>([])
  // The patient's open problems, one tap each; any other code by search.
  const openProblems = useProblemsFor(p.id)
    .filter((pr) => pr.status === 'Open' && pr.leaf)
    .map((pr) => ({ code: pr.icd10, label: pr.label }))
  const [sending, setSending] = useState(false)
  /** Said in the modal as well as the toast: on a phone the sheet covers the toast stack. */
  const [failed, setFailed] = useState(false)

  async function confirm() {
    if (!priority || sending) return
    setSending(true)
    setFailed(false)
    try {
      await createAdmission({
        patientId: p.id,
        encounterId: encounterForPatient(p.id)?.id,
        type,
        priority,
        note,
        diagnosis: diagnosis[0],
        requestedBy: { id: me.id, name: me.name },
      })
      toast({ tone: 'info', title: `Admission in progress — ${p.name}`, detail: `${TYPE_LABEL[type]} · ${PRIORITY_LABEL[priority]}${diagnosis[0] ? ` · ${diagnosis[0].code}` : ''}` })
      onClose()
    } catch {
      setSending(false)
      setFailed(true)
      toast({ tone: 'critical', title: 'The admission did not go through', detail: 'Nothing was sent. Try Confirm again.' })
    }
  }

  return (
    <div className={cn(frame.outer, 'z-60')} style={frame.outerStyle}>
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admit-title"
        variants={frame.variants}
        initial="hidden"
        animate="shown"
        exit="exit"
        className={cn('rounded-sh-modal bg-sh-card p-[22px] shadow-sh-modal', frame.inner)}
      >
        <header className="flex items-center gap-[12px]">
          <span className="inline-flex size-[44px] shrink-0 items-center justify-center rounded-full bg-sh-accent text-sh-accent-ink">
            <Icon icon={BedDouble} size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="admit-title" className="truncate text-[19px]/[1.2] font-medium tracking-[-0.012em] text-sh-text">
              Admit {p.name}
            </h2>
            <div className="mt-[2px] truncate text-[12px] tabular-nums text-sh-text-3">
              {p.uhid} · {ageSex(p.age, p.sex)}
            </div>
          </div>
          <RoundButton icon={X} label="Close" size={38} onClick={onClose} />
        </header>

        <div className="mt-[20px]">
          <div id="admit-type" className="mb-[8px] text-[12px] font-medium text-sh-text-2">
            Type
          </div>
          <div role="radiogroup" aria-labelledby="admit-type" className="flex h-[44px] rounded-full bg-sh-control p-[2px]">
            {TYPES.map((t) => {
              const on = t === type
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-autofocus={t === 'ward' ? 'true' : undefined}
                  onClick={() => setType(t)}
                  className={cn(
                    'h-[40px] flex-1 rounded-full text-[13px] font-medium transition-colors duration-150',
                    on ? 'bg-sh-card text-sh-text shadow-[0_1px_3px_rgba(0,0,0,0.12)]' : 'text-sh-text-2 hover:text-sh-text',
                  )}
                >
                  {TYPE_LABEL[t]}
                </button>
              )
            })}
          </div>
        </div>

        <div className="mt-[18px]">
          <div id="admit-priority" className="mb-[8px] text-[12px] font-medium text-sh-text-2">
            Priority <span aria-hidden="true">*</span>
            <span className="sr-only">(required)</span>
          </div>
          <div role="radiogroup" aria-labelledby="admit-priority" aria-required="true" className="grid grid-cols-3 gap-[8px]">
            {PRIORITIES.map((pr) => {
              const on = pr.id === priority
              return (
                <button
                  key={pr.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setPriority(pr.id)}
                  className={cn(
                    pr.cls,
                    'inline-flex h-[48px] items-center justify-center gap-[8px] rounded-[14px] text-[13px] font-medium transition-colors duration-150',
                    on ? 'bg-(--t-bg) text-(--t-fg) shadow-[inset_0_0_0_2px_var(--t)]' : 'bg-sh-inner text-sh-text hover:bg-sh-hover-strong',
                  )}
                >
                  <ToneDot tone={pr.tone} />
                  {PRIORITY_LABEL[pr.id]}
                </button>
              )
            })}
          </div>
        </div>

        <IcdField
          id={`admit-dx-${p.id}`}
          label="Provisional diagnosis (ICD-10, optional)"
          value={diagnosis}
          onChange={setDiagnosis}
          suggestions={openProblems}
          className="mt-[18px]"
        />

        <VoiceField
          id={`admit-note-${p.id}`}
          label="Note (optional)"
          value={note}
          onChange={(v) => setNote(v)}
          rows={2}
          tidy={false}
          placeholder="Reason for admission, in a line — or press the microphone…"
          typedPlaceholder="Reason for admission, in a line…"
          className="mt-[18px]"
        />

        {failed && (
          <Alert tone="crit" role="alert" title="The admission did not go through" className="mt-[18px]">
            Nothing was sent. Try Confirm again.
          </Alert>
        )}

        <footer className="mt-[20px] flex items-center justify-end gap-[10px]">
          <Pill variant="control" size="lg" onClick={onClose}>
            Cancel
          </Pill>
          <Pill variant="primary" size="lg" icon={Check} disabled={!priority || sending} className="disabled:opacity-40" onClick={() => void confirm()}>
            Confirm
          </Pill>
        </footer>
      </motion.div>
    </div>
  )
}

/**
 * S-15-06 · Critical finding escalation — a modal, opened from the imaging
 * study (`src/screens/m15/S1506.tsx`): "A critical imaging finding reaching a
 * named clinician."
 *
 * The same principle as the critical lab value, for the same reason: a
 * finding left in a report queue has not been communicated. AI-407's fallback
 * is "radiologist-initiated escalation call", which is exactly what this
 * records — the call still happens; the record stops depending on someone
 * remembering it did.
 *
 * Where the old modal fell short: it recorded nothing but a toast — here the
 * escalation is on the audit trail and sent to the clinician told; and its
 * recipient opened on Dr. Rajsrinivas, whom the list leaves out when they are
 * the one escalating — here it opens on the first clinician the list offers.
 */

import { PhoneCall, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { NOW, formatTime } from '@/data/format'
import { STAFF, patient } from '@/data/kit'
import { useAudit } from '@/store/audit'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { useNotifications } from '../state/notifications'
import { Dialog } from '../ui/Dialog'
import { Why } from '../ui/Disclosure'
import { CheckboxRow, Field, Select } from '../ui/forms'
import { KeyValue } from '../ui/KeyValue'
import { Pill } from '../ui/primitives'
import { VoiceField } from '../ui/VoiceField'

const CHANNELS = ['Telephone, spoken to directly', 'Telephone, left a message with a named person', 'In person', 'Unable to reach — escalated to the on-call'] as const

export function EscalateDialog({ open, finding, studyId, patientId, onClose }: { open: boolean; finding: string; studyId: string; patientId: string; onClose: () => void }) {
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const send = useNotifications((s) => s.send)
  const clinicians = STAFF.filter((s) => s.identifierKind === 'HPR' && s.id !== me.id)
  // The choice is held by staff id: several clinicians can share a name.
  const [recipientId, setRecipientId] = useState(clinicians[0]?.id ?? '')
  const recipient = clinicians.find((s) => s.id === recipientId)?.name ?? ''
  const [channel, setChannel] = useState<string>(CHANNELS[0])
  const [detail, setDetail] = useState('')
  const [attested, setAttested] = useState(false)
  const [tried, setTried] = useState(false)

  const p = patient(patientId)
  const ready = attested && detail.trim().length >= 10

  function record() {
    if (!ready) {
      setTried(true)
      return
    }
    audit({ event: 'IMAGING.CRITICAL_ESCALATED', actor: me.name, actorId: me.id, subject: p.id, detail: `${finding} · study ${studyId} · told ${recipient} · ${channel} · “${detail.trim()}”` })
    send({ severity: 'critical', kind: 'result', title: `Critical finding — ${p.name}`, detail: `${finding} · study ${studyId} · ${channel}`, to: `/radiology/study/${studyId}/view`, recipient: 'colleague' })
    toast({ tone: 'success', title: `Escalated to ${recipient}`, detail: `${channel} at ${formatTime(NOW)}. Recorded against study ${studyId} and the patient record.` })
    setAttested(false)
    setDetail('')
    setTried(false)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      tone="warn"
      icon={TriangleAlert}
      width={560}
      title="Escalate a critical finding"
      subtitle="A finding left in a report queue has not been communicated"
      footer={
        <>
          <Pill variant="control" size="lg" onClick={onClose}>
            Cancel
          </Pill>
          <Pill variant="primary" size="lg" icon={PhoneCall} aria-disabled={!ready} className={cn(!ready && 'opacity-40')} onClick={record}>
            Record the escalation
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[14px]">
        <div className="rounded-[14px] bg-sh-warn-bg px-[16px] py-[12px]">
          <p className="font-semibold text-sh-warn-fg">{finding}</p>
          <p className="mt-[4px] text-[13px] tabular-nums text-sh-text-2">
            {p.name} · {p.age}/{p.sex}
            {p.bed ? ` · ${p.bed}` : ''} · study {studyId}
          </p>
        </div>
        <Field label="Who you told" required htmlFor="esc-recipient">
          <Select id="esc-recipient" value={recipientId} onChange={(e) => setRecipientId(e.target.value)}>
            {clinicians.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.personaLabel}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="How" htmlFor="esc-channel">
          <Select id="esc-channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {CHANNELS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
        </Field>
        <VoiceField
          id={`escalation-detail-${studyId}`}
          label="What you said"
          required
          rows={3}
          value={detail}
          onChange={setDetail}
          placeholder="New small right pleural effusion with extension of the consolidation. Suggested a repeat film in 24h and consideration of drainage if it enlarges…"
          typedPlaceholder="New small right pleural effusion with extension of the consolidation. Suggested a repeat film in 24h and consideration of drainage if it enlarges…"
        />
        {tried && detail.trim().length < 10 && <p className="text-[12px] font-medium text-sh-crit-fg">Say what you told them — at least 10 characters.</p>}
        <dl className="divide-y divide-(--line)">
          <KeyValue label="Escalated by">
            {me.name} · {me.identifierKind} {me.identifier}
          </KeyValue>
          <KeyValue label="At">
            <span className="tabular-nums">{formatTime(NOW)}</span>
          </KeyValue>
        </dl>
        <CheckboxRow checked={attested} onChange={setAttested} className="-mx-[10px] w-[calc(100%+20px)]">
          I have communicated this finding to the named clinician.
          <span className="block text-[12px] text-sh-text-3">Fixed wording. It is stamped with your name and the time, and it is what an audit reads.</span>
        </CheckboxRow>
        {tried && !attested && <p className="text-[12px] font-medium text-sh-crit-fg">Tick it once you have told them.</p>}
        <Why label="Why this modal exists">
          <p>
            AI-407 flagged this finding. The escalation is yours — the model cannot make a phone call. Who you told must be a named person, not a ward or a pool; if they cannot
            be reached, escalate to the on-call and record that too.
          </p>
          <p className="mt-[8px] text-sh-text-3">G2 gate. The report still has to be written — this records that somebody was told before it was.</p>
        </Why>
      </div>
    </Dialog>
  )
}

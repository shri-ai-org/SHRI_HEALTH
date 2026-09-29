/**
 * S-09-06 · Critical result acknowledgement — a modal (`src/screens/m09/
 * S0906.tsx`): "A critical value reaching a named human who must answer for
 * it."
 *
 * W-06-3 step 2!: "Interrupts a NAMED clinician who must acknowledge;
 * escalates if unacknowledged in the window." The distinction it has to make,
 * because it is the one clinicians get wrong: acknowledging records that you
 * SAW it; acting on it is documented separately. So it offers both, and does
 * not pretend the first is the second.
 *
 * Not dismissible (AIP-09): no Esc, no scrim, no ✕. Its dispositions are
 * Acknowledge only, Acknowledge and document, and Not me — reassign, which the
 * old dialog said was a disposition and then treated as a close. Here it
 * hands the result to a named consultant, on record; it stays unacknowledged
 * and the escalation clock keeps running.
 */

import { Check, PenLine, TriangleAlert, UserRoundX } from 'lucide-react'
import { useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { encounterForPatient, type ResultRow } from '@/data/clinical'
import { NOW, formatDateTime, formatTime } from '@/data/format'
import { STAFF, patient } from '@/data/kit'
import { useAudit } from '@/store/audit'
import { useClinical } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { ClinicalFlag } from '../record/bits'
import { useAiActive } from '../state/ai'
import { useNotifications } from '../state/notifications'
import { Dialog } from '../ui/Dialog'
import { Why } from '../ui/Disclosure'
import { CheckboxRow, Field, Select } from '../ui/forms'
import { Diamond, Pill } from '../ui/primitives'
import { VoiceField } from '../ui/VoiceField'

export function CriticalAck({ result: asked, onClose }: { result: ResultRow | null; onClose: () => void }) {
  const me = useCurrentStaff()
  const navigate = useNavigate()
  const aiActive = useAiActive()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const send = useNotifications((s) => s.send)
  const acknowledge = useClinical((s) => s.acknowledge)
  const reassignResult = useClinical((s) => s.reassignResult)
  const [attested, setAttested] = useState(false)
  const [action, setAction] = useState('')
  const [reassigning, setReassigning] = useState(false)
  const [to, setTo] = useState('')
  /** The result on screen — kept while the dialog closes, so it leaves with its content. */
  const [result, setResult] = useState(asked)
  const [openFor, setOpenFor] = useState(asked)
  const id = useId()

  // Every opening starts with nothing attested and nothing typed — reset while rendering the change, not in an effect.
  if (asked !== openFor) {
    setOpenFor(asked)
    if (asked) {
      setResult(asked)
      setAttested(false)
      setAction('')
      setReassigning(false)
      setTo('')
    }
  }

  const p = result ? patient(result.patientId) : undefined
  const enc = p ? encounterForPatient(p.id) : undefined
  const consultants = STAFF.filter((s) => s.identifierKind === 'HPR' && s.name !== me.name)

  function confirm(thenDocument: boolean) {
    if (!result || !p || !attested) return
    acknowledge(result.id, me.name, action.trim() || undefined)
    audit({
      event: 'RESULT.ACKNOWLEDGED',
      actor: me.name,
      actorId: me.id,
      subject: p.id,
      gate: 'G2',
      detail: `${result.test} ${result.value} ${result.unit} · unacknowledged ${result.unackMinutes ?? 0} min${action.trim() ? ` · ${action.trim()}` : ''}`,
    })
    onClose()
    toast({
      tone: 'success',
      title: 'Acknowledged',
      detail: `${me.name} at ${formatTime(NOW)}. Escalation stopped. ${thenDocument ? 'Now document what you did.' : 'Acting on it is still to be documented.'}`,
    })
    if (thenDocument && enc) navigate(enc.type === 'IP' ? `/ip/encounter/${enc.id}/note` : `/encounter/${enc.id}/note`)
  }

  function reassign() {
    if (!result || !p || !to) return
    reassignResult(result.id, to, me.name)
    audit({ event: 'RESULT.REASSIGNED', actor: me.name, actorId: me.id, subject: p.id, gate: 'G2', detail: `${result.test} ${result.value} ${result.unit} · to ${to}` })
    send({
      severity: 'critical',
      kind: 'result',
      title: `Critical result reassigned to ${to}`,
      detail: `${result.test} ${result.value} ${result.unit} · ${p.name} · still unacknowledged`,
      to: `/results/${result.id}`,
      recipient: 'colleague',
    })
    onClose()
    toast({ tone: 'caution', title: `Reassigned to ${to}`, detail: 'Addressed to them by name now. It is still unacknowledged, and the escalation clock keeps running.' })
  }

  return (
    <Dialog
      open={asked !== null}
      onClose={() => {}}
      dismissible={false}
      role="alertdialog"
      focusTitle
      tone="crit"
      icon={TriangleAlert}
      width={560}
      title="Critical result"
      subtitle={`Addressed to you by name · unacknowledged ${result?.unackMinutes ?? 0} minutes`}
      footer={
        reassigning ? (
          <>
            <Pill variant="control" size="lg" onClick={() => setReassigning(false)}>
              Back
            </Pill>
            <Pill variant="primary" size="lg" icon={UserRoundX} disabled={!to} className="disabled:opacity-40" onClick={reassign}>
              Reassign
            </Pill>
          </>
        ) : (
          <>
            <Pill variant="control" size="lg" icon={UserRoundX} onClick={() => setReassigning(true)}>
              Not me — reassign
            </Pill>
            <Pill variant="control" size="lg" icon={Check} disabled={!attested} className="disabled:opacity-40" onClick={() => confirm(false)}>
              Acknowledge only
            </Pill>
            <Pill variant="primary" size="lg" icon={PenLine} disabled={!attested} className="disabled:opacity-40" onClick={() => confirm(true)}>
              Acknowledge and document
            </Pill>
          </>
        )
      }
    >
      {result && p && (
        <div className="flex flex-col gap-[14px]">
          <div className="rounded-[16px] bg-sh-crit-bg px-[16px] py-[12px]">
            <p className="flex flex-wrap items-baseline gap-x-[10px] gap-y-[4px]">
              <span className="text-[17px] font-semibold text-sh-text">{result.test}</span>
              <span className="text-[24px] font-bold tabular-nums text-sh-crit-fg">
                {result.value} {result.unit}
              </span>
              <ClinicalFlag flag={result.flag} />
            </p>
            <p className="mt-[4px] text-[13px] tabular-nums text-sh-text-2">
              Reference {result.refRange}
              {result.priorValue && ` · prior ${result.priorValue} · ${result.delta}`}
            </p>
          </div>

          <dl className="flex flex-col">
            {[
              ['Patient', `${p.name} · ${p.age}/${p.sex}${p.bed ? ` · ${p.bed}` : ''}`],
              ['UHID', p.uhid],
              ['Reported', formatDateTime(result.reportedAt)],
              ['Addressed to', me.name],
            ].map(([k, v], i) => (
              <div key={k} className={`flex flex-wrap justify-between gap-[8px] py-[8px] ${i > 0 ? 'border-t border-sh-line' : 'pt-0'}`}>
                <dt className="text-[13px] text-sh-text-2">{k}</dt>
                <dd className="text-[13px] font-medium tabular-nums text-sh-text">{v}</dd>
              </div>
            ))}
            <div className="flex flex-wrap justify-between gap-[8px] border-t border-sh-line py-[8px]">
              <dt className="text-[13px] text-sh-text-2">Escalates at</dt>
              <dd className="text-[13px] font-semibold text-sh-crit-fg">15 minutes · to the on-call consultant</dd>
            </div>
          </dl>

          {reassigning ? (
            <Field label="Reassign to" htmlFor={`${id}-to`} required hint="The consultant it belongs to. It stays unacknowledged until they acknowledge it.">
              <Select id={`${id}-to`} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Choose a consultant…</option>
                {consultants.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name} · {c.personaLabel}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <>
              <CheckboxRow checked={attested} onChange={setAttested} className="-mx-[10px] w-[calc(100%+20px)]">
                I have seen this result. <span className="text-sh-text-3">Fixed wording — it is not editable.</span>
              </CheckboxRow>
              <VoiceField
                id={`critical-action-${result.id}`}
                label="What you are doing about it"
                rows={2}
                value={action}
                onChange={setAction}
                placeholder="Calcium gluconate and insulin-dextrose given, ECG requested, repeat in 1 hour…"
                hint="Optional here, required in the record — acknowledging records only that you saw it."
              />
            </>
          )}

          <Why label="Why this fired, and why it cannot be dismissed">
            {aiActive && (
              <p className="flex flex-wrap items-center gap-[8px]">
                <Diamond />
                {result.aiReason}
              </p>
            )}
            <p>The threshold is rule-based and never fully off. The model ranks and explains; it does not decide what counts as critical.</p>
            <p className="text-sh-text-3">AI-213 · G2 gate. This dialog cannot be dismissed without a disposition — reassigning is a disposition, closing it is not.</p>
          </Why>
        </div>
      )}
    </Dialog>
  )
}

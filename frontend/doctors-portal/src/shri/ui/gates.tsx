/**
 * The two gates of S-06-07, ported from `src/components/ai.tsx:998-1255` into
 * this build's look.
 *
 * `HardStopGate` — AIP-09: "C-31 modal, NOT DISMISSIBLE WITHOUT A
 * DISPOSITION." No Esc, no scrim, no ✕: the way out is an alternative, removing
 * the drug, or an override. The block is deterministic — a rule, not the
 * model's opinion — and it fires with the AI switched off.
 *
 * `DualSignatureGate` — §4.4 G4: "C-31 modal plus second-user
 * authentication; reason mandatory; BOTH identities recorded." Its fields open
 * empty every time, so a PIN typed once never waits in a closed dialog (the
 * old dialog kept it after Cancel).
 *
 * SHRI_HEALTH: with the API, both gates take `withApi`. The contract's override
 * (`overrideAlert`, D97, D110) is the prescriber's own reason, at least 3
 * characters, and only MD and APP may give it: no second signer, no PIN and no
 * sample staff list. The hard stop then shows the server's rule and finding,
 * without the sample's alternatives or capability note.
 */

import { Check, OctagonAlert, ShieldAlert, ShieldCheck, Signature, TriangleAlert, Undo2 } from 'lucide-react'
import { useId, useState } from 'react'

import { REJECTION_REASONS, type RejectionReason } from '@/atlas/dispositions'
import type { HardStop } from '@/data/clinical'

import { useAiActive } from '../state/ai'

import { Alert } from './Alert'
import { Dialog } from './Dialog'
import { CheckboxRow, Field, Select, TextArea, TextInput } from './forms'
import { Icon, Pill } from './primitives'

export function HardStopGate({
  open,
  drug,
  rule,
  finding,
  documentedAt,
  documentedBy,
  alternatives,
  onAcceptAlternative,
  onOverride,
  onCancel,
  capabilityId,
  overrideBlocked,
  withApi = false,
}: {
  open: boolean
  /** What was blocked. */
  drug: string
  rule: string
  finding: string
  documentedAt: string
  documentedBy: string
  alternatives: HardStop['alternatives']
  onAcceptAlternative: (drug: string) => void
  onOverride: () => void
  onCancel: () => void
  capabilityId: string
  /** Why this persona cannot start an override — the capability it lacks. */
  overrideBlocked?: string
  /** With the API: the server's rule, overridden with the prescriber's own reason. */
  withApi?: boolean
}) {
  const aiActive = useAiActive()
  const alternativesId = useId()

  return (
    <Dialog
      open={open}
      onClose={() => {}}
      dismissible={false}
      role="alertdialog"
      focusTitle
      tone="crit"
      icon={OctagonAlert}
      width={640}
      title="Prescription blocked"
      subtitle={`${rule} · this is a fixed rule, not a model output`}
      footer={
        <>
          <Pill variant="control" size="lg" icon={Undo2} onClick={onCancel}>
            Remove {drug}
          </Pill>
          <Pill
            variant="crit"
            size="lg"
            icon={ShieldAlert}
            disabled={overrideBlocked !== undefined}
            title={overrideBlocked}
            className="disabled:opacity-40"
            onClick={onOverride}
          >
            {withApi ? 'Override with a reason' : 'Override — needs a second consultant'}
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[14px]">
        <div className="rounded-[16px] bg-sh-crit-bg px-[16px] py-[12px]">
          <p className="text-[14px] font-semibold text-sh-crit-fg">{drug} cannot be signed for this patient.</p>
          <p className="mt-[6px] text-[14px]/[1.5] text-sh-text">{finding}</p>
          {!withApi && (
            <p className="mt-[8px] text-[12px] tabular-nums text-sh-text-2">
              Allergy documented {documentedAt} by {documentedBy}.
            </p>
          )}
        </div>

        {/* The distinction that makes the whole demo work: with the AI off, the static tables still block. */}
        {!withApi && (
        <div className="flex items-start gap-[10px] rounded-[16px] bg-sh-inner px-[16px] py-[12px] text-[13px]/[1.55] text-sh-text-2">
          <Icon icon={ShieldCheck} size={16} className="mt-[2px] shrink-0 text-sh-text" />
          <p>
            {aiActive ? (
              <>
                <strong className="font-semibold text-sh-text">{capabilityId}</strong> surfaced this, but the block itself is a static allergy-class rule. It
                fires identically when the AI is switched off — safety is never gated on a model being up.
              </>
            ) : (
              <>
                The AI is currently off. <strong className="font-semibold text-sh-text">This block still fired</strong>, because the static interaction and
                allergy tables are never fully off.
              </>
            )}
          </p>
        </div>
        )}

        {overrideBlocked && <p className="text-[13px] font-medium text-sh-warn-fg">{overrideBlocked}</p>}

        {alternatives.length > 0 && (
        <div>
          <h3 id={alternativesId} className="text-[13px] font-semibold text-sh-text-2">
            Three alternatives with no beta-lactam cross-reactivity
          </h3>
          <ul aria-labelledby={alternativesId} className="mt-[8px] flex flex-col gap-[8px]">
            {alternatives.map((a) => (
              <li key={a.drug} className="rounded-[16px] bg-sh-inner p-[14px]">
                <div className="flex flex-wrap items-start justify-between gap-[8px]">
                  <div className="min-w-0">
                    <p className="text-[14px] font-semibold text-sh-text">{a.drug}</p>
                    <p className="text-[13px] tabular-nums text-sh-text-2">
                      {a.dose} · {a.route} · {a.frequency}
                    </p>
                  </div>
                  <Pill variant="primary" size="md" icon={Check} aria-label={`Use ${a.drug}`} onClick={() => onAcceptAlternative(a.drug)}>
                    Use this
                  </Pill>
                </div>
                <p className="mt-[8px] text-[13px]/[1.5] text-sh-text-2">{a.rationale}</p>
                {a.caution && (
                  <p className="mt-[8px] flex items-start gap-[6px] rounded-[12px] bg-sh-warn-bg px-[10px] py-[6px] text-[12px] font-medium text-sh-warn-fg">
                    <Icon icon={TriangleAlert} size={13} className="mt-[2px] shrink-0" />
                    {a.caution}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
        )}
      </div>
    </Dialog>
  )
}

export interface DualSignature {
  reason: RejectionReason
  reasonText: string
  coSigner: string
}

interface OverrideGateProps {
  open: boolean
  what: string
  auditEvent: string
  prescriber: string
  onCancel: () => void
  onConfirm: (args: DualSignature) => void
  coSignerOptions: { name: string; identifier: string }[]
  /** With the API: the prescriber's own reason only (overrideAlert); `coSignerOptions` is not used. */
  reasonOnly?: boolean
}

export function DualSignatureGate({ reasonOnly = false, ...props }: OverrideGateProps) {
  return reasonOnly ? <ReasonOverrideGate {...props} /> : <TwoPersonGate {...props} />
}

/** The contract's override needs at least this many characters of reason (AlertOverride.reason). */
const MIN_REASON = 3

/** With the API: the prescriber's own reason and responsibility, nothing else (D97, D110). */
function ReasonOverrideGate({ open, what, auditEvent, prescriber, onCancel, onConfirm }: Omit<OverrideGateProps, 'reasonOnly'>) {
  const [reasonText, setReasonText] = useState('')
  const [attested, setAttested] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  const id = useId()

  // Every opening starts empty — reset while rendering the change, not in an effect after it.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setReasonText('')
      setAttested(false)
    }
  }

  const ready = reasonText.trim().length >= MIN_REASON && attested

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      role="alertdialog"
      tone="crit"
      icon={ShieldAlert}
      width={560}
      title="Override this alert"
      subtitle="Your reason is recorded with the alert and audited."
      footer={
        <>
          <Pill variant="control" size="lg" onClick={onCancel}>
            Cancel
          </Pill>
          <Pill
            variant="crit"
            size="lg"
            icon={Signature}
            disabled={!ready}
            className="disabled:opacity-40"
            onClick={() => {
              if (!ready) return
              onConfirm({ reason: 'Other', reasonText: reasonText.trim(), coSigner: '' })
            }}
          >
            Override and proceed
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[16px]">
        <Alert tone="crit" icon={ShieldAlert} title="You are proceeding past a safety alert">
          {what} This is audited as <code className="font-mono text-[12px] text-sh-text">{auditEvent}</code>.
        </Alert>

        <Field label="Reason for overriding" htmlFor={`${id}-reason`} required>
          <TextArea
            id={`${id}-reason`}
            rows={3}
            placeholder="Why you are going ahead (at least 3 characters)…"
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
          />
        </Field>

        <CheckboxRow checked={attested} onChange={setAttested} className="-mx-[10px] w-[calc(100%+20px)]">
          I accept responsibility for overriding this alert. <span className="text-sh-text-3">Prescriber: {prescriber}</span>
        </CheckboxRow>
      </div>
    </Dialog>
  )
}

function TwoPersonGate({
  open,
  what,
  auditEvent,
  prescriber,
  onCancel,
  onConfirm,
  coSignerOptions,
}: Omit<OverrideGateProps, 'reasonOnly'>) {
  const [reason, setReason] = useState<RejectionReason>('Other')
  const [reasonText, setReasonText] = useState('')
  // The choice is held by identifier: several consultants can share a name.
  const [coSignerId, setCoSignerId] = useState('')
  const coSigner = coSignerOptions.find((c) => c.identifier === coSignerId)?.name ?? ''
  const [pin, setPin] = useState('')
  const [attested, setAttested] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  const id = useId()

  // Every opening starts empty — reset while rendering the change, not in an effect after it.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setReason('Other')
      setReasonText('')
      setCoSignerId('')
      setPin('')
      setAttested(false)
    }
  }

  const ready = reasonText.trim().length >= 10 && coSigner !== '' && pin.length >= 4 && attested

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      role="alertdialog"
      tone="crit"
      icon={ShieldAlert}
      width={560}
      title="Dual signature required"
      subtitle="G4 — a second qualified consultant must authenticate. Both identities are recorded."
      footer={
        <>
          <Pill variant="control" size="lg" onClick={onCancel}>
            Cancel
          </Pill>
          <Pill
            variant="crit"
            size="lg"
            icon={Signature}
            disabled={!ready}
            className="disabled:opacity-40"
            onClick={() => {
              if (!ready) return
              onConfirm({ reason, reasonText: reasonText.trim(), coSigner })
            }}
          >
            Override and proceed
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[16px]">
        <Alert tone="crit" icon={ShieldAlert} title="You are proceeding past a hard stop">
          {what} This is audited as <code className="font-mono text-[12px] text-sh-text">{auditEvent}</code> and reviewed within 24 hours.
        </Alert>

        <Field label="Reason" htmlFor={`${id}-reason`} required>
          <Select id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value as RejectionReason)}>
            {REJECTION_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <TextArea
            rows={3}
            aria-label="Clinical justification"
            placeholder="State the clinical justification — at least ten characters, and it is read at review…"
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2">
          <Field label="Second consultant" htmlFor={`${id}-cosigner`} required>
            <Select id={`${id}-cosigner`} value={coSignerId} onChange={(e) => setCoSignerId(e.target.value)}>
              <option value="">Select a consultant…</option>
              {coSignerOptions
                .filter((c) => c.name !== prescriber)
                .map((c) => (
                  <option key={c.identifier} value={c.identifier}>
                    {c.name} · {c.identifier}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Their authentication" htmlFor={`${id}-pin`} required>
            <TextInput
              id={`${id}-pin`}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder="4-digit PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="tracking-[0.3em]"
            />
          </Field>
        </div>

        <CheckboxRow checked={attested} onChange={setAttested} className="-mx-[10px] w-[calc(100%+20px)]">
          We have both reviewed the documented allergy and the alternatives offered, and accept clinical responsibility for proceeding.{' '}
          <span className="text-sh-text-3">Prescriber: {prescriber}</span>
        </CheckboxRow>
      </div>
    </Dialog>
  )
}

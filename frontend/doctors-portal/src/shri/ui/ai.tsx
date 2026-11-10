/**
 * The AI interaction language, ported from `src/components/ai.tsx` (C-41 and
 * AIP-01/02/03) into this build's look. §2.3: "one interaction language … a
 * clinician who learns how to accept an AI suggestion in the outpatient note
 * already knows how to accept one in the bed board, the coding queue and the
 * stroke console. CONSISTENCY IS A CLINICAL-SAFETY PROPERTY."
 *
 * The rules are the old build's, from `@/atlas`: a LOW suggestion arrives
 * collapsed and cannot be accepted until it is expanded (`acceptanceBlocked`);
 * G0 shows no confidence (`gateShowsConfidence`); a rejection needs one of the
 * fixed five reasons (`REJECTION_REASONS`); every decision is recorded in
 * `useAI` against the model version, and Undo clears it. The action bar never
 * collapses into an overflow menu — a hidden Reject is how AI output gets
 * accepted by default. Everything renders nothing while the AI fabric is off.
 *
 * G3 is the atlas's fixed treatment — "C-41 plus a signature block and a
 * fixed-wording 'I have reviewed this content' checkbox" — which the old bar
 * never drew: Accept and Edit wait for the checkbox, the decision is signed
 * with the clinician's name, number and time, and it is on the audit trail.
 */

import { Ban, Check, ChevronDown, Clock, Pencil, Signature, TriangleAlert, Undo2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { capability } from '@/atlas/capabilities'
import { BAND_SPECS, acceptanceBlocked, type ConfidenceBand } from '@/atlas/confidence'
import { REJECTION_REASONS, type Disposition, type RejectionReason } from '@/atlas/dispositions'
import { GATE_SPECS, gateShowsConfidence, type Gate } from '@/atlas/gates'
import type { AssistantAnswer } from '@/data/assistant'
import { formatDateTime } from '@/data/format'
import { useAI } from '@/store/ai'
import { useAudit } from '@/store/audit'
import { useCurrentStaff } from '@/store/session'
import { useUI, type ExplainTarget } from '@/store/ui'

import { cn } from '../lib/cn'
import type { Tone } from '../mocks/types'
import { useAiActive } from '../state/ai'

import { Dialog } from './Dialog'
import { CheckboxRow, TextArea } from './forms'
import { Card, ConfidenceMark, Diamond, Icon, Pill, PillTag } from './primitives'

/** The gate, legible on the screen: its id and name, its treatment on hover. */
export function GateBadge({ gate, className }: { gate: Gate; className?: string }) {
  const spec = GATE_SPECS[gate]
  const tone: Tone = gate === 'G4' ? 'crit' : gate === 'G3' ? 'warn' : 'pend'
  return (
    <PillTag tone={tone} size="xs" className={cn('font-semibold', className)} title={spec.treatment}>
      {gate} {spec.name}
    </PillTag>
  )
}

/** The Why? link — mandatory wherever explainability is. */
export function WhyLink({ target, className }: { target: ExplainTarget; className?: string }) {
  const openExplain = useUI((s) => s.openExplain)
  return (
    <button
      type="button"
      onClick={() => openExplain(target)}
      className={cn('inline-flex min-h-[32px] items-center text-[12px] font-semibold text-sh-text underline-offset-2 hover:underline', className)}
    >
      Why?
    </button>
  )
}

const DECIDED_TONE: Record<Disposition, Tone> = {
  Accepted: 'norm',
  'Accepted with edits': 'norm',
  Rejected: 'warn',
  Deferred: 'warn',
  Overridden: 'crit',
}

/**
 * C-41 — Accept, Edit, Reject (and Defer at G2) as a real button group, the
 * confidence band, the gate and a Why?. Once decided: the decision, who, the
 * capability, and Undo.
 */
export function AIActionBar({
  touchpointId,
  capabilityId,
  gate,
  band,
  score,
  explain,
  onAccept,
  onEdit,
  onReject,
  expanded = true,
  onUndo,
  locked = false,
  subject,
  attestation = 'here',
  className,
}: {
  touchpointId: string
  capabilityId: string
  gate: Gate
  band: ConfidenceBand
  score?: number
  explain: ExplainTarget
  onAccept?: () => void
  onEdit?: () => void
  onReject?: (reason: RejectionReason, text?: string) => void
  /** LOW arrives collapsed; acceptance is blocked until it is expanded. */
  expanded?: boolean
  /** Called after Undo clears the disposition, so the caller can restore its field. */
  onUndo?: () => void
  /** A signed record: decisions are frozen. Buttons stay visible, disabled, never hidden. */
  locked?: boolean
  /** The patient the output concerns — the subject of a G3 attestation's audit row. */
  subject?: string
  /**
   * Where a G3 decision is attested: on this bar (its own checkbox and signature
   * line), or once for the whole document by the page — a discharge summary's six
   * drafted sections are attested by one fixed-wording declaration and the
   * signature, not six checkboxes.
   */
  attestation?: 'here' | 'page'
  className?: string
}) {
  const [rejecting, setRejecting] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const staff = useCurrentStaff()
  const record = useAI((s) => s.record)
  const disposition = useAI((s) => s.dispositions[touchpointId])
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)

  const g3 = gate === 'G3' && attestation === 'here'
  const blocked = acceptanceBlocked(band, expanded) || locked
  const unattested = g3 && !reviewed
  const spec = capability(capabilityId)
  const lockedTitle = locked ? 'Signed — the note is locked' : undefined
  const attestTitle = unattested ? 'Tick “I have reviewed this content” first — a G3 entry is attested, not merely confirmed' : undefined

  function apply(d: Disposition, reason?: RejectionReason, reasonText?: string) {
    record({ touchpointId, disposition: d, by: staff.name, modelVersion: explain.model, confidence: band, reason, reasonText })
    if (g3 && (d === 'Accepted' || d === 'Accepted with edits')) {
      audit({
        event: 'AI.ATTESTED',
        actor: staff.name,
        actorId: staff.id,
        subject,
        model: explain.model,
        gate: 'G3',
        detail: `${spec.id} · ${d} · ${staff.identifierKind} ${staff.identifier}`,
      })
    }
  }

  if (disposition) {
    const attested = g3 && (disposition.disposition === 'Accepted' || disposition.disposition === 'Accepted with edits')
    return (
      <div className={cn('flex flex-wrap items-center gap-x-[10px] gap-y-[4px]', className)}>
        <PillTag
          tone={DECIDED_TONE[disposition.disposition]}
          size="sm"
          icon={disposition.disposition === 'Rejected' ? X : disposition.disposition === 'Deferred' ? Clock : Check}
          className="font-medium"
        >
          {disposition.disposition}
        </PillTag>
        {disposition.reason && <span className="text-[12px] text-sh-text-3">{disposition.reason}</span>}
        <span className="text-[12px] text-sh-text-3">
          by {disposition.by} · {spec.id}
        </span>
        {/* G3's signature block: who attested, under which number, when. */}
        {attested && (
          <span className="text-[12px] tabular-nums text-sh-text-2">
            Attested{disposition.by === staff.name ? ` · ${staff.identifierKind} ${staff.identifier}` : ''} · {formatDateTime(new Date(disposition.at))}
          </span>
        )}
        <WhyLink target={explain} />
        {!locked && (
          <button
            type="button"
            title="Undo the decision and return to the draft. Words typed since are discarded."
            onClick={() => {
              useAI.getState().clearDisposition(touchpointId)
              onUndo?.()
            }}
            className="ml-auto inline-flex min-h-[32px] items-center text-[12px] font-medium text-sh-text-2 underline decoration-dotted underline-offset-2 hover:text-sh-text"
          >
            Undo
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      {g3 && !locked && (
        <CheckboxRow checked={reviewed} onChange={setReviewed} className="-mx-[10px] mb-[4px] w-[calc(100%+20px)]">
          I have reviewed this content
        </CheckboxRow>
      )}
      <div className={cn('flex flex-wrap items-center gap-x-[10px] gap-y-[10px]', className)}>
        {/* A real button group, never an overflow menu — so it wraps rather than collapsing in a narrow rail.
            Wrapped rows sit 10px apart, so each 34px button keeps a 44px target of its own on a phone. */}
        <div role="group" aria-label={`Disposition for ${spec.name}`} className="flex flex-wrap items-center gap-x-[6px] gap-y-[10px]">
          <Pill
            variant="accent"
            size="md"
            icon={Check}
            disabled={blocked || unattested}
            title={lockedTitle ?? (blocked ? 'Expand the suggestion before accepting — low confidence' : attestTitle)}
            className="disabled:opacity-40"
            onClick={() => {
              apply('Accepted')
              onAccept?.()
            }}
          >
            Accept
          </Pill>
          <Pill
            variant="control"
            size="md"
            icon={Pencil}
            disabled={locked || unattested}
            title={lockedTitle ?? attestTitle}
            className="disabled:opacity-40"
            onClick={() => {
              apply('Accepted with edits')
              onEdit?.()
            }}
          >
            Edit
          </Pill>
          <Pill variant="ghost" size="md" icon={X} disabled={locked} title={lockedTitle} className="disabled:opacity-40" onClick={() => setRejecting(true)}>
            Reject
          </Pill>
          {gate === 'G2' && (
            <Pill
              variant="ghost"
              size="md"
              icon={Clock}
              disabled={locked}
              title={lockedTitle ?? 'Leave undecided for now — the section cannot be signed until you decide'}
              className="disabled:opacity-40"
              onClick={() => apply('Deferred')}
            >
              Defer
            </Pill>
          )}
        </div>
        {gateShowsConfidence(gate) && <ConfidenceMark band={band} score={score} />}
        <GateBadge gate={gate} />
        <WhyLink target={explain} className="ml-auto" />
      </div>

      {blocked && !locked && (
        <p className="mt-[8px] flex items-center gap-[6px] text-[12px] font-medium text-sh-warn-fg">
          <Icon icon={TriangleAlert} size={13} />
          Low confidence — expand and read it before accepting.
        </p>
      )}

      <RejectDialog
        open={rejecting}
        capabilityName={spec.name}
        onCancel={() => setRejecting(false)}
        onConfirm={(reason, text) => {
          apply('Rejected', reason, text)
          onReject?.(reason, text)
          setRejecting(false)
          toast({ tone: 'info', title: 'Rejection recorded', detail: `${reason} · fed back to model governance` })
        }}
      />
    </>
  )
}

/** §4.6 — the fixed five reasons plus free text. No module invents a sixth. */
export function RejectDialog({
  open,
  capabilityName,
  onCancel,
  onConfirm,
}: {
  open: boolean
  capabilityName: string
  onCancel: () => void
  onConfirm: (reason: RejectionReason, text?: string) => void
}) {
  const [reason, setReason] = useState<RejectionReason>('Clinically incorrect')
  const [text, setText] = useState('')
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Reject this suggestion"
      subtitle={`${capabilityName} · a reason is required`}
      icon={X}
      footer={
        <>
          <Pill variant="control" size="lg" onClick={onCancel}>
            Cancel
          </Pill>
          <Pill
            variant="primary"
            size="lg"
            disabled={reason === 'Other' && text.trim().length < 3}
            className="disabled:opacity-40"
            onClick={() => onConfirm(reason, text.trim() || undefined)}
          >
            Record rejection
          </Pill>
        </>
      }
    >
      <p className="mb-[12px] text-[14px]/[1.5] text-sh-text-2">
        The reason is recorded against the model version and feeds model governance. It is how a rule that is wrong gets found.
      </p>
      <div role="radiogroup" aria-label="Reason" className="flex flex-col gap-[2px]">
        {REJECTION_REASONS.map((r) => (
          <label key={r} className="flex min-h-[44px] cursor-pointer items-center gap-[10px] rounded-[12px] px-[6px] text-[14px] text-sh-text hover:bg-sh-hover">
            <input type="radio" name="reject-reason" checked={reason === r} onChange={() => setReason(r)} className="size-[18px] accent-(--accent-2)" />
            {r}
          </label>
        ))}
      </div>
      {reason === 'Other' && (
        <TextArea className="mt-[12px]" rows={3} aria-label="What was wrong with it" placeholder="Say what was wrong with it…" value={text} onChange={(e) => setText(e.target.value)} />
      )}
    </Dialog>
  )
}

/**
 * AIP-01 / §4.3 — "85% opacity, left accent rule, C-41 action bar beneath.
 * GHOST TEXT SITS IN THE FIELD, NOT IN A SIDE CARD." The draft shows only while
 * the section is undecided and empty; once text exists the field is the
 * surface and the draft never returns over it.
 */
export function GhostSection({
  touchpointId,
  capabilityId,
  label,
  draft,
  band,
  score,
  gate,
  explain,
  value,
  field,
  onAccept,
  onEdit,
  onReject,
  onUndo,
  defaultExpanded,
  locked,
  attestation,
}: {
  touchpointId: string
  capabilityId: string
  label: string
  /** The AI draft. Absent means nothing was drafted: the section is the clinician's `field`. */
  draft?: string
  band: ConfidenceBand
  score?: number
  gate: Gate
  explain: ExplainTarget
  /** The stored text — the truth of what will be signed. */
  value: string
  /** The one editing surface (a `VoiceField`), in every state but the undecided ghost. */
  field: ReactNode
  onAccept: () => void
  onEdit: () => void
  onReject: () => void
  onUndo: () => void
  /** A LOW section arrives collapsed. */
  defaultExpanded?: boolean
  locked?: boolean
  /** G3 attested on the bar, or by the page (see `AIActionBar`). */
  attestation?: 'here' | 'page'
}) {
  const aiActive = useAiActive()
  const expandedMap = useAI((s) => s.expanded)
  const expand = useAI((s) => s.expand)
  const disposition = useAI((s) => s.dispositions[touchpointId])

  const isExpanded = expandedMap[touchpointId] ?? defaultExpanded ?? band !== 'LOW'

  // AI off (§1.5) or nothing drafted: the section is the clinician's field.
  if (!aiActive || draft === undefined) return <>{field}</>

  const undecided = disposition === undefined || disposition.disposition === 'Deferred'
  const showGhost = undecided && value.trim() === ''

  return (
    <div className="min-w-0">
      {showGhost ? (
        <>
          <div className={cn('flex flex-wrap items-center justify-between gap-[8px]', band === 'LOW' && !isExpanded ? 'mb-[10px]' : 'mb-[6px]')}>
            <label htmlFor={touchpointId} className="flex items-center gap-[6px] text-[13px] font-medium text-sh-text-2">
              {label} <span className="text-sh-crit-fg" aria-hidden="true">*</span>
              <span className="sr-only">(required)</span>
              <Diamond />
              <span className="text-[12px] font-normal text-sh-text-3">AI draft</span>
            </label>
            {band === 'LOW' && !isExpanded && (
              <Pill variant="tone" tone="warn" size="sm" icon={ChevronDown} onClick={() => expand(touchpointId)}>
                Expand to review
              </Pill>
            )}
          </div>
          <div
            id={touchpointId}
            role="region"
            // Every ◆ region carries its confidence band in its accessible name.
            aria-label={`${label} — AI draft, ${BAND_SPECS[band].label}`}
            className={cn(
              'rounded-[16px] border-l-[3px] border-sh-ai bg-sh-inner px-[14px] py-[10px] text-[14px]/[1.55] text-sh-text opacity-85',
              !isExpanded && 'max-h-[56px] overflow-hidden',
            )}
          >
            {isExpanded ? draft : `${draft.slice(0, 92)}…`}
          </div>
        </>
      ) : (
        field
      )}

      {/* C-41 beneath, never beside. */}
      <AIActionBar
        className="mt-[8px]"
        touchpointId={touchpointId}
        capabilityId={capabilityId}
        gate={gate}
        band={band}
        score={score}
        explain={explain}
        expanded={isExpanded}
        locked={locked}
        onAccept={onAccept}
        onEdit={onEdit}
        onReject={onReject}
        onUndo={onUndo}
        attestation={attestation}
      />
    </div>
  )
}

/** AIP-02 — a suggestion chip inside a field: ◆, the band, accept or dismiss; blocked by a rule where one applies. */
export function FieldChip({
  touchpointId,
  capabilityId,
  suggestion,
  band,
  score,
  gate,
  explain,
  onAccept,
  onUndo,
  disabledReason,
  locked = false,
}: {
  touchpointId: string
  capabilityId: string
  suggestion: string
  band: ConfidenceBand
  score?: number
  gate: Gate
  explain: ExplainTarget
  onAccept: () => void
  onUndo?: () => void
  /** Where the suggestion is blocked by a rule — a parent-only code, say. */
  disabledReason?: string
  locked?: boolean
}) {
  const aiActive = useAiActive()
  const staff = useCurrentStaff()
  const record = useAI((s) => s.record)
  const disposition = useAI((s) => s.dispositions[touchpointId])

  if (!aiActive) return null

  if (disposition) {
    return (
      <span className="inline-flex items-center gap-[6px]">
        <PillTag tone={disposition.disposition === 'Rejected' ? 'neu' : 'norm'} size="sm" icon={disposition.disposition === 'Rejected' ? X : Check}>
          {disposition.disposition}
        </PillTag>
        {!locked && (
          <button
            type="button"
            title="Undo the decision"
            onClick={() => {
              useAI.getState().clearDisposition(touchpointId)
              onUndo?.()
            }}
            className="inline-flex min-h-[32px] items-center text-[12px] font-medium text-sh-text-2 underline decoration-dotted underline-offset-2 hover:text-sh-text"
          >
            Undo
          </button>
        )}
      </span>
    )
  }

  if (locked) return null

  return (
    <span
      role="region"
      aria-label={`${capabilityId} suggestion: ${suggestion}, ${BAND_SPECS[band].label}`}
      // 36px controls 8px apart, so each keeps a 44px target of its own inside the chip.
      className={cn('inline-flex min-h-[44px] flex-wrap items-center gap-[8px] rounded-full bg-sh-inner py-[4px] pl-[12px] pr-[4px] text-[12px] shadow-[inset_0_0_0_1px_var(--flags-ring)]', disabledReason && 'opacity-80')}
    >
      <Diamond />
      <span className="font-medium text-sh-text">{suggestion}</span>
      <ConfidenceMark band={band} short score={score} />
      {disabledReason ? (
        <span title={disabledReason} className="inline-flex items-center gap-[4px] pr-[6px] font-medium text-sh-warn-fg">
          <Icon icon={Ban} size={12} /> blocked
        </span>
      ) : (
        <>
          <button
            type="button"
            aria-label={`Accept ${suggestion}`}
            title="Accept"
            onClick={() => {
              record({ touchpointId, disposition: 'Accepted', by: staff.name, modelVersion: explain.model, confidence: band })
              onAccept()
            }}
            className="inline-flex size-[36px] items-center justify-center rounded-full text-sh-norm-fg hover:bg-sh-norm-bg"
          >
            <Icon icon={Check} size={15} />
          </button>
          <button
            type="button"
            aria-label={`Dismiss ${suggestion}`}
            title="Dismiss"
            onClick={() =>
              record({ touchpointId, disposition: 'Rejected', by: staff.name, modelVersion: explain.model, confidence: band, reason: 'Not relevant to this patient' })
            }
            className="inline-flex size-[36px] items-center justify-center rounded-full text-sh-text-3 hover:bg-sh-hover-strong"
          >
            <Icon icon={X} size={15} />
          </button>
        </>
      )}
      {gateShowsConfidence(gate) && <WhyLink target={explain} className="min-h-[36px] px-[6px]" />}
    </span>
  )
}

/** AIP-03 — a rail card: ◆ title, the evidence line, a caution where one applies, and C-41 beneath. */
export function SuggestionCard({
  touchpointId,
  capabilityId,
  title,
  evidence,
  band,
  score,
  gate,
  explain,
  onAccept,
  caution,
  children,
}: {
  touchpointId: string
  capabilityId: string
  title: ReactNode
  evidence: string
  band: ConfidenceBand
  score?: number
  gate: Gate
  explain: ExplainTarget
  onAccept?: () => void
  caution?: string
  children?: ReactNode
}) {
  const aiActive = useAiActive()
  const expandedMap = useAI((s) => s.expanded)
  const expand = useAI((s) => s.expand)
  if (!aiActive) return null
  const isExpanded = expandedMap[touchpointId] ?? band !== 'LOW'

  return (
    <Card as="article" role="region" aria-label={`${capabilityId} suggestion, ${BAND_SPECS[band].label}`} className="border-l-[3px] border-sh-ai p-[16px]">
      <div className="flex items-start justify-between gap-[8px]">
        <h3 className="flex items-center gap-[8px] text-[14px] font-semibold text-sh-text">
          <Diamond />
          <span>{title}</span>
        </h3>
        <span className="shrink-0 whitespace-nowrap text-[12px] text-sh-text-3">{capabilityId}</span>
      </div>

      {band === 'LOW' && !isExpanded ? (
        <button
          type="button"
          onClick={() => expand(touchpointId)}
          className="mt-[8px] flex min-h-[44px] w-full items-center gap-[8px] rounded-[12px] bg-sh-warn-bg px-[12px] text-left text-[13px] font-medium text-sh-warn-fg"
        >
          <Icon icon={ChevronDown} size={14} />
          Low confidence — expand to read before accepting
        </button>
      ) : (
        <>
          <p className="mt-[6px] text-[13px]/[1.5] text-sh-text-2">{evidence}</p>
          {children && <div className="mt-[8px]">{children}</div>}
          {caution && (
            <p className="mt-[8px] flex items-start gap-[6px] rounded-[12px] bg-sh-warn-bg px-[10px] py-[6px] text-[12px] text-sh-warn-fg">
              <Icon icon={TriangleAlert} size={13} className="mt-[2px] shrink-0" />
              {caution}
            </p>
          )}
        </>
      )}

      <AIActionBar
        className="mt-[12px]"
        touchpointId={touchpointId}
        capabilityId={capabilityId}
        gate={gate}
        band={band}
        score={score}
        explain={explain}
        expanded={isExpanded}
        onAccept={onAccept}
      />
    </Card>
  )
}

/**
 * The assistant's reading, signed for (ported from `src/components/ai.tsx`
 * AttestStrip). A reading is a claim under a gate, so it ends in a signature
 * rather than a full stop: the same disposition, and for a G3 claim the same
 * `AI.ATTESTED` audit row, the owning screen's action bar writes.
 */
export function AttestStrip({ attest, subject }: { attest: NonNullable<AssistantAnswer['attest']>; subject?: string }) {
  const disposition = useAI((s) => s.dispositions[attest.touchpointId])
  const record = useAI((s) => s.record)
  const audit = useAudit((s) => s.record)
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)

  if (disposition) {
    const agreed = disposition.disposition === 'Accepted'
    return (
      <p className={cn('mt-[12px] flex flex-wrap items-center gap-[8px] rounded-[12px] px-[12px] py-[8px] text-[13px]', agreed ? 'bg-sh-norm-bg text-sh-norm-fg' : 'bg-sh-warn-bg text-sh-warn-fg')}>
        <Icon icon={agreed ? Signature : Undo2} size={14} />
        {agreed ? 'Signed' : 'Recorded as a disagreement'} by {disposition.by}
      </p>
    )
  }

  function act(kind: 'Accepted' | 'Rejected') {
    record({ touchpointId: attest.touchpointId, disposition: kind, by: me.name, modelVersion: attest.capabilityId, confidence: 'HIGH' })
    if (kind === 'Accepted' && attest.gate === 'G3') {
      audit({
        event: 'AI.ATTESTED',
        actor: me.name,
        actorId: me.id,
        subject: subject ?? attest.touchpointId,
        model: attest.capabilityId,
        gate: 'G3',
        detail: `${attest.capabilityId} · Accepted · ${me.identifierKind} ${me.identifier} · ${attest.claim}`,
      })
    }
    toast({
      tone: kind === 'Accepted' ? 'success' : 'caution',
      title: kind === 'Accepted' ? 'Reading signed' : 'Disagreement recorded',
      detail: kind === 'Accepted' ? `${attest.claim} — stamped ${me.name} · ${me.identifier}` : 'The reading stays in the record with your disagreement beside it.',
    })
  }

  return (
    <div className="mt-[12px] rounded-[14px] bg-sh-inner px-[12px] py-[10px] inset-ring-1 inset-ring-(--ai)/30">
      <p className="flex flex-wrap items-center gap-[8px] text-[12px] font-medium text-sh-text-2">
        <Diamond />
        {attest.capabilityId} · <GateBadge gate={attest.gate} />
        <span className="min-w-0">needs your signature, not just your click.</span>
      </p>
      <p className="mt-[4px] text-[13px] text-sh-text-2">{attest.claim}</p>
      <div className="mt-[8px] flex flex-wrap gap-[8px]">
        <Pill variant="primary" size="lg" icon={Signature} onClick={() => act('Accepted')}>
          Sign for this reading
        </Pill>
        <Pill variant="control" size="lg" icon={Undo2} onClick={() => act('Rejected')}>
          I disagree
        </Pill>
      </div>
    </div>
  )
}

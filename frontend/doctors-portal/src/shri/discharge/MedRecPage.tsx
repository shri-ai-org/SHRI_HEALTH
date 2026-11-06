/**
 * S-13-03 · Medication reconciliation — `/encounter/:id/med-rec`
 * (`src/screens/m13/S1303.tsx`): "Admission meds against discharge meds,
 * reconciled line by line."
 *
 * ARC-09 is the two-column match: source on the left, target on the right,
 * and AI-306 proposes a match per row at G2. AI-205 runs over the resulting
 * list, because a reconciliation that introduces an interaction is worse than
 * no reconciliation. Every admission medicine must be accounted for; "not
 * carried forward" is a decision, and it needs a reason.
 *
 * Where the old screen fell short: it showed R. Lakshmanan's medicines on any
 * encounter's reconciliation, and fell back to his encounter at an unknown
 * address — here the lines are his, anyone else's says there is nothing to
 * reconcile, and an unknown encounter says so. Its decisions lived only on
 * the screen, lost on leaving, and "Confirm" recorded nothing — here each
 * decision and reason is kept with the encounter, and confirming fixes the
 * list, with who and when, on the audit trail. It said the list "flows into
 * the summary and the prescription", which nothing did; that claim is gone.
 */

import { Ban, Check, CheckCheck, FileText, Minus, Pill as PillIcon, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import type { Encounter } from '@/data/clinical'
import { NOW, formatDateTime, formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { useAI } from '@/store/ai'
import { useAudit } from '@/store/audit'
import { useClinical, type MedRecDecision } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { encounterLabel, maybeEncounter } from '../logic/encounter'
import { DECISIONS, DECISION_LABEL, isTrivial, medRecGaps, medRowsFor, suggestedDecision, type MedRow } from '../logic/medrec'
import { NoSuchEncounter } from '../notes/ConsultationPage'
import { useAiActive, useForcedState } from '../state/ai'
import { FieldChip } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Why } from '../ui/Disclosure'
import { EmptyState } from '../ui/EmptyState'
import { Select, TextInput } from '../ui/forms'
import { Card, Icon, Pill } from '../ui/primitives'
import { ValidationSummary } from '../ui/states'

const COLUMN_HEAD = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3'

export function MedRecPage() {
  const { id } = useParams()
  const enc = maybeEncounter(id)
  if (!enc) return <NoSuchEncounter id={id} screenId="S-13-03" />
  return <MedRec key={enc.id} enc={enc} />
}

function MedRec({ enc }: { enc: Encounter }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const aiActive = useAiActive()
  const forced = useForcedState()

  const rec = useClinical((s) => s.medRecs[enc.id])
  const setDecision = useClinical((s) => s.setMedRecDecision)
  const setReason = useClinical((s) => s.setMedRecReason)
  const confirmMedRec = useClinical((s) => s.confirmMedRec)
  const [showValidation, setShowValidation] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const p = patient(enc.patientId)
  const rows = medRowsFor(p.id)
  const decisions = rec?.decisions ?? {}
  const reasons = rec?.reasons ?? {}
  const { undecided, missingReason } = medRecGaps(rows, rec)
  const interactions = rows.filter((r) => r.caution).length
  const confirmed = Boolean(rec?.confirmedAt)
  const locked = confirmed || forced === 'LOCKED'
  const done = rows.length > 0 && undecided.length === 0 && missingReason.length === 0
  const summary = `/encounter/${enc.id}/discharge-summary`
  // A forced AI-LOW shows how a weak match arrives: its band, and acceptance only after reading it.
  const bandOf = (r: MedRow) => (forced === 'AI-LOW' ? 'LOW' : r.matchBand)

  const nameOf = (r: MedRow) => r.admission?.drug ?? r.proposed?.drug ?? r.id
  const problems = [
    ...undecided.map((r) => ({ field: nameOf(r), message: 'unaccounted for — choose a decision' })),
    ...missingReason.map((r) => ({ field: nameOf(r), message: 'stopped — say why it is not carried forward' })),
  ]

  function askToConfirm() {
    if (!done || locked) {
      setShowValidation(true)
      return
    }
    setConfirming(true)
  }

  function confirmList() {
    setConfirming(false)
    if (!confirmMedRec(enc.id, me.name, NOW.toISOString())) return
    const counts = DECISIONS.map((d) => [d, rows.filter((r) => decisions[r.id] === d).length] as const)
      .filter(([, n]) => n > 0)
      .map(([d, n]) => `${n} ${DECISION_LABEL[d].toLowerCase()}`)
      .join(', ')
    audit({ event: 'MEDREC.CONFIRMED', actor: me.name, actorId: me.id, subject: p.id, detail: `${encounterLabel(enc)} · ${rows.length} medicines: ${counts}` })
    toast({ tone: 'success', title: 'Medication reconciled', detail: 'The discharge list is fixed and on the record.' })
    if (may(summary)) navigate(summary)
  }

  const status =
    rows.length === 0
      ? 'Nothing to reconcile'
      : confirmed
        ? `Confirmed by ${rec?.confirmedBy} · ${formatDateTime(new Date(rec?.confirmedAt ?? NOW))}`
        : undecided.length > 0
          ? `${undecided.length} medicine${undecided.length === 1 ? '' : 's'} unaccounted for`
          : missingReason.length > 0
            ? `${missingReason.length} stopped medicine${missingReason.length === 1 ? '' : 's'} needs a reason`
            : 'Every medicine is accounted for'

  const row = (r: MedRow, i: number) => {
    const decision = decisions[r.id]
    const reason = reasons[r.id] ?? ''
    const touchpointId = `${enc.id}:medrec:${r.id}`
    const band = bandOf(r)
    const showRationale = r.rationale && !isTrivial(r.rationale) && (!decision || decision === 'stopped' || decision === 'changed')
    const needsReason = decision === 'stopped' && !reason.trim()
    const suggestion = suggestedDecision(r)
    return (
      <li
        key={r.id}
        className={cn(
          'px-[16px] py-[14px] sm:px-[20px]',
          i > 0 && 'border-t border-sh-line',
          !locked && !decision && 'bg-sh-warn-bg/40',
          !locked && needsReason && 'bg-sh-crit-bg/40',
        )}
      >
        <div className="grid gap-[12px] md:grid-cols-[1fr_360px_1fr] md:items-start md:gap-[16px]">
          {/* Left — admission. */}
          <div className="min-w-0">
            <p className={cn(COLUMN_HEAD, 'mb-[2px] md:hidden')}>On admission</p>
            {r.admission ? (
              <>
                <p className="text-[14px] font-medium text-sh-text">{r.admission.drug}</p>
                <p className="text-[13px] tabular-nums text-sh-text-2">
                  {r.admission.dose} · {r.admission.frequency}
                </p>
              </>
            ) : (
              <p className="flex items-center gap-[6px] text-[13px] text-sh-text-2">
                <Icon icon={Minus} size={12} />
                not on admission
              </p>
            )}
          </div>

          {/* Middle — the decision. */}
          <div className="min-w-0">
            <Select
              value={decision ?? ''}
              disabled={locked}
              aria-label={`Decision for ${nameOf(r)}`}
              onChange={(e) => {
                const next = (e.target.value || null) as MedRecDecision | null
                // Back to undecided: AI-306's proposal is open again, not still "accepted".
                if (!next) useAI.getState().clearDisposition(touchpointId)
                setDecision(enc.id, r.id, next)
              }}
            >
              <option value="">Decide…</option>
              {DECISIONS.map((k) => (
                <option key={k} value={k}>
                  {DECISION_LABEL[k]}
                </option>
              ))}
            </Select>
            {aiActive && band && !decision && (
              <div className="mt-[8px]">
                <FieldChip
                  touchpointId={touchpointId}
                  capabilityId="AI-306"
                  suggestion={DECISION_LABEL[suggestion]}
                  band={band}
                  score={band === 'LOW' ? undefined : r.matchConfidence}
                  gate="G2"
                  locked={locked}
                  onAccept={() => setDecision(enc.id, r.id, suggestion)}
                  explain={{
                    touchpointId,
                    capabilityId: 'AI-306',
                    claim: r.rationale ?? 'A proposed match between the admission and discharge lists.',
                    confidence: r.matchConfidence ?? 0.8,
                    band,
                    computedAt: formatTime(NOW),
                    inputs: [
                      ...(r.admission ? [{ label: r.admission.drug, source: 'Admission medication list' }] : []),
                      ...(r.proposed ? [{ label: r.proposed.drug, source: 'Inpatient medication record' }] : []),
                      { label: 'Renal function trend', source: 'Result R-88405' },
                      { label: 'Documented allergies', source: `Allergy record ${p.id}` },
                    ],
                    evidence: [r.rationale ?? ''],
                    model: 'med-rec v2.5.0',
                    limits: [
                      'Matches by drug, class and indication. A class switch is deliberately low confidence.',
                      'It cannot know what the patient actually took at home.',
                      'Manual side-by-side comparison is the fallback.',
                    ],
                  }}
                />
              </div>
            )}
          </div>

          {/* Right — discharge. */}
          <div className="min-w-0">
            <p className={cn(COLUMN_HEAD, 'mb-[2px] md:hidden')}>On discharge</p>
            {r.proposed ? (
              <>
                <p className="text-[14px] font-medium text-sh-text">{r.proposed.drug}</p>
                <p className="text-[13px] tabular-nums text-sh-text-2">
                  {r.proposed.dose} · {r.proposed.frequency}
                </p>
              </>
            ) : (
              <p className="flex items-center gap-[6px] text-[13px] font-medium text-sh-warn-fg">
                <Icon icon={Ban} size={12} />
                not carried forward
              </p>
            )}
          </div>
        </div>

        {showRationale && <p className="mt-[8px] text-[13px] text-sh-text-2">{r.rationale}</p>}

        {/* A real interaction on the discharge line — operative, so it stays, AI or not. */}
        {r.caution && (
          <p className="mt-[8px] flex items-start gap-[8px] text-[13px] font-medium text-sh-warn-fg">
            <Icon icon={TriangleAlert} size={13} className="mt-[2px] shrink-0" />
            {r.caution}
          </p>
        )}

        {decision === 'stopped' && (
          <div className="mt-[10px]">
            <TextInput
              value={reason}
              disabled={locked}
              onChange={(e) => setReason(enc.id, r.id, e.target.value)}
              placeholder="Why it is not carried forward — required"
              aria-label={`Why ${nameOf(r)} is not carried forward`}
              aria-required="true"
              aria-invalid={needsReason}
              className={cn(needsReason && 'shadow-[inset_0_0_0_1.5px_var(--crit-fg)]')}
            />
          </div>
        )}
      </li>
    )
  }

  return (
    <>
      <ScreenFrame
        screenId="S-13-03"
        patient={p}
        sub={
          rows.length === 0
            ? 'No medicine list to reconcile'
            : `${rows.length - undecided.length} of ${rows.length} reconciled${interactions > 0 ? ` · ${interactions} interaction${interactions === 1 ? '' : 's'} to note` : ''}`
        }
        actions={
          may(summary) && (
            <Pill variant="card" size="xl" icon={FileText} iconSize={17} onClick={() => navigate(summary)}>
              Discharge summary
            </Pill>
          )
        }
        actionBar={
          rows.length > 0 && (
            <>
              <span className="text-[13px] tabular-nums text-sh-text-2">{status}</span>
              {confirmed ? (
                may(summary) && (
                  <Pill variant="primary" size="lg" icon={FileText} className="ml-auto" onClick={() => navigate(summary)}>
                    Discharge summary
                  </Pill>
                )
              ) : (
                <Pill
                  variant="primary"
                  size="lg"
                  icon={Check}
                  className={cn('ml-auto', (!done || locked) && 'opacity-40')}
                  aria-disabled={!done || locked}
                  title={done ? undefined : 'Every medicine needs a decision, and every stopped one a reason'}
                  onClick={askToConfirm}
                >
                  Confirm the discharge list
                </Pill>
              )}
            </>
          )
        }
      >
        {confirmed && (
          <Alert tone="info" icon={CheckCheck} title="Confirmed">
            Confirmed by {rec?.confirmedBy} at {formatDateTime(new Date(rec?.confirmedAt ?? NOW))}. The discharge list is fixed.
          </Alert>
        )}
        {!locked && (showValidation || forced === 'VALIDATION') && problems.length > 0 && <ValidationSummary problems={problems} />}

        {rows.length === 0 ? (
          <Card>
            <EmptyState icon={PillIcon} why={`There is no admission or discharge medicine list on ${p.name}'s record to reconcile.`} />
          </Card>
        ) : (
          <Card
            titleSize="sm"
            title="Line by line"
            right={<span className="text-[12px] tabular-nums text-sh-text-3">{rows.length} medicines</span>}
            className="overflow-hidden px-0 pb-0"
            headerClassName="px-[16px] sm:px-[20px]"
          >
            {/* Column headers, above md; below it each row names its own columns. */}
            <div className="hidden border-b border-sh-line px-[16px] pb-[8px] sm:px-[20px] md:grid md:grid-cols-[1fr_360px_1fr] md:gap-[16px]">
              <p className={COLUMN_HEAD}>On admission</p>
              <p className={cn(COLUMN_HEAD, 'text-center')}>Decision</p>
              <p className={COLUMN_HEAD}>On discharge</p>
            </div>
            <ul aria-label="Medicines to reconcile">{rows.map(row)}</ul>
          </Card>
        )}

        {rows.length > 0 && (
          <Why label="Why every line needs a decision">
            <p>
              Every admission medicine must be accounted for. &ldquo;Not carried forward&rdquo; is a decision with a reason, not a blank — a medicine that silently disappears
              from the list is how a patient stops taking something they needed. The list cannot be confirmed with an unaccounted-for medicine on it.
            </p>
            <p className="mt-[8px] text-sh-text-3">
              AI-306 proposes a match per row at G2. Where the class changed — an IV beta-lactam to an oral fluoroquinolone — the confidence drops and the rationale says why
              it is not like-for-like. AI-205 checks the resulting list for interactions. Fallback: manual side-by-side comparison.
            </p>
          </Why>
        )}
      </ScreenFrame>

      <ConfirmDialog
        open={confirming}
        title="Confirm the discharge list?"
        consequence="Every medicine is accounted for. The list is fixed with your name and the time, and its decisions cannot be changed after this."
        confirmLabel="Confirm the discharge list"
        onConfirm={confirmList}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}

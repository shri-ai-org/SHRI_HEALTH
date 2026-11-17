/**
 * SHRI_HEALTH: the AI visit summary at the top of the consultation note, on the API (D70, D119;
 * #396, #406). Asked for on demand; a few statements, each citing the records it rests on, and
 * labelled AI-generated. Nothing goes in the note until the clinician accepts it, edits it or
 * rejects it, as with the SOAP sections' AI drafts; the call order is in logic/aiNoteBlocks.ts and
 * runs in the note's own save queue (shri-health/clinical.ts). With AI off it says so in one plain
 * line; a failed summary offers Try again; a restricted chart opens the route's sealed card.
 */

import { Check, CircleHelp, Pencil, RotateCcw, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { newIdempotencyKey } from '../../../../src/api/client'
import type { VisitSummary } from '../../../../src/api/generated/model'
import { aiSourceLabel, routeForAiSource } from '../../../shri-health/aiSources'
import { useClinical } from '../../../shri-health/clinical'
import { hasPermission } from '../../../shri-health/opd'
import {
  AI_OFF,
  SUMMARY_FAILED,
  SUMMARY_TEXT_MAX,
  choiceProblem,
  decisionFailure,
  isPending,
  readVisitSummary,
  remember,
  rememberedId,
  requestVisitSummary,
  summaryText,
  type AiRead,
  type SummaryChoice,
} from '../logic/aiNoteBlocks'
import { useAiActive } from '../state/ai'
import { RejectDialog } from '../ui/ai'
import { TextArea } from '../ui/forms'
import { Card, Pill, PillTag } from '../ui/primitives'

type Phase = { kind: 'idle' } | { kind: 'preparing' } | AiRead<VisitSummary>

const DONE: Record<string, string> = {
  accepted: 'Accepted. The summary is at the top of the note.',
  edited: 'Edited and put at the top of the note.',
  rejected: 'Rejected. Nothing was added to the note.',
}

export function AiVisitSummary({ encounterId, patientId, locked }: { encounterId: string; patientId: string; locked: boolean }) {
  const aiActive = useAiActive()
  const navigate = useNavigate()
  const mayAsk = hasPermission('chart-summaries:create')
  const mayDecide = hasPermission('ai-suggestions:decision')
  const [phase, setPhase] = useState<Phase>(() => (rememberedId('visit-summary', encounterId) ? { kind: 'preparing' } : { kind: 'idle' }))
  const [editing, setEditing] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** One Idempotency-Key per decision: a retry of the same choice sends the same key. */
  const keys = useRef(new Map<string, string>())

  // A summary asked for earlier in this tab is read again (after a reload).
  useEffect(() => {
    const id = rememberedId('visit-summary', encounterId)
    if (!id) return
    let live = true
    void readVisitSummary(id).then((r) => live && setPhase(r))
    return () => {
      live = false
    }
  }, [encounterId])

  if (phase.kind === 'restricted') throw phase.error
  if (!aiActive) return null
  if (phase.kind === 'idle' && (!mayAsk || locked)) return null

  const ask = () => {
    setPhase({ kind: 'preparing' })
    setNotice(null)
    void requestVisitSummary(encounterId, newIdempotencyKey()).then((r) => {
      if (r.kind === 'ready') remember('visit-summary', encounterId, r.value.id)
      setPhase(r)
    })
  }

  const decide = (summary: VisitSummary, choice: SummaryChoice) => {
    const problem = choiceProblem(choice)
    if (problem) return setNotice(problem)
    const sig = JSON.stringify(choice)
    const key = keys.current.get(sig) ?? newIdempotencyKey()
    keys.current.set(sig, key)
    setBusy(true)
    setNotice(null)
    useClinical
      .getState()
      .decideVisitSummary(encounterId, summary.id, choice, key)
      .then((decided) => {
        keys.current.clear()
        setEditing(null)
        setPhase({ kind: 'ready', value: decided })
      })
      .catch(async (error: unknown) => {
        const f = decisionFailure(error)
        if (f.kind === 'restricted') return setPhase({ kind: 'restricted', error: f.error })
        if (f.kind === 'off') return setPhase({ kind: 'off' })
        setNotice(f.message)
        if (f.kind === 'already-decided') {
          keys.current.clear()
          setEditing(null)
          const again = await readVisitSummary(summary.id)
          if (again.kind === 'ready') setPhase(again)
        }
        if (f.kind === 'signed') setEditing(null)
      })
      .finally(() => setBusy(false))
  }

  return (
    <Card titleSize="sm" title="AI visit summary" right={phase.kind === 'ready' ? <AiTag model={phase.value.generatedBy.modelName} /> : undefined}>
      {phase.kind === 'idle' && (
        <div className="flex flex-col items-start gap-[10px]">
          <p className="text-[13px] text-sh-text-2">A short summary of this visit, each statement linked to its records. Nothing goes in the note unless you accept or edit it.</p>
          <Pill variant="accent" size="md" icon={Sparkles} onClick={ask}>
            Summarize this visit
          </Pill>
        </div>
      )}
      {phase.kind === 'preparing' && (
        <p role="status" className="text-[13px] text-sh-text-2">
          Preparing the summary…
        </p>
      )}
      {phase.kind === 'off' && <p className="text-[13px] text-sh-text-3">{AI_OFF}</p>}
      {(phase.kind === 'failed' || phase.kind === 'error') && (
        <div className="flex flex-col items-start gap-[10px]">
          <p role="alert" className="text-[13px] text-sh-warn-fg">
            {phase.kind === 'failed' ? SUMMARY_FAILED : phase.message}
          </p>
          {mayAsk && !locked && (
            <Pill variant="control" size="md" icon={RotateCcw} onClick={ask}>
              Try again
            </Pill>
          )}
        </div>
      )}
      {phase.kind === 'ready' && (
        <section aria-label="AI visit summary" className="flex flex-col gap-[10px]">
          {phase.value.insufficientEvidence && (
            <p className="flex items-start gap-[8px] text-[14px] text-sh-text">
              <CircleHelp size={14} className="mt-[3px] shrink-0 text-sh-muted" aria-hidden />
              Not enough in this visit yet for a full summary.
            </p>
          )}
          {phase.value.statements.length > 0 && (
            <ol className="flex flex-col gap-[8px] rounded-[16px] border-l-[3px] border-sh-ai bg-sh-inner px-[14px] py-[10px]">
              {[...phase.value.statements]
                .sort((a, b) => a.sequence - b.sequence)
                .map((st) => (
                  <li key={st.sequence} className="flex flex-col gap-[2px]">
                    <span className="text-[14px]/[1.5] text-sh-text">{st.text}</span>
                    <span className="flex flex-wrap gap-x-[10px] gap-y-[2px]">
                      {st.sources.map((src, j) => (
                        <button
                          key={`${src.resourceId}-${j}`}
                          type="button"
                          onClick={() => navigate(routeForAiSource(patientId, src))}
                          className="text-[12px] font-medium text-sh-ai underline-offset-2 hover:underline"
                          aria-label={`Source: ${aiSourceLabel(src)}`}
                        >
                          {aiSourceLabel(src)}
                        </button>
                      ))}
                    </span>
                  </li>
                ))}
            </ol>
          )}

          {!isPending(phase.value) ? (
            <p className="flex items-center gap-[6px] text-[13px] text-sh-text-2">
              {phase.value.decision === 'rejected' ? <X size={14} aria-hidden /> : <Check size={14} aria-hidden />}
              {DONE[phase.value.decision ?? 'accepted']}
              {phase.value.rejectionReason && <span className="text-sh-text-3">({phase.value.rejectionReason})</span>}
            </p>
          ) : editing !== null ? (
            <div className="flex flex-col gap-[8px]">
              <label htmlFor={`${encounterId}-summary-edit`} className="text-[13px] font-medium text-sh-text-2">
                Your version of the summary
              </label>
              <TextArea id={`${encounterId}-summary-edit`} rows={5} maxLength={SUMMARY_TEXT_MAX} value={editing} onChange={(e) => setEditing(e.target.value)} disabled={busy} />
              <span className="text-[12px] tabular-nums text-sh-text-3">
                {editing.length.toLocaleString('en-US')} of {SUMMARY_TEXT_MAX.toLocaleString('en-US')} characters
              </span>
              <div className="flex flex-wrap gap-[6px]">
                <Pill variant="accent" size="md" icon={Check} disabled={busy} className="disabled:opacity-40" onClick={() => decide(phase.value, { decision: 'edited', text: editing })}>
                  Put in the note
                </Pill>
                <Pill variant="ghost" size="md" disabled={busy} className="disabled:opacity-40" onClick={() => setEditing(null)}>
                  Cancel
                </Pill>
              </div>
            </div>
          ) : (
            !locked &&
            mayDecide && (
              <div role="group" aria-label="Decision for the AI visit summary" className="flex flex-wrap items-center gap-x-[6px] gap-y-[10px]">
                <Pill variant="accent" size="md" icon={Check} disabled={busy} className="disabled:opacity-40" onClick={() => decide(phase.value, { decision: 'accepted' })}>
                  Accept
                </Pill>
                <Pill variant="control" size="md" icon={Pencil} disabled={busy} className="disabled:opacity-40" onClick={() => setEditing(summaryText(phase.value))}>
                  Edit
                </Pill>
                <Pill variant="ghost" size="md" icon={X} disabled={busy} className="disabled:opacity-40" onClick={() => setRejecting(true)}>
                  Reject
                </Pill>
              </div>
            )
          )}
          {busy && (
            <p role="status" className="text-[12px] text-sh-text-3">
              Saving the decision…
            </p>
          )}
        </section>
      )}
      {notice && (
        <p role="alert" className="mt-[8px] text-[13px] text-sh-warn-fg">
          {notice}
        </p>
      )}
      {phase.kind === 'ready' && (
        <RejectDialog
          open={rejecting}
          capabilityName="AI visit summary"
          onCancel={() => setRejecting(false)}
          onConfirm={(reason, text) => {
            setRejecting(false)
            decide(phase.value, { decision: 'rejected', reason: (text ? `${reason}: ${text}` : reason).slice(0, 500) })
          }}
        />
      )}
    </Card>
  )
}

/** "AI-generated" and the model, as the other AI panels label their output. */
export function AiTag({ model }: { model: string }) {
  return (
    <PillTag tone="neu" size="xs" icon={Sparkles} className="font-medium">
      AI-generated · {model}
    </PillTag>
  )
}

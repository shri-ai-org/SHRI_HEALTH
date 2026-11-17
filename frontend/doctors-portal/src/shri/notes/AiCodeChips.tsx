/**
 * SHRI_HEALTH: AI-04's ICD-10-CM suggestions under the Assessment, on the API (D70, D119; #396,
 * #404). Asked for on demand. Each chip shows the code, its name, why (the rationale), the
 * confidence band and links to the records it rests on, labelled AI-generated. Nothing is applied
 * by itself and nothing is accepted by default: the clinician accepts a code (it becomes a visit
 * diagnosis) or rejects it with a reason (the chip goes; its decision is kept on the server).
 */

import { Check, CircleHelp, RotateCcw, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { newIdempotencyKey } from '../../../../src/api/client'
import type { AiConfidence, CodingSuggestion, SuggestedCode } from '../../../../src/api/generated/model'
import { aiSourceLabel, routeForAiSource } from '../../../shri-health/aiSources'
import { useClinical } from '../../../shri-health/clinical'
import { hasPermission } from '../../../shri-health/opd'
import {
  AI_OFF,
  CODES_FAILED,
  decideCode,
  decisionFailure,
  readCodingSuggestion,
  remember,
  rememberedId,
  requestCodingSuggestion,
  visibleCodes,
  withCode,
  type AiRead,
  type CodeChoice,
} from '../logic/aiNoteBlocks'
import { useAiActive } from '../state/ai'
import { RejectDialog } from '../ui/ai'
import { ConfidenceMark, Pill } from '../ui/primitives'

import { AiTag } from './AiVisitSummary'

type Phase = { kind: 'idle' } | { kind: 'preparing' } | AiRead<CodingSuggestion>

const BAND: Record<AiConfidence, 'HIGH' | 'MED' | 'LOW'> = { high: 'HIGH', medium: 'MED', low: 'LOW' }

export function AiCodeChips({ encounterId, patientId, locked }: { encounterId: string; patientId: string; locked: boolean }) {
  const aiActive = useAiActive()
  const navigate = useNavigate()
  const mayAsk = hasPermission('chart-summaries:create') && hasPermission('diagnoses:create')
  const mayDecide = hasPermission('ai-suggestions:decision') && hasPermission('diagnoses:create')
  const [phase, setPhase] = useState<Phase>(() => (rememberedId('coding-suggestion', encounterId) ? { kind: 'preparing' } : { kind: 'idle' }))
  const [busy, setBusy] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<SuggestedCode | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** One Idempotency-Key per code decision, reused on a retry of the same choice. */
  const keys = useRef(new Map<string, string>())

  useEffect(() => {
    const id = rememberedId('coding-suggestion', encounterId)
    if (!id) return
    let live = true
    void readCodingSuggestion(id).then((r) => live && setPhase(r))
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
    void requestCodingSuggestion(encounterId, newIdempotencyKey()).then((r) => {
      if (r.kind === 'ready') remember('coding-suggestion', encounterId, r.value.id)
      setPhase(r)
    })
  }

  const decide = (suggestion: CodingSuggestion, code: SuggestedCode, choice: CodeChoice) => {
    const sig = `${code.id}:${JSON.stringify(choice)}`
    const key = keys.current.get(sig) ?? newIdempotencyKey()
    keys.current.set(sig, key)
    setBusy(code.id)
    setNotice(null)
    decideCode(suggestion.id, code.id, choice, key)
      .then((decided) => {
        keys.current.delete(sig)
        setPhase({ kind: 'ready', value: withCode(suggestion, decided) })
        // An accepted code is now one of the visit's diagnoses: the note's code picker reads them again.
        if (decided.decision === 'accepted') void useClinical.getState().loadDiagnoses(encounterId).catch(() => undefined)
      })
      .catch(async (error: unknown) => {
        const f = decisionFailure(error)
        if (f.kind === 'restricted') return setPhase({ kind: 'restricted', error: f.error })
        if (f.kind === 'off') return setPhase({ kind: 'off' })
        setNotice(f.message)
        if (f.kind === 'already-decided') {
          const again = await readCodingSuggestion(suggestion.id)
          if (again.kind === 'ready') setPhase(again)
        }
      })
      .finally(() => setBusy(null))
  }

  return (
    <div className="mt-[16px] flex flex-col gap-[10px] border-t border-sh-line pt-[14px]">
      <div className="flex flex-wrap items-center justify-between gap-[8px]">
        <h3 className="text-[13px] font-medium text-sh-text-2">Suggested ICD-10-CM codes</h3>
        {phase.kind === 'ready' && <AiTag model={phase.value.generatedBy.modelName} />}
      </div>
      {phase.kind === 'idle' && (
        <div className="flex flex-col items-start gap-[8px]">
          <p className="text-[13px] text-sh-text-2">Codes for this visit, each with its reasoning and records. Nothing is added until you accept a code.</p>
          <Pill variant="accent" size="md" icon={Sparkles} onClick={ask}>
            Suggest ICD-10 codes
          </Pill>
        </div>
      )}
      {phase.kind === 'preparing' && (
        <p role="status" className="text-[13px] text-sh-text-2">
          Preparing the suggestions…
        </p>
      )}
      {phase.kind === 'off' && <p className="text-[13px] text-sh-text-3">{AI_OFF}</p>}
      {(phase.kind === 'failed' || phase.kind === 'error') && (
        <div className="flex flex-col items-start gap-[10px]">
          <p role="alert" className="text-[13px] text-sh-warn-fg">
            {phase.kind === 'failed' ? CODES_FAILED : phase.message}
          </p>
          {mayAsk && !locked && (
            <Pill variant="control" size="md" icon={RotateCcw} onClick={ask}>
              Try again
            </Pill>
          )}
        </div>
      )}
      {phase.kind === 'ready' && (
        <>
          {visibleCodes(phase.value).length === 0 ? (
            <p className="flex items-start gap-[8px] text-[14px] text-sh-text">
              <CircleHelp size={14} className="mt-[3px] shrink-0 text-sh-muted" aria-hidden />
              {phase.value.insufficientEvidence ? 'Not enough in this visit yet to suggest a code.' : 'No codes left to review.'}
            </p>
          ) : (
            <ul aria-label="Suggested ICD-10-CM codes" className="flex flex-col gap-[8px]">
              {visibleCodes(phase.value).map((c) => (
                <li key={c.id} className="flex flex-col gap-[4px] rounded-[14px] border-l-[3px] border-sh-ai bg-sh-inner px-[12px] py-[10px]">
                  <span className="flex flex-wrap items-center gap-x-[10px] gap-y-[4px]">
                    <span className="text-[14px] font-semibold tabular-nums text-sh-text">{c.code}</span>
                    <span className="text-[14px] text-sh-text">{c.display}</span>
                    <ConfidenceMark band={BAND[c.confidence]} short />
                  </span>
                  <p className="text-[13px]/[1.4] text-sh-text-2">
                    <span className="font-medium text-sh-text">Why: </span>
                    {c.rationale}
                  </p>
                  {c.sources.length > 0 && (
                    <span className="flex flex-wrap gap-x-[10px] gap-y-[2px]">
                      {c.sources.map((src, j) => (
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
                  )}
                  {c.decision === 'accepted' ? (
                    <p className="flex items-center gap-[6px] text-[13px] text-sh-text-2">
                      <Check size={14} aria-hidden />
                      Accepted. Added to the visit&rsquo;s diagnoses.
                    </p>
                  ) : (
                    !locked &&
                    mayDecide && (
                      <div role="group" aria-label={`Decision for ${c.code}`} className="mt-[4px] flex flex-wrap gap-[6px]">
                        <Pill variant="accent" size="sm" icon={Check} disabled={busy !== null} className="disabled:opacity-40" onClick={() => decide(phase.value, c, { decision: 'accepted' })}>
                          Accept
                        </Pill>
                        <Pill variant="ghost" size="sm" icon={X} disabled={busy !== null} className="disabled:opacity-40" onClick={() => setRejecting(c)}>
                          Reject
                        </Pill>
                      </div>
                    )
                  )}
                  {busy === c.id && (
                    <p role="status" className="text-[12px] text-sh-text-3">
                      Saving the decision…
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <RejectDialog
            open={rejecting !== null}
            capabilityName={rejecting ? `Suggested code ${rejecting.code}` : 'Suggested code'}
            onCancel={() => setRejecting(null)}
            onConfirm={(reason, text) => {
              const code = rejecting
              setRejecting(null)
              if (code) decide(phase.value, code, { decision: 'rejected', reason: (text ? `${reason}: ${text}` : reason).slice(0, 500) })
            }}
          />
        </>
      )}
      {notice && (
        <p role="alert" className="text-[13px] text-sh-warn-fg">
          {notice}
        </p>
      )}
    </div>
  )
}

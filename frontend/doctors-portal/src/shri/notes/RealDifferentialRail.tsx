/**
 * SHRI_HEALTH: the consultation's Differential rail on the API — AI-03 (D116; createDifferential,
 * getDifferential), asked for on demand. It suggests and never concludes: each candidate carries
 * its reasoning, its confidence (low or medium, never high) and links to the records it rests on;
 * nothing is added to the visit — the clinician adds a diagnosis the usual way. AI-generated and
 * labelled so. With the AI off, unavailable or over budget the rail empties (aiStatus) and the
 * consultation works as before.
 */

import { CircleHelp, RotateCcw, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { Differential } from '../../../../src/api/generated/model'
import { differentialFor } from '../../../shri-health/aiChart'
import { aiSourceLabel, routeForAiSource } from '../../../shri-health/aiSources'
import { aiDownReason, useAiFeatureUp, useAiStatus } from '../../../shri-health/aiStatus'
import { useAiActive } from '../state/ai'
import { ConfidenceMark, Pill, PillTag } from '../ui/primitives'

type Phase = { kind: 'idle' } | { kind: 'loading' } | { kind: 'done'; differential: Differential } | { kind: 'error'; message: string }

const BAND = { low: 'LOW', medium: 'MED', high: 'MED' } as const

export function RealDifferentialRail({ encounterId, patientId }: { encounterId: string; patientId: string }) {
  const aiActive = useAiActive()
  const up = useAiFeatureUp('differential')
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  if (!aiActive || !up) return null

  const run = () => {
    setPhase({ kind: 'loading' })
    differentialFor(encounterId)
      // A differential for another visit (the page changed while it ran) is never shown here.
      .then((differential) => setPhase(differential.encounterId === encounterId ? { kind: 'done', differential } : { kind: 'idle' }))
      .catch((error: unknown) => {
        const down = aiDownReason(error)
        if (down) useAiStatus.getState().markDown('differential', down)
        else setPhase({ kind: 'error', message: error instanceof Error ? error.message : 'The differential did not arrive.' })
      })
  }

  return (
    <div className="flex flex-col gap-[12px]">
      <p className="text-[13px] text-sh-text-2">Suggests, never concludes. Each possibility links to the records behind it; nothing is added to the visit.</p>
      {phase.kind === 'idle' && (
        <Pill variant="accent" size="md" icon={Sparkles} onClick={run} className="self-start">
          Suggest a differential
        </Pill>
      )}
      {phase.kind === 'loading' && (
        <p role="status" className="text-[13px] text-sh-text-2">
          Reading the visit and the chart…
        </p>
      )}
      {phase.kind === 'error' && (
        <div className="flex flex-col items-start gap-[10px]">
          <p role="alert" className="text-[13px] text-sh-warn-fg">
            {phase.message}
          </p>
          <Pill variant="control" size="md" icon={RotateCcw} onClick={run}>
            Try again
          </Pill>
        </div>
      )}
      {phase.kind === 'done' && (
        <section aria-label="AI differential" className="flex flex-col gap-[10px]">
          <PillTag tone="neu" size="xs" icon={Sparkles} className="self-start font-medium">
            AI-generated · {phase.differential.generatedBy.modelName}
          </PillTag>
          {phase.differential.candidates.length === 0 ? (
            <p className="flex items-start gap-[8px] text-[14px] text-sh-text">
              <CircleHelp size={14} className="mt-[3px] shrink-0 text-sh-muted" aria-hidden />
              Not enough in this visit yet to suggest a differential.
            </p>
          ) : (
            <ol className="flex flex-col gap-[10px]">
              {phase.differential.candidates.map((c) => (
                <li key={c.sequence} className="flex flex-col gap-[4px] rounded-[14px] bg-sh-inner px-[12px] py-[10px]">
                  <span className="flex flex-wrap items-center gap-x-[10px] gap-y-[4px]">
                    <span className="text-[14px] font-semibold text-sh-text">{c.condition}</span>
                    <ConfidenceMark band={BAND[c.confidence]} short />
                  </span>
                  <p className="text-[13px]/[1.4] text-sh-text-2">{c.rationale}</p>
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
                </li>
              ))}
            </ol>
          )}
          <Pill variant="control" size="md" icon={RotateCcw} onClick={run} className="self-start">
            Ask again
          </Pill>
        </section>
      )}
    </div>
  )
}

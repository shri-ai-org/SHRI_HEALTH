/**
 * SHRI_HEALTH: the record's AI card with the API — AI-02's chart summary (D70), asked for on demand.
 * Every statement carries its confidence and links to the record it comes from; a statement with no
 * source, or with conflicting ones, says so; what the chart doesn't hold is listed as missing. The
 * summary is AI-generated and labelled so; it never changes the chart. With the AI off, unavailable
 * or over budget the card leaves the page (aiStatus), and the rest of the record works as before.
 */

import { CircleHelp, RotateCcw, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { AiConfidence, ChartSummary, ChartSummaryTopic } from '../../../../src/api/generated/model'
import { summarizeChart } from '../../../shri-health/aiChart'
import { aiSourceLabel, routeForAiSource } from '../../../shri-health/aiSources'
import { aiDownReason, useAiFeatureUp, useAiStatus } from '../../../shri-health/aiStatus'
import { cn } from '../lib/cn'
import { useAiActive } from '../state/ai'
import { Card, ConfidenceMark, Diamond, Pill, PillTag } from '../ui/primitives'

import { TextLink } from './bits'

const TOPIC: Record<ChartSummaryTopic, string> = {
  encounters: 'Visits',
  diagnoses: 'Problems',
  medications: 'Medications',
  allergies: 'Allergies',
  results: 'Results',
  'outstanding-issues': 'Open issues',
}

const BAND = { low: 'LOW', medium: 'MED', high: 'HIGH' } as const satisfies Record<AiConfidence, 'LOW' | 'MED' | 'HIGH'>

type Phase = { kind: 'idle' } | { kind: 'loading' } | { kind: 'done'; summary: ChartSummary } | { kind: 'error'; message: string }

export function ChartSummaryCard({ patientId, className }: { patientId: string; className?: string }) {
  const aiActive = useAiActive()
  const up = useAiFeatureUp('chart-summary')
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  if (!aiActive || !up) return null

  const run = () => {
    setPhase({ kind: 'loading' })
    summarizeChart(patientId)
      // A summary of another chart (the record changed while it ran) is never shown here.
      .then((summary) => setPhase(summary.patientId === patientId ? { kind: 'done', summary } : { kind: 'idle' }))
      .catch((error: unknown) => {
        const down = aiDownReason(error)
        if (down) useAiStatus.getState().markDown('chart-summary', down)
        else setPhase({ kind: 'error', message: error instanceof Error ? error.message : 'The summary did not arrive.' })
      })
  }

  return (
    <Card
      titleSize="sm"
      title={
        <span className="inline-flex items-center gap-[8px]">
          <Diamond />
          AI chart summary
        </span>
      }
      className={cn('shadow-[inset_0_0_0_1.5px_var(--flags-ring)]', className)}
    >
      {phase.kind === 'idle' && (
        <div className="flex flex-col items-start gap-[10px]">
          <p className="text-[13px] text-sh-text-2">A summary of this chart, each line linked to the record it comes from. AI-generated; it never changes the chart.</p>
          <Pill variant="accent" size="md" icon={Sparkles} onClick={run}>
            Summarize the chart
          </Pill>
        </div>
      )}
      {phase.kind === 'loading' && (
        <p role="status" className="text-[13px] text-sh-text-2">
          Summarizing the chart…
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
        <div className="sh-scrollbar -mx-[6px] flex min-h-0 flex-col gap-[12px] overflow-y-auto px-[6px] pb-[6px]">
          <PillTag tone="neu" size="xs" icon={Sparkles} className="self-start font-medium">
            AI-generated
          </PillTag>
          {phase.summary.sections.map((section) => (
            <section key={section.topic} aria-label={TOPIC[section.topic]}>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">{TOPIC[section.topic]}</h3>
              <ul className="flex flex-col">
                {section.statements.map((st, i) => (
                  <li key={st.sequence} className={cn('flex flex-col gap-[4px] py-[8px]', i > 0 && 'border-t border-sh-line')}>
                    <p className="text-[14px]/[1.35] text-sh-text">{st.text}</p>
                    <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px]">
                      <ConfidenceMark band={BAND[st.confidence]} short />
                      {st.sourceStatus === 'no-source' && (
                        <PillTag tone="warn" size="xs" icon={CircleHelp} className="font-medium">
                          No source in the chart
                        </PillTag>
                      )}
                      {st.sourceStatus === 'conflicting' && (
                        <PillTag tone="warn" size="xs" icon={CircleHelp} className="font-medium">
                          Sources disagree
                        </PillTag>
                      )}
                      {st.sources.map((src, j) => (
                        <TextLink key={`${src.resourceId}-${j}`} onClick={() => navigate(routeForAiSource(patientId, src))} aria-label={`Source: ${aiSourceLabel(src)}`}>
                          {aiSourceLabel(src)}
                        </TextLink>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {phase.summary.missing.length > 0 && (
            <section aria-label="Not in the chart">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">Not in the chart</h3>
              <ul className="list-disc pl-[18px] text-[13px] text-sh-text-2">
                {phase.summary.missing.map((gap, i) => (
                  <li key={i}>{gap.description}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Card>
  )
}

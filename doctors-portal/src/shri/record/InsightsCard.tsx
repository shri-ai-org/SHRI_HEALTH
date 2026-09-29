/**
 * §7.5 ◆ AI insights (column B, under Vitals) — the flags the AI has raised
 * about this patient, in one card, the only place on the record an AI reading
 * appears (`src/screens/m06/record/AiInsights.tsx`), in handover order: the
 * deterioration risk, the condition, the scan, the results. Every row keeps
 * its confidence and names its capability and model, and its Why opens the
 * same four panels as every other. Flags, not narrative: the old card's lead
 * sentence (an AI summary) and its suggested orders are gone. A capability
 * that cannot score says so, never as a low confidence. With the AI off, or
 * nothing flagged, the card keeps its place and says so.
 */

import { CircleHelp, Sparkles } from 'lucide-react'

import type { Patient } from '@/data/kit'
import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { readingsFor } from '../logic/overview'
import { useAiActive } from '../state/ai'
import { EmptyState } from '../ui/EmptyState'
import { Card, ConfidenceMark, Diamond, PillTag } from '../ui/primitives'

import { TextLink } from './bits'

export function InsightsCard({ patient: p, className }: { patient: Patient; className?: string }) {
  const openExplain = useUI((s) => s.openExplain)
  const aiActive = useAiActive()
  const readings = aiActive ? readingsFor(p) : []
  return (
    <Card
      titleSize="sm"
      title={
        <span className="inline-flex items-center gap-[8px]">
          <Diamond />
          AI insights
        </span>
      }
      className={cn('shadow-[inset_0_0_0_1.5px_var(--flags-ring)]', className)}
    >
      {readings.length === 0 ? (
        <EmptyState compact icon={Sparkles} why={aiActive ? 'Nothing flagged on this record' : 'AI insights are off'} />
      ) : (
      /* The scroller keeps 6px of room at the sides and the foot, so each Why?'s 44px target stays inside it. */
      <ul className="sh-scrollbar -mx-[6px] flex min-h-0 flex-col overflow-y-auto px-[6px] pb-[6px]">
        {readings.map((r, i) => (
          <li key={r.key} className={cn('flex flex-col gap-[4px] py-[10px]', i > 0 && 'border-t border-sh-line', i === 0 && 'pt-0')}>
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">{r.label}</span>
            <p className="sh-clamp-2 text-[14px]/[1.35] text-sh-text">{r.text}</p>
            <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px]">
              {r.abstain ? (
                <PillTag tone="warn" size="xs" icon={CircleHelp} className="font-medium">
                  Cannot assess
                </PillTag>
              ) : (
                <ConfidenceMark band={r.band} short />
              )}
              <span className="text-[12px] tabular-nums text-sh-text-3">
                {r.explain.capabilityId} · {r.explain.model}
              </span>
              <TextLink className="ml-auto" onClick={() => openExplain(r.explain)} aria-label={`Why? ${r.label}: ${r.text}`}>
                Why?
              </TextLink>
            </div>
          </li>
        ))}
      </ul>
      )}
    </Card>
  )
}

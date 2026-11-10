/**
 * S-06-15 · Current condition — `/patient/:id/condition` (`src/screens/m06/
 * record/S0615.tsx`): how the patient is now — status, what to watch, and the
 * AI read of the record. The status word comes first because it is what a
 * colleague asks: "how is she?" Then the few things to watch, the problem
 * list and the latest observations, and — clearly marked as the model's — the
 * AI read with what drove it, and the deterioration risk. A risk model that
 * cannot score says so, never as a number (§4.5).
 */

import { Activity, ArrowDown, ArrowUp, CircleHelp, ClipboardList, CornerDownRight } from 'lucide-react'
import { useParams } from 'react-router-dom'

import { RISK_STRIPS, VITALS } from '@/data/clinical'
import { formatDate, formatTime } from '@/data/format'
import type { Patient } from '@/data/kit'
import { conditionFor } from '@/data/record'
import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { STATUS_TONE, useProblemsFor } from '../logic/record'
import type { Tone } from '../mocks/types'
import { useAiActive } from '../state/ai'
import { EmptyState } from '../ui/EmptyState'
import { Card, Chip, ConfidenceMark, CountBubble, Diamond, Icon, PillTag } from '../ui/primitives'

import { ClinicalFlag, TextLink } from './bits'
import { RecordFrame } from './RecordFrame'

const RISK_TONE: Record<'HIGH' | 'MODERATE' | 'LOW', Tone> = { HIGH: 'warn', MODERATE: 'warn', LOW: 'norm' }

export function ConditionPage() {
  const { id } = useParams()
  return (
    <RecordFrame id={id} section="condition">
      {(p) => <Condition patient={p} />}
    </RecordFrame>
  )
}

function Condition({ patient: p }: { patient: Patient }) {
  const aiActive = useAiActive()
  const openExplain = useUI((s) => s.openExplain)
  const c = conditionFor(p.id)
  const problems = useProblemsFor(p.id)
  const vitals = VITALS[p.id] ?? []
  const risk = RISK_STRIPS[p.id]

  return (
    <div className="grid grid-cols-1 gap-[16px] lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <div className="flex min-w-0 flex-col gap-[16px]">
        <Card titleSize="sm" title="How they are now" right={c && <Chip word={c.status} tone={STATUS_TONE[c.status]} />}>
          {c ? (
            <>
              <p className="text-[17px]/[1.3] font-semibold tracking-[-0.01em] text-sh-text">{c.headline}</p>
              <p className="mt-[6px] text-[14px]/[1.55] text-sh-text-2">{c.summary}</p>
              <p className="mt-[8px] text-[12px] tabular-nums text-sh-text-3">
                Updated {formatDate(c.updatedAt)} {formatTime(c.updatedAt)} · {c.updatedBy}
              </p>
            </>
          ) : (
            <p className="text-[14px] text-sh-text-2">No condition summary has been written for {p.name} yet.</p>
          )}
        </Card>

        {c && c.watch.length > 0 && (
          <Card
            titleSize="sm"
            title={
              <span className="inline-flex items-center gap-[10px]">
                What to watch
                <CountBubble className="bg-sh-control">{c.watch.length}</CountBubble>
              </span>
            }
          >
            <ol className="flex flex-col">
              {c.watch.map((w, i) => (
                <li key={w} className={cn('flex items-start gap-[12px] py-[10px]', i > 0 && 'border-t border-sh-line', i === 0 && 'pt-0')}>
                  <span
                    className={cn(
                      'inline-flex size-[24px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums',
                      i === 0 ? 'bg-sh-warn-bg text-sh-warn-fg' : 'bg-sh-inner text-sh-text-2',
                    )}
                    aria-hidden="true"
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 pt-[2px] text-[14px] text-sh-text-2">{w}</span>
                </li>
              ))}
            </ol>
          </Card>
        )}

        <Card
          titleSize="sm"
          title={
            <span className="inline-flex items-center gap-[10px]">
              Problem list
              <CountBubble className="bg-sh-control">{problems.length}</CountBubble>
            </span>
          }
        >
          {problems.length === 0 ? (
            <EmptyState icon={ClipboardList} why="No problems are coded on this record yet." />
          ) : (
            <ul className="flex flex-col">
              {problems.map((pr, i) => (
                <li key={pr.id} className={cn('flex flex-wrap items-center justify-between gap-[8px] py-[10px]', i > 0 && 'border-t border-sh-line', i === 0 && 'pt-0')}>
                  <span className="min-w-0">
                    <span className="text-[14px] font-medium text-sh-text">{pr.label}</span>
                    <span className="block text-[12px] tabular-nums text-sh-text-3">
                      ICD-10 {pr.icd10} · since {pr.onset}
                    </span>
                  </span>
                  <Chip word={pr.status} tone={pr.status === 'Open' ? 'pend' : 'neu'} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-[16px]">
        {aiActive && c && (
          <Card
            titleSize="sm"
            title={
              <span className="inline-flex items-center gap-[8px]">
                <Diamond />
                AI read of the record
              </span>
            }
            className="shadow-[inset_0_0_0_1.5px_var(--flags-ring)]"
          >
            <p className="text-[14px]/[1.55] text-sh-text">{c.ai.text}</p>
            <ul className="mt-[12px] flex flex-col gap-[6px]">
              {c.ai.drivers.map((d) => (
                <li key={d} className="flex items-start gap-[8px] text-[13px] text-sh-text-2">
                  <Icon icon={CornerDownRight} size={13} className="mt-[3px] shrink-0 text-sh-text-3" />
                  {d}
                </li>
              ))}
            </ul>
            <div className="mt-[12px] flex flex-wrap items-center justify-between gap-[8px]">
              <ConfidenceMark band={c.ai.band} />
              <TextLink
                onClick={() =>
                  openExplain({
                    touchpointId: `condition-${p.id}`,
                    capabilityId: 'AI-105',
                    claim: c.ai.text,
                    confidence: c.ai.band === 'HIGH' ? 0.9 : c.ai.band === 'MED' ? 0.72 : 0.45,
                    band: c.ai.band,
                    computedAt: formatTime(c.updatedAt),
                    inputs: [
                      { label: 'Results, observations and notes on the record', source: `${p.uhid} record` },
                      { label: 'Problem list', source: `${problems.length} coded problems` },
                    ],
                    evidence: c.ai.drivers,
                    model: c.ai.model,
                    limits: [
                      'Summarises what is charted — anything not written down is invisible to it.',
                      'It describes the record; the clinical judgement is yours.',
                    ],
                  })
                }
              >
                Why?
              </TextLink>
            </div>
          </Card>
        )}

        {risk && aiActive && (
          <Card
            titleSize="sm"
            title="Deterioration risk"
            right={
              risk.band === 'ABSTAIN' ? (
                <PillTag tone="warn" size="sm" icon={CircleHelp} className="font-medium">
                  Cannot assess
                </PillTag>
              ) : (
                <Chip word={risk.band} tone={RISK_TONE[risk.band]} />
              )
            }
            className="shadow-[inset_0_0_0_1.5px_var(--flags-ring)]"
          >
            {risk.band === 'ABSTAIN' ? (
              <p className="text-[14px] text-sh-text-2">{risk.abstainReason ?? 'Not enough charted data to score.'}</p>
            ) : (
              <>
                <p className="text-[15px] font-semibold tabular-nums text-sh-text">
                  {risk.score} <span className="font-normal text-sh-text-3">· {risk.trend}</span>
                </p>
                <ul className="mt-[8px] flex flex-col gap-[6px]">
                  {risk.drivers.map((d) => (
                    <li key={d.label} className="flex items-center gap-[8px] text-[13px] text-sh-text-2">
                      <Icon icon={d.direction === 'up' ? ArrowUp : ArrowDown} size={13} className="shrink-0 text-sh-text-3" />
                      <span className="min-w-0 flex-1">{d.label}</span>
                      <span className="tabular-nums text-sh-text-3">{Math.round(d.weight * 100)}%</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-[8px] text-[12px] tabular-nums text-sh-text-3">
              {risk.modelVersion} · {formatTime(risk.computedAt)}
            </p>
          </Card>
        )}

        <Card
          titleSize="sm"
          title="Latest observations"
          right={
            vitals[0] && (
              <span className="text-[12px] tabular-nums text-sh-text-3">
                {formatDate(vitals[0].at)} {formatTime(vitals[0].at)}
              </span>
            )
          }
        >
          {vitals.length === 0 ? (
            <EmptyState icon={Activity} why="No observations have been charted for this patient in this record." />
          ) : (
            <dl className="flex flex-col">
              {vitals.map((v, i) => (
                <div key={v.label} className={cn('flex flex-wrap items-center justify-between gap-[8px] py-[10px]', i > 0 && 'border-t border-sh-line', i === 0 && 'pt-0')}>
                  <dt className="text-[14px] text-sh-text-2">{v.label}</dt>
                  <dd className="flex items-center gap-[8px]">
                    <span className="text-[14px] font-semibold tabular-nums text-sh-text">{v.value}</span>
                    {v.flag !== 'Normal' && <ClinicalFlag flag={v.flag} />}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
      </div>
    </div>
  )
}

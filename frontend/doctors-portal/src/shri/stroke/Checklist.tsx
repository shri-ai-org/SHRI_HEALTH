/**
 * ARC-14's eligibility checklist — ported from `src/archetypes/index.tsx`
 * (Checklist :563). The items that need a decision come first and in full,
 * each with its consequence, its sub-flow and its actions; the ones already
 * satisfied fold behind "Satisfied · N", one line each, because a checklist a
 * clinician reads at 02:00 should be the three things that block, not the
 * seven things that exist. Every state carries an icon and a word.
 */

import { Ban, Check, ChevronDown, ChevronRight, CircleHelp, OctagonAlert, type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import type { CriterionState } from '@/data/stroke'

import { cn } from '../lib/cn'
import type { Tone } from '../mocks/types'
import { Card, CountBubble, Icon, PillTag } from '../ui/primitives'

export type ChecklistState = CriterionState | 'resolved'

export interface ChecklistItem {
  key: string
  label: string
  answer: ReactNode
  consequence: string
  state: ChecklistState
  subFlow?: ReactNode
  actions?: ReactNode
}

const TONE: Record<ChecklistState, { tone: Tone; icon: LucideIcon; label: string }> = {
  ok: { tone: 'norm', icon: Check, label: 'OK' },
  resolved: { tone: 'norm', icon: Check, label: 'Resolved' },
  blocks: { tone: 'crit', icon: Ban, label: 'Blocks' },
  unknown: { tone: 'warn', icon: CircleHelp, label: 'Unknown' },
  contraindicated: { tone: 'crit', icon: OctagonAlert, label: 'Contraindicated' },
}

export function Checklist({ items, label }: { items: ChecklistItem[]; label: string }) {
  const [showSatisfied, setShowSatisfied] = useState(false)
  const satisfied = items.filter((i) => i.state === 'ok' || i.state === 'resolved')
  const open = items.filter((i) => !satisfied.includes(i))

  const row = (item: ChecklistItem, full: boolean) => {
    const t = TONE[item.state]
    return (
      <li key={item.key} className={cn('px-[18px]', full ? 'py-[14px]' : 'py-[10px]')}>
        <div className="flex flex-wrap items-start justify-between gap-x-[16px] gap-y-[8px]">
          <div className="min-w-0 flex-1">
            <p className={cn('font-medium', full ? 'text-[15px] text-sh-text' : 'text-[14px] text-sh-text-2')}>{item.label}</p>
            <p className="mt-[2px] text-[14px] tabular-nums text-sh-text-2">{item.answer}</p>
          </div>
          <PillTag tone={t.tone} size="sm" icon={t.icon} className="font-semibold">
            {t.label}
          </PillTag>
        </div>
        {full && <p className="mt-[6px] text-[13px] text-sh-text-3">{item.consequence}</p>}
        {full && item.subFlow && <div className="mt-[10px]">{item.subFlow}</div>}
        {full && item.actions && <div className="mt-[10px] flex flex-wrap gap-[8px]">{item.actions}</div>}
      </li>
    )
  }

  return (
    <Card className="overflow-hidden p-0">
      {open.length === 0 && (
        <p className="flex items-center gap-[8px] px-[18px] py-[16px] text-[14px] font-medium text-sh-norm-fg">
          <Icon icon={Check} size={15} />
          Every criterion is satisfied.
        </p>
      )}
      <ul aria-label={label} className="divide-y divide-sh-line">
        {open.map((i) => row(i, true))}
      </ul>
      {satisfied.length > 0 && (
        <div className="border-t border-sh-line">
          <button
            type="button"
            aria-expanded={showSatisfied}
            onClick={() => setShowSatisfied((v) => !v)}
            className="flex min-h-[44px] w-full items-center gap-[8px] px-[18px] text-left text-[13px] font-semibold text-sh-text-2 transition-colors duration-150 hover:bg-sh-hover"
          >
            <Icon icon={showSatisfied ? ChevronDown : ChevronRight} size={14} className="text-sh-text-3" />
            {showSatisfied ? 'Hide satisfied' : 'Satisfied'}
            <CountBubble className="bg-sh-norm-bg text-sh-norm-fg">{satisfied.length}</CountBubble>
          </button>
          {showSatisfied && (
            <ul aria-label={`${label}, satisfied`} className="divide-y divide-sh-line border-t border-sh-line">
              {satisfied.map((i) => row(i, false))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}

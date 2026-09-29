/**
 * Small pieces the stroke case screens share: the state for an address with
 * no case behind it (the old screens threw on an unknown id and left a blank
 * app), the line a case with no recorded event stream shows in place of
 * another case's (see `logic/strokeCase.ts`), and AIP-05's banner.
 */

import { Brain, SearchX } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import type { ExplainTarget } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { useAiActive } from '../state/ai'
import { WhyLink } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { EmptyState } from '../ui/EmptyState'
import { Card, Diamond, Pill } from '../ui/primitives'

export function NoSuchCase({ screenId, id }: { screenId: string; id?: string }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  return (
    <ScreenFrame screenId={screenId} sub="No stroke case at this address.">
      <Card className="max-w-[672px]">
        <EmptyState
          icon={SearchX}
          why={`There is no stroke case with the id “${id ?? ''}”. Open one from the network wall.`}
          action={
            may('/stroke/wall') ? (
              <Pill variant="control" size="lg" icon={Brain} onClick={() => navigate('/stroke/wall')}>
                Command wall
              </Pill>
            ) : undefined
          }
        />
      </Card>
    </ScreenFrame>
  )
}

/** A case whose clocks, tasks and pages are not in the recorded stream says so, rather than showing the index case's. */
export function NoStream({ caseNo, what, className }: { caseNo: string; what: string; className?: string }) {
  return <p className={className ?? 'rounded-[14px] bg-sh-inner px-[14px] py-[12px] text-[14px] text-sh-text-2'}>{`No ${what} recorded for ${caseNo}.`}</p>
}

/**
 * AIP-05 — "Z3 or Z4 full-width strip, severity-coloured, with a Why? link",
 * ported from `src/components/ai.tsx` (AIBanner :868-905): ◆ and the title in
 * one wrapping run, the detail, the capability id, and nothing at all while
 * the AI fabric is off.
 */
export function AIBanner({
  capabilityId,
  title,
  detail,
  tone = 'warn',
  explain,
  action,
  className,
}: {
  capabilityId: string
  title: ReactNode
  detail?: ReactNode
  tone?: 'warn' | 'crit' | 'info'
  explain?: ExplainTarget
  action?: ReactNode
  className?: string
}) {
  const aiActive = useAiActive()
  if (!aiActive) return null
  return (
    <Alert
      tone={tone}
      role="status"
      className={className}
      title={
        <span className="flex items-start gap-[8px]">
          <Diamond className="mt-[5px]" />
          <span className="min-w-0">{title}</span>
        </span>
      }
      action={
        (action || explain) && (
          <div className="flex items-center gap-[8px]">
            {action}
            {explain && <WhyLink target={explain} className="min-h-[44px] px-[8px]" />}
          </div>
        )
      }
    >
      {detail}
      <span className="mt-[4px] block text-[12px] text-sh-text-3">{capabilityId}</span>
    </Alert>
  )
}

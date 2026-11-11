/**
 * §7.3 / Z4 — a screen's header: back · the heading and its quiet sub-line
 * (with the screen's status chips) · the screen's own actions · ⓘ. The
 * heading is the screen's name unless the screen gives one, as the old frame
 * drew it (`src/shell/Screen.tsx`); a stale screen says so beside the actions.
 */

import type { ReactNode } from 'react'

import type { ScreenSpec } from '@/atlas/registry'

import { useForcedState } from '../state/ai'
import { StaleChip } from '../ui/states'

import { BackButton } from './BackButton'
import { ScreenInfo } from './ScreenInfo'

export function ScreenHeader({
  spec,
  heading,
  sub,
  chips,
  actions,
}: {
  spec: ScreenSpec
  heading?: ReactNode
  sub?: ReactNode
  chips?: ReactNode
  actions?: ReactNode
}) {
  const stale = useForcedState() === 'STALE'
  return (
    <div className="flex flex-wrap items-center gap-[12px]">
      <BackButton />
      {/* A real basis, so the actions wrap under the title instead of truncating the sub-line. */}
      <div className="min-w-0 grow basis-[400px]">
        <h1 className="text-[28px]/[1.15] font-normal tracking-[-0.02em] text-sh-text">{heading ?? spec.name}</h1>
        {(sub || chips) && (
          <div className="mt-[4px] flex flex-wrap items-center gap-x-[10px] gap-y-[6px]">
            {sub && <p className="min-w-0 text-[13px] text-sh-text-3 sm:truncate">{sub}</p>}
            {chips && <span className="flex flex-wrap items-center gap-[6px]">{chips}</span>}
          </div>
        )}
      </div>

      <div className="ml-auto flex flex-wrap items-center justify-end gap-[12px]">
        {stale && <StaleChip />}
        {actions}
        <ScreenInfo spec={spec} />
      </div>
    </div>
  )
}

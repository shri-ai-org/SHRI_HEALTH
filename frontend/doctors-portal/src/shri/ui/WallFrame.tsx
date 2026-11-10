/**
 * ARC-12 command wall frame — ported from `src/archetypes/index.tsx`
 * (WallFrame :721-765): "Z5 only. No Z1, no Z2, no input affordances, no Z7b
 * bubble. Read at 3–4 metres, runs unattended for a shift... A stale wall
 * DIMS and states its last-good timestamp in large type. IT MUST ALSO WORK ON
 * A PHONE."
 */

import type { ReactNode } from 'react'

import { cn } from '../lib/cn'

export function WallFrame({ title, asOf, stale, children, onExit }: { title: string; asOf: string; stale?: boolean; children: ReactNode; onExit?: () => void }) {
  return (
    <div className={cn('min-h-dvh bg-sh-surface px-[16px] py-[16px] text-sh-text md:px-[32px] md:py-[24px]', stale && 'opacity-45')}>
      <header className="mb-[20px] flex flex-wrap items-baseline justify-between gap-[12px]">
        <h1 className="text-[24px] font-semibold tracking-[-0.01em] md:text-[36px]">{title}</h1>
        <div className="flex items-center gap-[12px]">
          <p className="text-[15px] tabular-nums text-sh-text-2 md:text-[20px]">as of {asOf}</p>
          {onExit && (
            <button type="button" onClick={onExit} title="Leave the wall view" className="inline-flex h-[44px] items-center rounded-full bg-sh-control px-[16px] text-[13px] text-sh-text-2 hover:bg-sh-hover">
              exit wall
            </button>
          )}
        </div>
      </header>
      {stale && (
        <p className="mb-[20px] rounded-sh-card bg-sh-warn-bg px-[24px] py-[20px] text-center text-[24px] font-bold tabular-nums text-sh-warn-fg md:text-[48px]">
          LAST GOOD DATA {asOf}
          <span className="mt-[8px] block text-[16px] font-medium md:text-[20px]">A wall showing confidently wrong data is worse than one showing none.</span>
        </p>
      )}
      {children}
    </div>
  )
}

/**
 * Z6 — a screen's right rail (`src/shell/Screen.tsx:305-352`): reference
 * material beside the work, 340px, and opening collapsed, because on most
 * screens it is reference material and reference material is one tap away.
 * Collapsed it is a narrow tab carrying its title and a count; below 1280px
 * it has no column of its own, so it opens inline under the work.
 */

import { ChevronDown, PanelRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'

import { CountBubble, Icon, RoundButton } from './primitives'

export function WithRail({ rail, title, badge, children }: { rail?: ReactNode; title: string; badge?: number; children: ReactNode }) {
  const collapsed = useUI((s) => s.railCollapsed)
  const toggle = useUI((s) => s.toggleRail)
  if (!rail) return <>{children}</>
  return (
    <div className="flex flex-col gap-[16px] lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-[16px]">{children}</div>
      <aside aria-label={title} className={cn('shrink-0', collapsed ? 'lg:w-[48px]' : 'w-full lg:w-[340px]')}>
        {collapsed ? (
          <>
            <button
              type="button"
              onClick={toggle}
              title={`Show ${title}`}
              aria-expanded="false"
              className="sh-frosted sticky top-[16px] hidden w-[48px] flex-col items-center gap-[8px] rounded-sh-card py-[12px] shadow-sh-pop transition-colors duration-150 hover:bg-sh-hover lg:flex"
            >
              <Icon icon={PanelRight} size={16} className="text-sh-text-3" />
              {badge !== undefined && badge > 0 && <CountBubble active>{badge}</CountBubble>}
              <span className="text-[12px] font-semibold text-sh-text-2 [writing-mode:vertical-rl]">{title}</span>
            </button>
            {/* Below 1280 the rail has no column of its own, so it opens inline. */}
            <button
              type="button"
              onClick={toggle}
              aria-expanded="false"
              className="flex min-h-[48px] w-full items-center justify-between gap-[8px] rounded-sh-card bg-sh-card px-[18px] text-[14px] font-semibold text-sh-text transition-colors duration-150 hover:bg-sh-hover lg:hidden"
            >
              <span className="flex items-center gap-[8px]">
                <Icon icon={PanelRight} size={15} className="text-sh-text-3" />
                {title}
                {badge !== undefined && badge > 0 && <CountBubble active>{badge}</CountBubble>}
              </span>
              <Icon icon={ChevronDown} size={15} className="text-sh-text-3" />
            </button>
          </>
        ) : (
          <div className="flex flex-col gap-[12px]">
            <div className="flex min-h-[40px] items-center gap-[8px]">
              <h2 className="flex-1 text-[15px] font-semibold text-sh-text">{title}</h2>
              <RoundButton icon={PanelRight} size={36} iconSize={15} variant="control" label={`Collapse ${title}`} aria-expanded="true" onClick={toggle} />
            </div>
            {rail}
          </div>
        )}
      </aside>
    </div>
  )
}

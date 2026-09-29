/**
 * A row of pill tabs choosing which slice of one list to show — the old
 * build's `PillTabs` (`src/components/calm.tsx`): `role=tablist`, each option a
 * `tab` with `aria-selected`, an optional icon and count. Active: `--primary`
 * with an accent count; inactive: `--control`.
 */

import type { LucideIcon } from 'lucide-react'

import { cn } from '../lib/cn'

import { CountBubble, Icon } from './primitives'

export interface SegmentOption<K extends string> {
  key: K
  label: string
  icon?: LucideIcon
  count?: number
}

export function Segmented<K extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: K
  options: SegmentOption<K>[]
  onChange: (key: K) => void
  className?: string
}) {
  return (
    // Wrapped rows sit 8px apart, so each 36px tab keeps a 44px target of its own.
    <div role="tablist" aria-label={label} className={cn('flex flex-wrap items-center gap-x-[4px] gap-y-[8px]', className)}>
      {options.map((o) => {
        const on = o.key === value
        return (
          <button
            key={o.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.key)}
            className={cn(
              'inline-flex h-[36px] shrink-0 items-center gap-[6px] rounded-full px-[12px] text-[13px] font-medium transition-colors duration-150',
              on ? 'bg-sh-primary text-sh-on-primary' : 'bg-sh-control text-sh-text hover:bg-sh-hover-strong',
            )}
          >
            {o.icon && <Icon icon={o.icon} size={14} strokeWidth={2} />}
            {o.label}
            {o.count !== undefined && <CountBubble active={on}>{o.count}</CountBubble>}
          </button>
        )
      })}
    </div>
  )
}

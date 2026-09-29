/**
 * An empty list says why it is empty and what would fill it — the old build's
 * `EmptyState` (`src/components/primitives.tsx`), in this build's look.
 *
 * `compact` is the card placeholder: a card with nothing to show keeps its
 * size and its header, and says so in one short factual line under a neutral
 * icon, centred in whatever height the card has — never collapsed, never an
 * alarm, never an invented value.
 */

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '../lib/cn'

import { Icon } from './primitives'

export function EmptyState({ icon, why, action, compact, className }: { icon: LucideIcon; why: string; action?: ReactNode; compact?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'min-h-[120px] flex-1 gap-[10px] px-[16px] py-[20px]' : 'gap-[12px] px-[24px] py-[48px]',
        className,
      )}
    >
      <span className={cn('inline-flex items-center justify-center rounded-full bg-sh-inner text-sh-text-3', compact ? 'size-[40px]' : 'size-[48px]')} aria-hidden="true">
        <Icon icon={icon} size={compact ? 18 : 22} />
      </span>
      <p className={cn('max-w-[440px] text-sh-text-2', compact ? 'text-[13px]/[1.45]' : 'text-[14px]/[1.5]')}>{why}</p>
      {action}
    </div>
  )
}

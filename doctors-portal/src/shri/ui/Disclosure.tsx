/**
 * Two folds from the old build (`src/components/calm.tsx`): `Disclosure`, a
 * collapsed group inside a list ("Show low-confidence ›"), and `Why`, the
 * rationale behind a rule, one tap away rather than on the surface.
 */

import { ChevronDown, ChevronRight, Info } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'

import { cn } from '../lib/cn'

import { CountBubble, Icon } from './primitives'

export function Disclosure({ label, count, defaultOpen = false, className, children }: { label: string; count?: number; defaultOpen?: boolean; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className={cn('min-w-0', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[44px] w-full items-center gap-[8px] rounded-[12px] px-[10px] text-left text-[13px] font-semibold text-sh-text-2 transition-colors duration-150 hover:bg-sh-hover"
      >
        <Icon icon={open ? ChevronDown : ChevronRight} size={14} className="text-sh-text-3" />
        {open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        {count !== undefined && <CountBubble className="bg-sh-control">{count}</CountBubble>}
      </button>
      {open && (
        <div id={id} className="mt-[4px]">
          {children}
        </div>
      )}
    </div>
  )
}

export function Why({ label = 'Why this works this way', className, children }: { label?: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className={cn('min-w-0', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-[36px] items-center gap-[6px] rounded-full px-[8px] text-[12px] text-sh-text-3 transition-colors duration-150 hover:bg-sh-hover hover:text-sh-text-2"
      >
        <Icon icon={Info} size={13} />
        {label}
        <Icon icon={open ? ChevronDown : ChevronRight} size={12} />
      </button>
      {open && (
        <div id={id} className="mt-[8px] flex flex-col gap-[10px] text-[13px]/[1.55] text-sh-text-2">
          {children}
        </div>
      )}
    </div>
  )
}

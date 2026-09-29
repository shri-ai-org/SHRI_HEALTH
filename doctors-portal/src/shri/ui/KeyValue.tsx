/**
 * A label and its value on one line — ported from `src/components/
 * primitives.tsx` (KeyValue :693). Used inside a `<dl>`; the value is
 * right-aligned and wraps under the label when there is no room.
 */

import type { ReactNode } from 'react'

import { cn } from '../lib/cn'

export function KeyValue({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[2px] py-[6px]', className)}>
      <dt className="text-[13px] text-sh-text-2">{label}</dt>
      <dd className="text-right text-[14px] font-medium text-sh-text">{children}</dd>
    </div>
  )
}

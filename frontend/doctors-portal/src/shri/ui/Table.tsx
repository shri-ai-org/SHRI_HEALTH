/**
 * A data table — ported from `src/components/primitives.tsx` (Table :347, Th,
 * Td, Tr): a sticky header, a caption for screen readers, and the row-count
 * line ARC-01 requires under every worklist. A row with `onClick` is a row you
 * can open: focusable, Enter or Space opens it.
 */

import type { ComponentPropsWithoutRef, ReactNode } from 'react'

import { cn } from '../lib/cn'

export function Table({ head, children, rowCount, caption, className }: { head: ReactNode; children: ReactNode; rowCount?: string; caption?: string; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="sticky top-0 z-10">
            <tr className="bg-sh-inner">{head}</tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {rowCount && <p className="border-t border-sh-line px-[16px] py-[8px] text-[12px] tabular-nums text-sh-text-3">{rowCount}</p>}
    </div>
  )
}

export function Th({ children, className, ...rest }: ComponentPropsWithoutRef<'th'>) {
  return (
    <th scope="col" {...rest} className={cn('px-[16px] py-[8px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3', className)}>
      {children}
    </th>
  )
}

export function Td({ children, className, ...rest }: ComponentPropsWithoutRef<'td'>) {
  return (
    <td {...rest} className={cn('border-t border-sh-line px-[16px] py-[12px] align-middle text-[14px] text-sh-text', className)}>
      {children}
    </td>
  )
}

export function Tr({ children, selected, onClick, className, ...rest }: ComponentPropsWithoutRef<'tr'> & { selected?: boolean }) {
  return (
    <tr
      {...rest}
      onClick={onClick}
      aria-selected={onClick ? Boolean(selected) : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick(e as unknown as React.MouseEvent<HTMLTableRowElement>)
              }
            }
          : undefined
      }
      className={cn(onClick && 'cursor-pointer', 'transition-colors duration-150 hover:bg-sh-hover', selected && 'bg-sh-hover-strong', className)}
    >
      {children}
    </tr>
  )
}

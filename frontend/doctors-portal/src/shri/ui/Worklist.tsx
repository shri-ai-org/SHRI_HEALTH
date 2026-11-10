/**
 * ARC-01 Worklist — ported from `src/archetypes/index.tsx` (Worklist :63-376),
 * so every queue carries the atlas's rules by using it rather than by
 * remembering them:
 *   · a row-count line under the list;
 *   · the current sort named in the header (`RankedSort`), the deterministic
 *     one always one choice away;
 *   · ↑/↓ move selection, Enter opens, Space previews;
 *   · selection survives a background refresh;
 *   · with the AI off the order is the deterministic one, applied on mount and
 *     on an explicit change — never re-ordered under the user mid-scan.
 *
 * Two shapes from one column list. `calm` (the default) is one line per row
 * with a quiet context line, the row itself the button; `table` is a data
 * table. A column's `role` decides its slot in `calm`: lead (time, token,
 * bed), primary (the identifying line), context (joined by middots; empty
 * cells dropped), status (right-aligned), trailing (dropped — the row is
 * already a button).
 */

import { Inbox, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { cn } from '../lib/cn'

import { EmptyState } from './EmptyState'
import { Card, CountBubble, Icon } from './primitives'
import { RankedSort } from './RankedSort'
import { Table, Td, Th, Tr } from './Table'

export interface WorklistColumn<T> {
  key: string
  label: string
  cell: (row: T) => ReactNode
  className?: string
  /** Hidden below the md breakpoint in the table shape. */
  secondary?: boolean
  role?: 'lead' | 'primary' | 'context' | 'status' | 'trailing'
}

export function Worklist<T>({
  rows,
  columns,
  rowKey,
  onOpen,
  onPreview,
  aiSort,
  onSortChange,
  sortCapability,
  aiSortLabel = 'AI acuity',
  deterministicLabel = 'Chronological',
  filters,
  emptyWhy,
  emptyAction,
  caption,
  pinned,
  pinnedLabel,
  variant = 'calm',
  noun = 'rows',
  rowLabel,
  rowAction,
}: {
  rows: T[]
  columns: WorklistColumn<T>[]
  rowKey: (row: T) => string
  onOpen?: (row: T) => void
  onPreview?: (row: T) => void
  aiSort?: boolean
  onSortChange?: (aiSort: boolean) => void
  sortCapability?: string
  aiSortLabel?: string
  deterministicLabel?: string
  filters?: ReactNode
  emptyWhy: string
  emptyAction?: ReactNode
  /** The list's accessible name. */
  caption: string
  /** Rows pinned above the list — "needs attention". */
  pinned?: T[]
  pinnedLabel?: string
  variant?: 'table' | 'calm'
  /** What a row IS, for the count line — "patients", "results". Plural. */
  noun?: string
  /** A calm row's accessible name, where its visible text is not enough. */
  rowLabel?: (row: T) => string
  /** A calm row's own action (OPD's "Call"), drawn beside the row button rather than inside it. */
  rowAction?: (row: T) => ReactNode
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const all = useMemo(() => [...(pinned ?? []), ...rows], [pinned, rows])

  // ↑/↓ move selection, Enter opens, Space previews — while the list has focus or a selection.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT') return
      if (!containerRef.current?.contains(document.activeElement) && selected === null) return
      const index = all.findIndex((r) => rowKey(r) === selected)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected(rowKey(all[Math.min(all.length - 1, index + 1)] ?? all[0]))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected(rowKey(all[Math.max(0, index - 1)] ?? all[0]))
      } else if (e.key === 'Enter' && index >= 0 && containerRef.current?.contains(document.activeElement)) {
        e.preventDefault()
        onOpen?.(all[index])
      } else if (e.key === ' ' && index >= 0 && onPreview) {
        e.preventDefault()
        onPreview(all[index])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [all, rowKey, selected, onOpen, onPreview])

  // The selected row takes focus, so a keyboard user sees where they are.
  useEffect(() => {
    if (selected === null || !containerRef.current) return
    const el = containerRef.current.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(selected)}"]`)
    if (el && containerRef.current.contains(document.activeElement) && document.activeElement !== el) el.focus()
  }, [selected])

  const countLine = `${all.length} ${all.length === 1 ? noun.replace(/s$/, '') : noun}${pinned && pinned.length ? ` · ${pinned.length} first` : ''}`

  const header = (
    <div className="mb-[12px] flex flex-wrap items-center justify-between gap-[12px]">
      <div className="flex flex-wrap items-center gap-[8px]">{filters}</div>
      {onSortChange && sortCapability && (
        <RankedSort aiSort={aiSort ?? true} onChange={onSortChange} aiLabel={aiSortLabel} deterministicLabel={deterministicLabel} capabilityId={sortCapability} label={`Sort ${caption}`} />
      )}
    </div>
  )

  function calmRow(row: T, emphasis?: boolean) {
    const key = rowKey(row)
    const slot = (role: WorklistColumn<T>['role']) => columns.filter((c) => c.role === role)
    const lead = slot('lead')[0]
    const primary = slot('primary')[0] ?? columns[0]
    const status = slot('status')
    // A context cell that renders nothing is dropped, so no row ends in a dangling middot.
    const context = columns
      .filter((c) => c !== lead && c !== primary && !status.includes(c) && c.role !== 'trailing')
      .map((c) => ({ column: c, node: c.cell(row) }))
      .filter(({ node }) => node !== null && node !== undefined && node !== false && node !== '')
    const action = rowAction?.(row)
    return (
      <li key={key} className={cn('border-t border-sh-line first:border-t-0', action && 'flex flex-wrap items-center')}>
        <button
          type="button"
          data-row-key={key}
          aria-label={rowLabel?.(row)}
          aria-current={selected === key ? true : undefined}
          onClick={() => {
            setSelected(key)
            onOpen?.(row)
          }}
          className={cn(
            action && 'flex-1 max-sm:basis-full',
            'relative grid min-h-[64px] w-full min-w-0 grid-cols-[1fr_auto] items-center gap-x-[16px] gap-y-[6px] px-[14px] py-[12px] text-left transition-colors duration-150 hover:bg-sh-hover sm:px-[18px]',
            lead && 'sm:grid-cols-[76px_1fr_auto]',
            selected === key && 'bg-sh-hover-strong',
            emphasis && selected !== key && 'bg-sh-crit-bg/40',
          )}
        >
          {/* A pinned row carries the priority hue as a left bar, never as a full tint. */}
          {emphasis && <span aria-hidden="true" className="absolute inset-y-[8px] left-0 w-[4px] rounded-r-full bg-sh-crit" />}
          {lead && (
            <span className="order-2 inline-flex min-h-[32px] items-center justify-center self-center justify-self-start whitespace-nowrap rounded-[10px] bg-sh-inner px-[10px] text-[13px] font-semibold tabular-nums text-sh-text-2 sm:order-none sm:w-full">
              {lead.cell(row)}
            </span>
          )}
          <span className="order-1 col-span-1 min-w-0 sm:order-none">
            <span className="block truncate text-[15px] font-semibold text-sh-text">{primary.cell(row)}</span>
            {context.length > 0 && (
              <span className="mt-[2px] flex flex-wrap items-center gap-x-[8px] gap-y-[4px] text-[13px] text-sh-text-2">
                {context.map(({ column, node }, i) => (
                  <span key={column.key} className="flex min-w-0 items-center gap-[8px]">
                    <span className="min-w-0">{node}</span>
                    {i < context.length - 1 && (
                      <span aria-hidden="true" className="text-sh-text-3">
                        ·
                      </span>
                    )}
                  </span>
                ))}
              </span>
            )}
          </span>
          {status.length > 0 && (
            <span className="order-3 flex shrink-0 flex-col items-end gap-[6px] sm:order-none">
              {status.map((c) => (
                <span key={c.key}>{c.cell(row)}</span>
              ))}
            </span>
          )}
        </button>
        {/* Beside the row where it fits; under it, right-aligned, on a phone. */}
        {action && <span className="ml-auto shrink-0 pr-[14px] max-sm:pb-[12px] sm:pr-[18px]">{action}</span>}
      </li>
    )
  }

  function tableRow(row: T, emphasis?: boolean) {
    const key = rowKey(row)
    return (
      <Tr
        key={key}
        data-row-key={key}
        selected={selected === key}
        onClick={() => {
          setSelected(key)
          onOpen?.(row)
        }}
        className={emphasis ? 'bg-sh-crit-bg/40' : undefined}
      >
        {columns.map((c) => (
          <Td key={c.key} className={cn(c.className, c.secondary && 'hidden md:table-cell')}>
            {c.cell(row)}
          </Td>
        ))}
      </Tr>
    )
  }

  const pinnedHead = pinned && pinned.length > 0 && (
    <span className="flex items-center gap-[8px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-crit-fg">
      <Icon icon={TriangleAlert} size={13} />
      {pinnedLabel ?? 'Needs attention'}
      <CountBubble className="bg-sh-crit-bg text-sh-crit-fg">{pinned.length}</CountBubble>
    </span>
  )

  return (
    <div ref={containerRef}>
      {header}
      {all.length === 0 ? (
        <Card>
          <EmptyState icon={Inbox} why={emptyWhy} action={emptyAction} />
        </Card>
      ) : variant === 'calm' ? (
        <Card className="overflow-hidden p-0">
          <ul aria-label={caption}>
            {pinned && pinned.length > 0 && (
              <>
                <li className="bg-sh-crit-bg/40 px-[18px] py-[8px]">{pinnedHead}</li>
                {pinned.map((r) => calmRow(r, true))}
              </>
            )}
            {rows.map((r) => calmRow(r))}
          </ul>
          <p className="border-t border-sh-line px-[18px] py-[10px] text-[12px] tabular-nums text-sh-text-3">
            {countLine}
            <span className="sr-only"> · arrow keys to move, Enter to open</span>
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <Table
            head={columns.map((c) => (
              <Th key={c.key} className={cn(c.className, c.secondary && 'hidden md:table-cell')}>
                {c.label}
              </Th>
            ))}
            caption={caption}
            rowCount={`${all.length} ${all.length === 1 ? 'row' : 'rows'}${pinned && pinned.length ? ` · ${pinned.length} pinned to the top` : ''} · ↑↓ to move, Enter to open`}
          >
            {pinned && pinned.length > 0 && (
              <>
                <tr>
                  <td colSpan={columns.length} className="bg-sh-crit-bg/40 px-[16px] py-[6px]">
                    {pinnedHead}
                  </td>
                </tr>
                {pinned.map((r) => tableRow(r, true))}
              </>
            )}
            {rows.map((r) => tableRow(r))}
          </Table>
        </Card>
      )}
    </div>
  )
}

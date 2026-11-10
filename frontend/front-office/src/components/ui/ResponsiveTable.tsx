import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '../../utils/cn'

/** Where a column's value goes in the phone card. */
export type MobileSlot = 'title' | 'subtitle' | 'aside' | 'meta' | 'actions' | 'hidden'

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** Extra th/td classes — alignment, `whitespace-nowrap`, a width. */
  className?: string
  /** Right-aligned, tabular figures. */
  numeric?: boolean
  /** Phone placement. Defaults to a labelled meta pair. */
  mobile?: MobileSlot
  /** Label for a meta pair when the header is not plain text. */
  label?: string
  /** Makes the column sortable (asc → desc → off). */
  sortValue?: (row: T) => string | number
}

type Sort = { key: string; dir: 'asc' | 'desc' } | null

/**
 * The data table (DESIGN_SYSTEM §10.9). It is a real table — sticky head,
 * optional sorting, ↑ ↓ Home End move between rows and Enter opens one —
 * whenever its columns fit the space it has. When they do not (always on a
 * phone, and on any screen where the columns would need sideways scrolling)
 * the same rows become stacked records with labelled values. The fit is
 * measured, not guessed from the screen width, so it holds with or without
 * the sidebar and at any zoom or text size.
 */
export function ResponsiveTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  rowLabel,
  caption,
  maxHeight,
  showFooter = false,
  rowClassName,
  listLimit,
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  /** Opens a row (click, or Enter on a focused row). */
  onRowClick?: (row: T) => void
  /** Accessible name for a focusable row, e.g. the patient's name. */
  rowLabel?: (row: T) => string
  caption?: string
  /** A bounded, scrolling box from tablet up (e.g. `md:max-h-[28rem]`) with a
   *  sticky head. Phones show every row — no scroll box inside the page. */
  maxHeight?: string
  /** "24 rows · sorted by Date" under the table. */
  showFooter?: boolean
  rowClassName?: (row: T) => string | undefined
  /** Show this many rows, then "Show more" (table and phone list alike) —
   *  a long log stays a normal-length page with no scroll box inside it. */
  listLimit?: number
}) {
  const [sort, setSort] = useState<Sort>(null)
  const [tooWide, setTooWide] = useState(false)
  const [listShown, setListShown] = useState(listLimit ?? Number.POSITIVE_INFINITY)
  const body = useRef<HTMLTableSectionElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const table = useRef<HTMLTableElement>(null)

  // Does the table fit? The table is always laid out (visibly, or hidden as
  // a measuring copy), so its natural width is known before paint and on
  // every resize or data change.
  useLayoutEffect(() => {
    const outer = box.current
    if (!outer) return undefined
    const measure = () => {
      const t = table.current
      if (!t || t.getClientRects().length === 0) return
      setTooWide(t.scrollWidth > outer.clientWidth + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(outer)
    if (table.current) observer.observe(table.current)
    return () => observer.disconnect()
  }, [rows, columns])

  const sorted = useMemo(() => {
    if (!sort) return rows
    const column = columns.find((c) => c.key === sort.key)
    if (!column?.sortValue) return rows
    const value = column.sortValue
    const factor = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = value(a)
      const y = value(b)
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * factor
      return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }) * factor
    })
  }, [rows, columns, sort])

  function cycleSort(key: string) {
    setSort((current) => {
      if (!current || current.key !== key) return { key, dir: 'asc' }
      if (current.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: T) {
    const rowsEls = [...(body.current?.querySelectorAll<HTMLTableRowElement>('tr[tabindex]') ?? [])]
    const at = rowsEls.indexOf(event.currentTarget)
    const focus = (index: number) => {
      event.preventDefault()
      rowsEls[Math.max(0, Math.min(rowsEls.length - 1, index))]?.focus()
    }
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onRowClick?.(row)
    } else if (event.key === 'ArrowDown') focus(at + 1)
    else if (event.key === 'ArrowUp') focus(at - 1)
    else if (event.key === 'Home') focus(0)
    else if (event.key === 'End') focus(rowsEls.length - 1)
  }

  const sortedColumn = sort ? columns.find((c) => c.key === sort.key) : undefined
  const slot = (c: Column<T>): MobileSlot => c.mobile ?? 'meta'
  const titleCols = columns.filter((c) => slot(c) === 'title')
  const subtitleCols = columns.filter((c) => slot(c) === 'subtitle')
  const asideCols = columns.filter((c) => slot(c) === 'aside')
  const metaCols = columns.filter((c) => slot(c) === 'meta')
  const actionCols = columns.filter((c) => slot(c) === 'actions')

  return (
    <div ref={box} className="@container relative min-w-0">
      {/* ── the table, while its columns fit (never below md) ────────── */}
      <div
        data-layout="table"
        aria-hidden={tooWide || undefined}
        inert={tooWide || undefined}
        className={cn(
          tooWide
            ? 'pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden'
            : cn('hidden md:block', maxHeight && cn('md:overflow-y-auto', maxHeight)),
        )}
      >
        <table ref={table} className="w-full border-collapse text-left text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="sticky top-0 z-10 bg-[color-mix(in_oklab,var(--color-hue-blue)_7%,var(--color-surface-2))] backdrop-blur">
            <tr>
              {columns.map((column) => {
                const active = sort?.key === column.key
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : column.sortValue ? 'none' : undefined}
                    className={cn(
                      'border-b border-[color-mix(in_oklab,var(--color-hue-blue)_14%,var(--color-border-soft))] px-3 py-2 text-2xs font-semibold uppercase tracking-[0.06em] text-[color-mix(in_oklab,var(--color-hue-blue)_28%,var(--color-ink-muted))] first:pl-4 last:pr-4 xl:first:pl-5 xl:last:pr-5',
                      column.numeric && 'text-right',
                      column.className,
                    )}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        onClick={() => cycleSort(column.key)}
                        className={cn(
                          'focus-ring -mx-1 inline-flex min-h-8 items-center gap-1 rounded px-1 font-semibold uppercase tracking-[0.06em] transition-colors hover:text-ink',
                          column.numeric && 'flex-row-reverse',
                        )}
                      >
                        {column.header}
                        {active ? (
                          sort!.dir === 'asc' ? (
                            <ChevronUp size={13} aria-hidden="true" />
                          ) : (
                            <ChevronDown size={13} aria-hidden="true" />
                          )
                        ) : (
                          <ChevronsUpDown size={13} className="opacity-40" aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody ref={body}>
            {sorted.slice(0, listShown).map((row) => (
              <tr
                key={rowKey(row)}
                tabIndex={onRowClick ? 0 : undefined}
                aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (event) => handleRowKeyDown(event, row) : undefined}
                className={cn(
                  'clinical-row border-b border-border-soft transition-colors last:border-b-0 hover:bg-primary-50/50',
                  onRowClick && 'focus-ring cursor-pointer',
                  rowClassName?.(row),
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn('px-3 py-2.5 align-middle first:pl-4 last:pr-4 xl:first:pl-5 xl:last:pr-5', column.numeric && 'text-right tabular-nums', column.className)}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {showFooter ? (
          <p className="border-t border-border-soft px-5 py-1.5 text-2xs text-ink-subtle">
            {rows.length} {rows.length === 1 ? 'row' : 'rows'}
            {sortedColumn ? ` · sorted by ${sortedColumn.label ?? (typeof sortedColumn.header === 'string' ? sortedColumn.header : sortedColumn.key)}` : ''}
          </p>
        ) : null}
      </div>

      {/* ── otherwise: stacked records ───────────────────────────────── */}
      <ul className={cn('divide-y divide-border-soft', !tooWide && 'md:hidden', maxHeight && cn('md:overflow-y-auto', maxHeight))} aria-label={caption}>
        {sorted.slice(0, listShown).map((row) => (
          <li
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cn('px-4 py-3 @2xl:px-5', onRowClick && 'cursor-pointer transition-colors hover:bg-surface-2 active:bg-surface-2', rowClassName?.(row))}
          >
            {titleCols.length || asideCols.length ? (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {titleCols.map((c) => (
                    <div key={c.key} className="min-w-0 text-sm font-semibold text-ink">
                      {c.cell(row)}
                    </div>
                  ))}
                  {subtitleCols.map((c) => (
                    <div key={c.key} className="mt-0.5 min-w-0 text-xs text-ink-muted">
                      {c.cell(row)}
                    </div>
                  ))}
                </div>
                {asideCols.length ? (
                  <div className="flex max-w-[50%] shrink-0 flex-col items-end gap-1 text-right">
                    {asideCols.map((c) => (
                      <div key={c.key} className="max-w-full">
                        {c.cell(row)}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {metaCols.length || actionCols.length ? (
              <div className="@4xl:flex @4xl:items-end @4xl:gap-6">
                {metaCols.length ? (
                  <dl className="mt-2.5 grid min-w-0 flex-1 grid-cols-1 gap-x-4 gap-y-2 @xs:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4 @6xl:grid-cols-5">
                    {metaCols.map((c) => (
                      <div key={c.key} className="min-w-0">
                        <dt className="text-2xs text-ink-subtle">{c.label ?? c.header}</dt>
                        <dd className={cn('break-words text-xs text-ink', c.numeric && 'tabular-nums')}>{c.cell(row)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {actionCols.length ? (
                  <div className="mt-3 flex shrink-0 flex-wrap gap-2 @4xl:mt-0" onClick={(event) => event.stopPropagation()}>
                    {actionCols.map((c) => (
                      <div key={c.key} className="flex flex-wrap gap-2">
                        {c.cell(row)}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {sorted.length > listShown ? (
        <div className="border-t border-border-soft px-4 py-1.5 @2xl:px-5">
          <button
            type="button"
            onClick={() => setListShown((n) => n + (listLimit ?? sorted.length))}
            className="focus-ring inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-sm font-semibold text-primary-text hover:underline"
          >
            <ChevronDown size={15} aria-hidden="true" />
            Show {Math.min(listLimit ?? sorted.length, sorted.length - listShown)} more
            <span className="font-normal text-ink-subtle">· {sorted.length - listShown} left</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}

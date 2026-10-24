import type { ReactNode } from 'react'
import { Button } from './Button'
import { EmptyState } from './feedback'

export interface Column<Row> {
  key: string
  header: string
  render: (row: Row) => ReactNode
  /** Numbers right-aligned with tabular figures. */
  numeric?: boolean
}

export interface DataTableProps<Row> {
  /** Read by screen readers as the table's name. */
  caption: string
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string
  /**
   * Lists use cursors and "Load more", never page numbers or totals (API_STANDARDS §8, ADR-0004):
   * pass `hasMore` when the response had a `nextCursor`.
   */
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  emptyTitle?: string
  emptyDescription?: string
}

export function DataTable<Row>({ caption, columns, rows, rowKey, hasMore = false, loadingMore = false, onLoadMore, emptyTitle = 'Nothing here yet', emptyDescription }: DataTableProps<Row>) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} {...(emptyDescription ? { description: emptyDescription } : {})} />
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border-soft bg-surface-1">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-surface-2">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`border-b border-border-soft px-3 py-2 text-xs font-semibold text-ink-muted ${c.numeric ? 'text-right' : ''}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-border-soft last:border-0 hover:bg-surface-2">
              {columns.map((c) => (
                <td key={c.key} className={`px-3 py-2 text-sm text-ink ${c.numeric ? 'text-right tabular-nums' : ''}`}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && onLoadMore ? (
        <div className="flex justify-center border-t border-border-soft p-3">
          <Button variant="outline" loading={loadingMore} onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  )
}

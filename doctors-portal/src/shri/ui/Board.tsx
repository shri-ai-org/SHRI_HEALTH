/**
 * ARC-04 Board — ported from `src/archetypes/index.tsx` (Board :377-517).
 * The load-bearing rule: "A DRAG THAT VIOLATES A HARD RULE IS REFUSED WITH AN
 * INLINE REASON ON THE TARGET", never silently reverted. `canDrop` returns
 * true or the reason, and the reason is shown on the column tried.
 *
 * Folded columns ("Done", "Tomorrow") sit behind a pill until tapped; a drag
 * onto a folded column is impossible, which is the point.
 *
 * Where the old board fell short: a drag was its only way to move a card, so
 * a keyboard or touch user could not move one at all — here each movable card
 * carries a "Move to" choice that goes through the same `canDrop` and lands
 * the same refusal on the same column; and the drag carried no data, which
 * Firefox refuses to start — here it carries the card's key.
 */

import { Ban, ChevronRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { cn } from '../lib/cn'
import type { Tone } from '../mocks/types'

import { CountBubble, Icon } from './primitives'

export interface BoardColumn<T> {
  key: string
  label: string
  /** Column headers carry counts and a capacity signal. */
  capacity?: string
  tone?: Tone
  rows: T[]
}

export function Board<T>({
  columns,
  rowKey,
  rowName,
  renderCard,
  asOf,
  legend,
  canDrop,
  onDrop,
  hiddenColumns = [],
}: {
  columns: BoardColumn<T>[]
  rowKey: (row: T) => string
  /** What the card is called, for its "Move to" control. */
  rowName?: (row: T) => string
  renderCard: (row: T) => ReactNode
  asOf?: ReactNode
  legend?: ReactNode
  canDrop?: (row: T, columnKey: string) => true | string
  onDrop?: (row: T, columnKey: string) => void
  hiddenColumns?: string[]
}) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<{ column: string; reason: string } | null>(null)
  const [revealed, setRevealed] = useState<string[]>([])

  const flat = columns.flatMap((c) => c.rows)
  const folded = columns.filter((c) => hiddenColumns.includes(c.key) && !revealed.includes(c.key))
  const shown = columns.filter((c) => !folded.includes(c))

  /** One move, however it was asked for — a drop or the "Move to" choice. */
  function move(row: T, columnKey: string) {
    if (!canDrop) return
    const verdict = canDrop(row, columnKey)
    if (verdict === true) {
      setRefusal(null)
      onDrop?.(row, columnKey)
    } else {
      setRefusal({ column: columnKey, reason: verdict })
      // A folded target is opened, so its refusal is seen where it was refused.
      if (hiddenColumns.includes(columnKey)) setRevealed((r) => (r.includes(columnKey) ? r : [...r, columnKey]))
    }
  }

  return (
    <div>
      {(legend || asOf || folded.length > 0) && (
        <div className="mb-[12px] flex flex-wrap items-center justify-between gap-[12px]">
          <div className="flex flex-wrap items-center gap-[8px]">
            {legend}
            {folded.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setRevealed((r) => [...r, c.key])}
                className="inline-flex h-[44px] items-center gap-[6px] rounded-full bg-sh-control px-[14px] text-[13px] font-semibold text-sh-text-2 hover:bg-sh-hover hover:text-sh-text"
              >
                <Icon icon={ChevronRight} size={13} />
                {c.label}
                <CountBubble className="bg-sh-card">{c.rows.length}</CountBubble>
              </button>
            ))}
          </div>
          {asOf}
        </div>
      )}

      <div
        className={cn(
          // Positioned, so the cards' 44px hit areas stay inside the scroller instead of widening the page.
          'relative -mx-[16px] flex gap-[16px] overflow-x-auto px-[16px] pb-[8px] md:mx-0 md:grid md:overflow-visible md:px-0',
          shown.length >= 5 ? 'md:grid-cols-3 xl:grid-cols-5' : shown.length === 4 ? 'md:grid-cols-2 lg:grid-cols-4' : shown.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2',
        )}
      >
        {shown.map((col) => {
          const refused = refusal?.column === col.key
          return (
            <section
              key={col.key}
              aria-label={col.label}
              onDragOver={(e) => {
                if (!dragging || !canDrop) return
                const row = flat.find((r) => rowKey(r) === dragging)
                if (!row) return
                const verdict = canDrop(row, col.key)
                if (verdict === true) {
                  e.preventDefault()
                  setRefusal(null)
                } else {
                  setRefusal({ column: col.key, reason: verdict })
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                const key = e.dataTransfer.getData('text/plain') || dragging
                const row = flat.find((r) => rowKey(r) === key)
                if (row) move(row, col.key)
                setDragging(null)
              }}
              className={cn('flex w-[288px] shrink-0 flex-col gap-[8px] rounded-sh-card bg-sh-inner p-[10px] md:w-auto', refused && 'inset-ring-1 inset-ring-(--crit-fg)')}
            >
              <header className="flex items-center justify-between gap-[8px] px-[6px] pt-[4px]">
                <h3 className="flex items-center gap-[8px] text-[12px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">
                  {col.label}
                  <CountBubble className={col.tone ? `sh-tone-${col.tone} bg-(--t-bg) text-(--t-fg)` : 'bg-sh-card'}>{col.rows.length}</CountBubble>
                </h3>
                {col.capacity && <span className="text-[12px] text-sh-text-3">{col.capacity}</span>}
              </header>

              {/* The refusal lands on the target, not in a toast. */}
              {refused && (
                <p role="alert" className="mx-[2px] flex items-start gap-[6px] rounded-[12px] bg-sh-crit-bg px-[10px] py-[8px] text-[13px] font-medium text-sh-crit-fg">
                  <Icon icon={Ban} size={13} className="mt-[2px] shrink-0" />
                  {refusal.reason}
                </p>
              )}

              <div className="flex flex-col gap-[8px]">
                {col.rows.map((row) => {
                  const key = rowKey(row)
                  const targets = columns.filter((c) => c.key !== col.key)
                  return (
                    <div
                      key={key}
                      draggable={Boolean(canDrop)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', key)
                        e.dataTransfer.effectAllowed = 'move'
                        setDragging(key)
                      }}
                      onDragEnd={() => setDragging(null)}
                      className={cn(canDrop && 'cursor-grab active:cursor-grabbing', dragging === key && 'opacity-50')}
                    >
                      {renderCard(row)}
                      {canDrop && (
                        <label className="mt-[6px] flex items-center justify-end gap-[8px] text-[12px] text-sh-text-3">
                          <span className="sr-only">Move {rowName?.(row) ?? 'this card'} to</span>
                          <select
                            value=""
                            onChange={(e) => {
                              if (e.target.value) move(row, e.target.value)
                            }}
                            className="h-[44px] rounded-full bg-sh-control px-[12px] text-[13px] font-medium text-sh-text-2"
                          >
                            <option value="">Move to…</option>
                            {targets.map((t) => (
                              <option key={t.key} value={t.key}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                  )
                })}
                {col.rows.length === 0 && <p className="px-[8px] py-[16px] text-center text-[13px] text-sh-text-3">Nothing here right now.</p>}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

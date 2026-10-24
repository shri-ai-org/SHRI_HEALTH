import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '../lib/cn'

export interface TabItem {
  id: string
  label: string
  count?: number
  panel: ReactNode
}

export interface TabsProps {
  label: string
  items: TabItem[]
  selectedId: string
  onSelect: (id: string) => void
}

/** WAI-ARIA tabs: arrow keys move and select, Home and End jump; only the selected tab is in the Tab order. */
export function Tabs({ label, items, selectedId, onSelect }: TabsProps) {
  const base = useId()
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  function onKeyDown(e: KeyboardEvent, index: number) {
    const last = items.length - 1
    const next = e.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null
    if (next === null) return
    e.preventDefault()
    const item = items[next]
    if (!item) return
    onSelect(item.id)
    refs.current[next]?.focus()
  }

  const selected = items.find((i) => i.id === selectedId) ?? items[0]
  return (
    <div>
      <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border-soft">
        {items.map((item, index) => {
          const active = item.id === selected?.id
          return (
            <button
              key={item.id}
              ref={(el) => {
                refs.current[index] = el
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${item.id}`}
              aria-selected={active}
              aria-controls={`${base}-panel-${item.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(item.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                '-mb-px flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium whitespace-nowrap',
                active ? 'border-primary-600 text-primary-700' : 'border-transparent text-ink-subtle hover:text-ink',
              )}
            >
              {item.label}
              {item.count !== undefined ? (
                <span className="rounded-full bg-surface-2 px-1.5 text-2xs font-semibold tabular-nums">{item.count}</span>
              ) : null}
            </button>
          )
        })}
      </div>
      {selected ? (
        <div role="tabpanel" id={`${base}-panel-${selected.id}`} aria-labelledby={`${base}-tab-${selected.id}`} className="pt-4">
          {selected.panel}
        </div>
      ) : null}
    </div>
  )
}

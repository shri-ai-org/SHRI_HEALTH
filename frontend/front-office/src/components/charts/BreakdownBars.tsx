import { cn } from '../../utils/cn'
import { TONE_HEX } from '../../utils/toneHex'
import type { IconTone } from '../../utils/toneHex'

export interface BreakdownItem {
  key: string
  label: string
  value: number
  hue: IconTone
  /** Shown beside the count, e.g. an amount. */
  note?: string
}

/**
 * Horizontal bars, longest first — "what happens most" at a glance. Bars use
 * each activity's destination hue, and every row prints its number, so
 * colour is never the only way to read it. A highlighted row stays full
 * strength while the others dim.
 */
export function BreakdownBars({ items, highlight }: { items: BreakdownItem[]; highlight?: string | null }) {
  const max = Math.max(1, ...items.map((item) => item.value))
  const sorted = [...items].sort((a, b) => b.value - a.value)
  return (
    <ul className="flex flex-col gap-3">
      {sorted.map((item) => {
        const dim = Boolean(highlight) && highlight !== item.key
        return (
          <li key={item.key} className={cn('grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_auto] items-center gap-3', dim && 'opacity-45')}>
            <span className="truncate text-sm font-medium text-ink" title={item.label}>
              {item.label}
            </span>
            <span className="h-2.5 overflow-hidden rounded-full bg-surface-3">
              <span
                className="block h-full rounded-full"
                style={{ backgroundColor: TONE_HEX[item.hue], width: `${item.value > 0 ? Math.max((item.value / max) * 100, 3) : 0}%` }}
              />
            </span>
            <span className="text-right text-sm font-semibold tabular-nums text-ink">
              {item.value}
              {item.note ? <span className="ml-1.5 font-normal text-ink-muted">{item.note}</span> : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

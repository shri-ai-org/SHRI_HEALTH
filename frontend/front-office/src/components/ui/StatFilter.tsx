import type { ElementType, ReactNode } from 'react'
import { TONE_ICON } from '../../utils/toneHex'
import type { Tone } from '../../utils/tone'
import { FigureBody } from './Figure'
import { figureClasses, figureRowClass, figureStyle } from '../../utils/figure'

export interface StatFilterItem<K extends string> {
  key: K
  label: string
  value: ReactNode
  context?: ReactNode
  tone: Tone
  icon: ElementType
}

/**
 * A row of figures that ARE the filter for the list below them — the number
 * and the way to see those records are one control, never a tile plus a
 * separate chip doing the same thing.
 */
export function StatFilter<K extends string>({
  items,
  selected,
  onSelect,
  label,
  columns = 'sm:grid-cols-2 lg:grid-cols-4',
}: {
  items: StatFilterItem<K>[]
  selected: K
  onSelect: (key: K) => void
  label: string
  /** The grid's column classes from 640px — four across by default. (Below
   *  640px the figures are a horizontal scroll row.) */
  columns?: string
}) {
  return (
    <div role="group" aria-label={label} className={figureRowClass(columns)}>
      {items.map((item) => {
        const active = item.key === selected
        const hue = TONE_ICON[item.tone]
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(item.key)}
            className={figureClasses({ interactive: true, selected: active })}
            style={figureStyle(hue, active)}
          >
            <FigureBody icon={item.icon} hue={hue} value={item.value} label={item.label} hint={item.context} />
          </button>
        )
      })}
    </div>
  )
}

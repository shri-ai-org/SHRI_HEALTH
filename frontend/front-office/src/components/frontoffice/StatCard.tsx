import type { ElementType, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { IconTone } from '../../utils/toneHex'
import { FigureBody } from '../ui/Figure'
import { figureClasses, figureStyle } from '../../utils/figure'

/**
 * One dashboard figure: a card washed in its hue, a soft icon tile, the
 * count, a label and one line saying what it is made of. The whole card
 * opens the place that holds the figure.
 */
export function StatCard({
  icon,
  hue,
  value,
  label,
  hint,
  to,
  title,
  selected,
  onSelect,
  trend,
}: {
  icon: ElementType
  hue: IconTone
  value: ReactNode
  label: string
  hint?: string
  /** Where the card opens. Leave out for an information-only card (no button, no click). */
  to?: string
  /** Where the card leads — shown as its tooltip. */
  title?: string
  /** Makes the card a choice on the same page (no navigation): called when it is pressed. */
  onSelect?: () => void
  /** With onSelect: this is the chosen card — ringed and lifted. */
  selected?: boolean
  /** A small series drawn as a sparkline (e.g. per hour today). */
  trend?: number[]
}) {
  const body = <FigureBody icon={icon} hue={hue} value={value} label={label} hint={hint} trend={trend} />
  if (onSelect) {
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={Boolean(selected)}
        title={title}
        className={figureClasses({ interactive: true, selected })}
        style={figureStyle(hue, selected)}
      >
        {body}
      </button>
    )
  }
  if (!to) {
    return (
      <div className={figureClasses({ interactive: false })} style={figureStyle(hue)}>
        {body}
      </div>
    )
  }
  return (
    <Link to={to} title={title} className={figureClasses({ interactive: true })} style={figureStyle(hue)}>
      {body}
    </Link>
  )
}

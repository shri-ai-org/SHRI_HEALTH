import { cn } from '../../utils/cn'
import { tintedChip } from '../../utils/chipTone'
import type { DateStripDay } from '../../domain/selectors'
import { addDaysToKey } from '../../domain/selectors'
import { dayStartTimestamp } from '../../domain/time'

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Two weeks of one doctor's days as small calendar cards — the weekday (or
 * Today / Tomorrow), the date, and how many times are free. A day that
 * can't be booked says why (Full, Leave, Off) and is greyed, but can still
 * be shown: the day chart below draws why. Scrolls sideways where the
 * fortnight is wider than the space.
 */
export function DateStrip({
  days,
  selected,
  onSelect,
  today,
}: {
  days: DateStripDay[]
  selected: string | null
  onSelect: (date: string) => void
  today: string
}) {
  const tomorrow = addDaysToKey(today, 1)
  const open = tintedChip('blue')
  return (
    <div className="scrollbar-hide scroll-fade-x -mx-1 flex snap-x gap-1.5 overflow-x-auto overflow-y-hidden px-1 py-1" role="group" aria-label="Day">
      {days.map((day) => {
        const selectable = day.state === 'open'
        const isSelected = day.date === selected
        const date = new Date(dayStartTimestamp(day.date))
        const top = day.date === today ? 'Today' : day.date === tomorrow ? 'Tmrw' : WEEKDAY[date.getDay()]
        const bottom = day.state === 'open' ? `${day.open} open` : day.state === 'full' ? 'Full' : day.state === 'leave' ? 'Leave' : 'Off'
        const spoken = `${day.date === today ? 'Today, ' : day.date === tomorrow ? 'Tomorrow, ' : ''}${WEEKDAY[date.getDay()]} ${date.getDate()} ${MONTH[date.getMonth()]} — ${
          day.state === 'open' ? `${day.open} available ${day.open === 1 ? 'slot' : 'slots'}` : day.state === 'full' ? 'fully booked' : day.state === 'leave' ? 'doctor on leave' : 'not working'
        }`
        return (
          <button
            key={day.date}
            type="button"
            aria-pressed={isSelected}
            aria-label={spoken}
            title={spoken}
            onClick={() => onSelect(day.date)}
            style={!isSelected && selectable ? open.style : undefined}
            className={cn(
              'focus-ring flex w-[4.25rem] shrink-0 snap-start flex-col items-center gap-0.5 rounded-xl border px-1 py-2 transition-all duration-200',
              isSelected
                ? 'border-transparent bg-[image:var(--gradient-primary)] text-on-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_6px_16px_-6px_rgba(37,99,235,0.6)]'
                : selectable
                  ? cn(open.className, 'hover:-translate-y-0.5 hover:shadow-card-md')
                  : 'border-border-soft bg-surface-2 text-ink-subtle opacity-70 hover:opacity-100',
            )}
          >
            <span className="text-2xs font-semibold uppercase tracking-wide opacity-85">{top}</span>
            <span className="text-lg font-bold leading-none tabular-nums">{date.getDate()}</span>
            <span className={cn('text-2xs font-medium', isSelected ? 'opacity-90' : 'opacity-80')}>{bottom}</span>
          </button>
        )
      })}
    </div>
  )
}

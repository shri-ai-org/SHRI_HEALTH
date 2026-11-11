import { DayTimelineAxis, DayTimelineLegend } from '../dayTimeline/DayTimeline'
import { addDaysToKey } from '../../domain/selectors'
import { dayStartTimestamp } from '../../domain/time'
import { cn } from '../../utils/cn'

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Minutes after midnight, for the axis's Now label. */
function minutesOfDay(timestamp: number): number {
  const d = new Date(timestamp)
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * The booking pages' one date row and one time axis for every doctor below,
 * pinned at the top of the doctors' section while their rows scroll under it.
 * The axis lines up with the charts inside the wide doctor cards.
 */
export function SharedDayHeader({
  days,
  day,
  onDay,
  range,
  today,
  now,
}: {
  days: { date: string; open: number }[]
  day: string
  onDay: (date: string) => void
  range: [number, number]
  today: string
  now: number
}) {
  return (
    <div className="sticky -top-3.5 z-20 -mx-3.5 -mt-3.5 flex flex-col gap-1 border-b border-border-soft bg-surface-1 px-3.5 pb-1 pt-3.5 sm:-mx-4 sm:px-4">
      {/* Today and tomorrow (and the chosen day, should it be later), then the key on the same row. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-1">
      <div className="flex gap-1.5" role="group" aria-label="Day">
        {days.filter((d, i) => i < 2 || d.date === day).map((d) => {
          const active = d.date === day
          const dt = new Date(dayStartTimestamp(d.date))
          const label = d.date === today ? 'Today' : d.date === addDaysToKey(today, 1) ? 'Tmrw' : `${WEEKDAY_SHORT[dt.getDay()]} ${dt.getDate()}`
          return (
            <button
              key={d.date}
              type="button"
              aria-pressed={active}
              aria-label={`${label === 'Tmrw' ? 'Tomorrow' : label}, ${d.open} available`}
              onClick={() => onDay(d.date)}
              className={cn(
                'focus-ring tap-reach inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-semibold transition-colors',
                active
                  ? 'border-ink bg-ink text-surface-1'
                  : d.open > 0
                    ? 'border-border-soft bg-surface-1 text-ink hover:border-border-strong'
                    : 'border-transparent bg-surface-2 text-ink-subtle hover:border-border-soft',
              )}
            >
              {label}
              <span
                className={cn(
                  'rounded-full px-1.5 text-2xs font-semibold tabular-nums',
                  active
                    ? 'bg-surface-1/20'
                    : d.open > 0
                      ? 'bg-[color-mix(in_oklab,var(--color-hue-blue)_14%,var(--color-surface-1))] text-[color-mix(in_oklab,var(--color-hue-blue)_var(--tone-ink-amount),var(--tone-ink-mix))]'
                      : '',
                )}
              >
                {d.open > 0 ? d.open : 'Full'}
              </span>
            </button>
          )
        })}
      </div>
      <DayTimelineLegend />
      </div>
      {/* Doctor on the left (18rem + its border), the chart on the right — as inside the cards. */}
      <div className="@container">
        <div className="px-[calc(0.875rem+1px)] sm:px-[calc(1rem+1px)] @3xl:pl-[calc(18rem+1px+1rem)]">
          <DayTimelineAxis range={range} now={day === today ? minutesOfDay(now) : null} />
        </div>
      </div>
    </div>
  )
}

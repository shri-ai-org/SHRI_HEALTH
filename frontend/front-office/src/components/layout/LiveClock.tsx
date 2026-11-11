import { useNow } from '../../hooks/useNow'
import { formatTimestampTime } from '../../domain/time'
import { cn } from '../../utils/cn'

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The live time, in blue, on every screen: in the app bar and at the head of
 * every flow. A pulsing dot marks it live; it turns the minute with the
 * charts' Now pins (useNow ticks on the wall clock).
 */
export function LiveClock({ className }: { className?: string }) {
  const now = useNow(1000)
  const d = new Date(now)
  const time = formatTimestampTime(now)
  const day = `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`
  return (
    <time
      dateTime={d.toISOString()}
      aria-label={`${time}, ${day}`}
      className={cn(
        'inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-primary-200 bg-primary-50 px-3 text-sm font-semibold tabular-nums text-primary-text dark:border-primary-500/35',
        className,
      )}
    >
      <span aria-hidden="true" className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-primary-600 opacity-60 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary-600" />
      </span>
      {time}
      <span aria-hidden="true" className="hidden font-medium text-primary-text/75 sm:inline">
        {day}
      </span>
    </time>
  )
}

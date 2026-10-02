/**
 * The day as twelve hour cells, 07–19 — busy and free at a glance (`hourGrid.ts`
 * says what counts as each). A cell fills from the bottom with the busy minutes
 * of its hour, in the accent; what is left shows the free tint; blocked time is
 * hatched from the top, a fully blocked hour with ⊘. A dot is a patient booked in
 * that hour. Today's past hours fade and the now-line marks the minute. Above:
 * busy, free and booked totals, and the next free time — the swatches are the
 * legend, so the grid carries almost no words. Colour is never the only signal:
 * filled vs hollow, the hatch and ⊘, and the dots.
 */

import { format } from 'date-fns'
import { ArrowRight, Ban } from 'lucide-react'

import { NOW } from '../lib/clock'
import { cn } from '../lib/cn'
import { Icon } from '../ui/primitives'

import { GRID_HOURS, GRID_START, clock, duration, durationSpoken, hourGrid, type HourCell } from './hourGrid'
import type { CalendarDay } from './useMyDay'

const GAP = 3
const HATCH = 'bg-sh-crit-bg bg-[repeating-linear-gradient(135deg,var(--crit)_0_2px,transparent_2px_7px)]'
/** Where a point `f` cells along the grid sits, allowing for the gaps between cells. */
const along = (f: number) => `calc((100% - ${GAP * (GRID_HOURS - 1)}px) * ${f / GRID_HOURS} + ${Math.floor(f) * GAP}px)`

function cellLine(c: HourCell) {
  const when = `${clock(c.hour * 60)}–${clock((c.hour + 1) * 60)}`
  const state = c.blockedMin === 60 ? 'blocked' : c.busyMin === 60 ? 'busy' : c.freeMin === 60 ? 'free' : [c.busyMin && `${c.busyMin} min busy`, c.blockedMin && `${c.blockedMin} min blocked`, `${c.freeMin} min free`].filter(Boolean).join(', ')
  const who = c.bookings ? ` · ${c.bookings} patient${c.bookings === 1 ? '' : 's'}` : ''
  return `${when} · ${state}${c.titles.length ? ` · ${c.titles.join(', ')}` : ''}${who}`
}

export function HourGrid({ day }: { day: CalendarDay }) {
  const g = hourGrid(day)
  const nowF = (NOW.getHours() * 60 + NOW.getMinutes() - GRID_START * 60) / 60
  const showNow = day.isToday && nowF >= 0 && nowF <= GRID_HOURS
  const booked = day.bookings.length
  const summary = [
    `${format(day.date, 'EEEE d MMMM')}: busy ${durationSpoken(g.busyMin)}, free ${durationSpoken(g.freeMin)}`,
    g.blockedMin ? `blocked ${durationSpoken(g.blockedMin)}` : '',
    booked ? `${booked} patient${booked === 1 ? '' : 's'} booked` : '',
    g.nextFree !== null ? `next free ${clock(g.nextFree)}` : '',
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <div className="mt-[12px]">
      <div className="flex flex-wrap items-center gap-x-[14px] gap-y-[4px] text-[12px]/[16px] font-medium tabular-nums text-sh-text-2" aria-hidden="true">
        <span className="inline-flex items-center gap-[5px]" title="Busy">
          <span className="size-[11px] rounded-[3px] border-[1.5px] border-(--busy-edge) bg-sh-accent" />
          {duration(g.busyMin)}
        </span>
        <span className="inline-flex items-center gap-[5px]" title="Free">
          <span className="size-[11px] rounded-[3px] border-[1.5px] border-(--free-edge) bg-sh-norm-bg" />
          {duration(g.freeMin)}
        </span>
        {g.blockedMin > 0 && (
          <span className="inline-flex items-center gap-[4px] text-sh-crit-fg" title="Blocked">
            <Icon icon={Ban} size={12} />
            {duration(g.blockedMin)}
          </span>
        )}
        {booked > 0 && (
          <span className="inline-flex items-center gap-[5px]" title="Patients booked">
            <span className="size-[7px] rounded-full bg-sh-text" />
            {booked}
          </span>
        )}
        {g.nextFree !== null && (
          <span className="ml-auto inline-flex items-center gap-[3px] text-(--free-edge)" title="Next free">
            <Icon icon={ArrowRight} size={12} />
            {clock(g.nextFree)}
          </span>
        )}
      </div>

      <div className="relative mt-[8px]">
        <div role="img" aria-label={summary} className="grid grid-cols-12" style={{ gap: GAP }}>
          {g.cells.map((c) => (
            <span
              key={c.hour}
              title={cellLine(c)}
              className={cn(
                'relative h-[40px] overflow-hidden rounded-[7px] border-[1.5px] bg-sh-norm-bg',
                c.busyMin === 60 ? 'border-(--busy-edge)' : c.blockedMin === 60 ? 'border-sh-crit' : 'border-(--free-edge)',
                c.past && 'opacity-45',
              )}
            >
              {c.blockedMin > 0 && <span className={cn('absolute inset-x-0 top-0', HATCH)} style={{ height: `${(c.blockedMin / 60) * 100}%` }} />}
              {c.busyMin > 0 && <span className={cn('absolute inset-x-0 bottom-0 bg-sh-accent', c.busyMin < 60 && 'border-t-[2px] border-(--busy-edge)')} style={{ height: `${(c.busyMin / 60) * 100}%` }} />}
              {c.blockedMin === 60 && <Icon icon={Ban} size={13} className="absolute inset-0 m-auto text-sh-crit-fg" />}
              {c.bookings > 0 && (
                <span className="absolute inset-x-0 bottom-[5px] flex items-center justify-center gap-[2px]">
                  {Array.from({ length: Math.min(3, c.bookings) }, (_, i) => (
                    <span key={i} className="size-[5px] rounded-full bg-sh-accent-ink" />
                  ))}
                  {c.bookings > 3 && <span className="text-[9px]/[9px] font-bold text-sh-accent-ink">+</span>}
                </span>
              )}
            </span>
          ))}
        </div>
        {showNow && <span className="pointer-events-none absolute -inset-y-[3px] w-[2px] -translate-x-1/2 rounded-full bg-sh-crit" style={{ left: along(nowF) }} aria-hidden="true" />}
      </div>

      <div className="relative mt-[4px] h-[12px] text-[10px]/[12px] tabular-nums text-sh-muted" aria-hidden="true">
        {Array.from({ length: GRID_HOURS / 2 + 1 }, (_, i) => i * 2).map((k) => (
          <span key={k} className={cn('absolute', k === 0 ? '' : k === GRID_HOURS ? '-translate-x-full' : '-translate-x-1/2')} style={{ left: k === 0 ? 0 : k === GRID_HOURS ? '100%' : along(k) }}>
            {String(GRID_START + k).padStart(2, '0')}
          </span>
        ))}
      </div>

      <ul className="sr-only" aria-label={`Hour by hour, ${format(day.date, 'EEEE d MMMM')}`}>
        {g.cells.map((c) => (
          <li key={c.hour}>{cellLine(c)}</li>
        ))}
      </ul>
    </div>
  )
}

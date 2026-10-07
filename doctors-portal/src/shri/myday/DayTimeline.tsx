/**
 * The day as one row of bars across the hours, 7 AM to 7 PM — the Today
 * panel's chart (`TodayPanel`), after the scheduling tools' day view:
 *
 *   · the hours along the top, every half hour, 12-hour with AM and PM;
 *   · each activity a bar in its own colour, named on it with its time
 *     ("OPD · 8:00 – 9:00 AM"); a patient booked outside a session, the same;
 *   · free time a dashed green bar, "Free" with its time — from now on, tapping
 *     it schedules a patient at the minute tapped (the hover card's minute);
 *     free time already gone is drawn, never offered;
 *   · off hours hatched grey; blocked time hatched red with ⊘;
 *   · the Now line, red, labelled with the time.
 *
 * Hovering anywhere on the row says what is at that minute, how long is left
 * of it, and what comes next — inside the OPD on now, the patient the queue
 * calls next. A bar says as much as fits (container queries):
 * its icon, name and time; a shorter time ("8–9 AM") where the full one does
 * not fit; its icon alone on a half-hour. One narrower than a 44px target is
 * not a button. Below about 1040px the row scrolls sideways, opened
 * at Now. The model is `dayModel.ts`.
 */

import { Ban } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { canonical } from '../app/paths'
import { range12, span12, time12 } from '../lib/clock'
import { cn } from '../lib/cn'
import { iconFor } from '../ui/icons'
import { Icon } from '../ui/primitives'

import { END, GRID_HOURS, START, duration, isActivity, type ActivityKind, type DayModel, type TimelineItem } from './dayModel'

const SPAN_MIN = GRID_HOURS * 60
const pct = (min: number) => `${(min / SPAN_MIN) * 100}%`
const at = (min: number) => pct(min - START)
/** The row's width before it scrolls, less its side padding. */
const MIN_W = 1040 - 52

/** An activity's colour and ink, with a lit top edge — an edge, not a wash, so the ink keeps its contrast. */
export const actStyle = (k: ActivityKind): CSSProperties => ({
  background: `var(--act-${k})`,
  color: `var(--act-${k}-ink)`,
  boxShadow: k === 'brief' ? 'inset 0 0 0 1.5px var(--act-brief-edge)' : 'inset 0 1px 0 rgb(255 255 255 / 0.28)',
})
export const HATCH_OFF = 'bg-[repeating-linear-gradient(135deg,var(--off-hatch)_0_2px,var(--off-fill)_2px_8px)]'
export const HATCH_BLOCKED = 'bg-[repeating-linear-gradient(135deg,var(--crit-bg)_0_6px,transparent_6px_10px)]'
export const FREE = 'border-[1.5px] border-dashed border-(--avail-edge) bg-(--avail-fill) text-(--avail-ink)'

export function DayTimeline({
  model,
  nextPatient,
  onSchedule,
}: {
  model: DayModel
  /** The OPD queue's next patient, today — who its Call button calls. */
  nextPatient?: { name: string; token: string }
  /** Schedule a patient at a minute of free time; `until` is where that free time ends. */
  onSchedule: (at: number, until: number) => void
}) {
  const navigate = useNavigate()
  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(MIN_W)
  const [hover, setHover] = useState<{ min: number; x: number; top: number; left: number } | null>(null)
  const pxPerMin = w / SPAN_MIN

  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Where the row scrolls, open it at Now (or the day's first activity), a third of the way in.
  const focusMin = model.now ?? model.items.find((i) => isActivity(i.kind))?.start ?? 8 * 60
  useEffect(() => {
    const s = scrollRef.current
    if (!s || s.scrollWidth <= s.clientWidth) return
    s.scrollLeft = Math.max(0, 26 + (focusMin - START) * (s.scrollWidth - 52) / SPAN_MIN - s.clientWidth / 3)
  }, [focusMin])

  const minuteAt = (clientX: number) => {
    const r = rowRef.current!.getBoundingClientRect()
    const x = Math.min(Math.max(clientX - r.left, 0), r.width)
    return Math.min(END - 5, START + Math.round(((x / r.width) * SPAN_MIN) / 5) * 5)
  }
  /** The minute tapped — the same one the hover card names — kept inside the free time and at least 10 minutes before it ends; from the keyboard, its start. */
  function schedule(item: TimelineItem, clientX?: number) {
    const first = Math.ceil(item.start / 5) * 5
    const at = clientX !== undefined && rowRef.current ? minuteAt(clientX) : first
    onSchedule(Math.min(Math.max(at, first), item.end - Math.min(10, item.end - first)), item.end)
  }

  function onMove(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType !== 'mouse' || !rowRef.current || !wrapRef.current) return
    const r = rowRef.current.getBoundingClientRect()
    const wrap = wrapRef.current.getBoundingClientRect()
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width)
    setHover({ min: minuteAt(e.clientX), x, top: r.bottom - wrap.top + 12, left: Math.min(Math.max(e.clientX - wrap.left - 140, 0), wrap.width - 280) })
  }

  const under = (min: number) =>
    model.items.find((i) => isActivity(i.kind) && i.start <= min && min < i.drawEnd) ??
    model.items.find((i) => i.kind === 'blocked' && i.start <= min && min < i.end) ??
    model.items.find((i) => i.start <= min && min < i.end)
  const nextAfter = (min: number) => model.items.find((i) => isActivity(i.kind) && i.start > min)

  const marks = Array.from({ length: GRID_HOURS * 2 + 1 }, (_, i) => START + i * 30)
  const nowSide = model.now !== null && model.now > END - 90 ? 'left' : 'right'

  return (
    <div ref={wrapRef} className="relative">
      <div ref={scrollRef} className="sh-scrollbar -mx-[6px] overflow-x-auto px-[6px] pb-[4px]">
        <div className="relative min-w-[1040px] px-[26px]">
          <div className="relative">
            {/* Now, named above the hours. */}
            <div className="relative h-[36px]" aria-hidden="true">
              {model.now !== null && (
                <span
                  className={cn('absolute bottom-[4px] flex flex-col text-[13px]/[15px] font-semibold tabular-nums text-(--now-ink)', nowSide === 'right' ? 'pl-[10px]' : '-translate-x-full items-end pr-[10px]')}
                  style={{ left: at(model.now) }}
                >
                  <span>Now</span>
                  <span>{time12(model.now)}</span>
                </span>
              )}
            </div>

            {/* The hours, every half hour. */}
            <div className="relative h-[32px] text-[12px]/[15px] tabular-nums" aria-hidden="true">
              {marks.map((m) => {
                const t = time12(m)
                return (
                  <span key={m} className={cn('absolute top-0 flex -translate-x-1/2 flex-col items-center whitespace-nowrap', m % 60 === 0 ? 'font-semibold text-sh-text' : 'text-sh-text-3')} style={{ left: at(m) }}>
                    <span>{t.slice(0, -3)}</span>
                    <span className="text-[11px]/[13px]">{t.slice(-2)}</span>
                  </span>
                )
              })}
            </div>
            <Ticks marks={marks} />

            {/* The row. */}
            <div ref={rowRef} onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="relative h-[64px]">
              {model.items.map((item) => (
                <Bar key={item.id} item={item} px={(item.drawEnd - item.start) * pxPerMin - 4} onOpen={(to) => navigate(canonical(to))} onSchedule={schedule} />
              ))}
              {hover && (
                <span aria-hidden="true" className="pointer-events-none absolute -bottom-[10px] -top-[10px] z-[3] flex w-[2px] -translate-x-1/2 flex-col items-center justify-between" style={{ left: hover.x }}>
                  <span className="size-[8px] rounded-full bg-sh-text-2" />
                  <span className="w-[2px] flex-1 bg-sh-text-2/70" />
                  <span className="size-[8px] rounded-full bg-sh-text-2" />
                </span>
              )}
            </div>
            <Ticks marks={marks} />

            {/* The Now line, from its label through the row. */}
            {model.now !== null && (
              <span aria-hidden="true" className="pointer-events-none absolute bottom-0 top-[30px] z-[2] flex -translate-x-1/2 flex-col items-center" style={{ left: at(model.now) }}>
                <span className="size-[12px] shrink-0 rounded-full bg-(--now-line) shadow-[0_0_0_3px_var(--card)]" />
                <span className="w-0 flex-1 border-l-2 border-dashed border-(--now-line)" />
                <span className="size-[7px] shrink-0 rounded-full bg-(--now-line)" />
              </span>
            )}
          </div>
        </div>
      </div>

      {hover && (
        <HoverCard
          min={hover.min}
          item={under(hover.min)}
          next={nextAfter(hover.min)}
          nextPatient={nextPatient && model.now !== null && under(hover.min)?.kind === 'opd' && under(hover.min)!.start <= model.now && model.now < under(hover.min)!.end ? nextPatient : undefined}
          style={{ top: hover.top, left: hover.left }}
        />
      )}
    </div>
  )
}

function Ticks({ marks }: { marks: number[] }) {
  return (
    <div className="relative h-[8px]" aria-hidden="true">
      {marks.map((m) => (
        <span key={m} className="absolute inset-y-0 w-px bg-sh-line-strong" style={{ left: at(m) }} />
      ))}
    </div>
  )
}

/** One bar: an activity, free time, off hours or blocked time — a button where it does something and is wide enough to tap. */
function Bar({ item, px, onOpen, onSchedule }: { item: TimelineItem; px: number; onOpen: (to: string) => void; onSchedule: (item: TimelineItem, clientX?: number) => void }) {
  const place: CSSProperties = { left: `calc(${at(item.start)} + 2px)`, width: `calc(${pct(item.drawEnd - item.start)} - 4px)` }
  const when = range12(item.start, item.end)
  const tappable = px >= 44
  const base = '@container absolute inset-y-0 flex min-w-0 items-center overflow-hidden rounded-[12px] px-[6px] text-left'
  /** The time, full where it fits, short where it does not — for free time, how long. */
  const time = (
    <>
      <span className="max-w-full truncate text-[11px]/[14px] tabular-nums @min-[104px]:hidden">{item.kind === 'free' ? duration(item.end - item.start) : span12(item.start, item.end)}</span>
      <span className="hidden max-w-full truncate text-[11px]/[14px] tabular-nums @min-[104px]:block">{when}</span>
    </>
  )

  if (item.kind === 'off') return <span aria-hidden="true" title={`Off hours · ${when}`} className={cn(base, HATCH_OFF)} style={place} />

  if (item.kind === 'blocked') {
    return (
      <span title={`${item.title} · ${when}`} className={cn(base, HATCH_BLOCKED, 'border-[1.5px] border-dashed border-sh-crit text-sh-crit-fg')} style={place}>
        <span className="flex w-full min-w-0 items-center justify-center gap-[6px] @min-[70px]:justify-start">
          <Icon icon={Ban} size={15} className="hidden shrink-0 @min-[16px]:block" />
          <span className="hidden min-w-0 flex-col @min-[70px]:flex">
            <span className="truncate text-[13px]/[16px] font-semibold">Blocked</span>
            <span className="truncate text-[11px]/[14px]">{item.title.replace(/^Blocked · /, '')}</span>
          </span>
        </span>
      </span>
    )
  }

  if (item.kind === 'free') {
    if (item.past) return <span aria-hidden="true" title={`Free · ${when} · gone`} className={cn(base, 'border-[1.5px] border-dashed border-sh-line-strong')} style={place} />
    const words = (
      <span className="hidden min-w-0 max-w-full flex-col items-center @min-[30px]:flex">
        <span className="max-w-full truncate text-[13px]/[16px] font-semibold">Free</span>
        {time}
      </span>
    )
    return tappable ? (
      <button
        type="button"
        onClick={(e) => onSchedule(item, e.detail > 0 ? e.clientX : undefined)}
        aria-label={`Free ${when} — schedule an appointment`}
        title={`Free ${when} — tap a time to schedule`}
        className={cn(base, FREE, 'cursor-pointer justify-center transition-[filter] duration-150 hover:brightness-[0.97]')}
        style={place}
      >
        {words}
      </button>
    ) : (
      <span title={`Free ${when}`} className={cn(base, FREE, 'justify-center')} style={place}>
        {words}
      </span>
    )
  }

  // An activity, or a patient booked outside a session.
  const k = item.kind as ActivityKind
  const e = item.entry!
  const inner = (
    <span className="flex w-full min-w-0 items-center justify-center gap-[6px] @min-[58px]:justify-start">
      <Icon icon={iconFor(e.icon)} size={18} className="hidden shrink-0 @min-[18px]:block" />
      <span className="hidden min-w-0 flex-col @min-[58px]:flex">
        <span className="truncate text-[13px]/[16px] font-semibold">{item.title}</span>
        {time}
      </span>
    </span>
  )
  const cls = cn(base, px < 20 && 'px-0')
  const own = actStyle(k)
  const style = { ...place, ...own, boxShadow: `${own.boxShadow}, 0 6px 14px -10px rgb(0 0 0 / 0.55)` }
  return tappable && e.to ? (
    <button type="button" onClick={() => onOpen(e.to!)} aria-label={`${item.title}, ${when}${e.detail ? `, ${e.detail}` : ''}`} title={`${item.title} · ${when}`} className={cn(cls, 'transition-[filter] duration-150 hover:brightness-105')} style={style}>
      {inner}
    </button>
  ) : (
    <span title={`${item.title} · ${when}`} className={cls} style={style}>
      {inner}
    </span>
  )
}

/** What is at the minute under the pointer, how long is left of it, and what comes next — in the OPD on now, the queue's next patient. */
function HoverCard({ min, item, next, nextPatient, style }: { min: number; item?: TimelineItem; next?: TimelineItem; nextPatient?: { name: string; token: string }; style: CSSProperties }) {
  if (!item) return null
  const left = item.end - min
  const what =
    item.kind === 'free'
      ? item.past
        ? { dot: 'var(--line-strong)', name: 'Free', aside: 'gone' }
        : { dot: 'var(--avail-edge)', name: 'Available', aside: `${left} min free` }
      : item.kind === 'off'
        ? { dot: 'var(--off-hatch)', name: 'Off hours', aside: '' }
        : item.kind === 'blocked'
          ? { dot: 'var(--crit)', name: item.title, aside: range12(item.start, item.end) }
          : { dot: `var(--act-${item.kind})`, name: item.title, aside: range12(item.start, item.end) }
  return (
    <div aria-hidden="true" className="sh-frosted pointer-events-none absolute z-30 w-[280px] rounded-[16px] p-[14px] text-[13px] shadow-sh-pop" style={style}>
      <p className="text-[15px] font-semibold tabular-nums text-sh-text">{time12(min)}</p>
      <p className="mt-[8px] flex items-center gap-[8px]">
        <span className="size-[10px] shrink-0 rounded-full" style={{ background: what.dot }} />
        <span className={cn('min-w-0 flex-1 truncate font-medium', item.kind === 'free' && !item.past ? 'text-sh-norm-fg' : 'text-sh-text')}>{what.name}</span>
        <span className="shrink-0 tabular-nums text-sh-text-2">{what.aside}</span>
      </p>
      <p className="mt-[10px] flex items-center gap-[8px] border-t border-sh-line pt-[10px] text-sh-text-2">
        {nextPatient ? (
          <>
            <span className="min-w-0 flex-1">
              Next patient: <span className="font-medium text-sh-text">{nextPatient.name}</span>
            </span>
            <span className="shrink-0 tabular-nums">{nextPatient.token}</span>
          </>
        ) : next ? (
          <>
            <span className="min-w-0 flex-1 truncate">
              Next: <span className="font-medium text-sh-text">{next.title}</span>
            </span>
            <span className="shrink-0 tabular-nums">{time12(next.start)}</span>
          </>
        ) : (
          <span>Nothing after this</span>
        )}
      </p>
    </div>
  )
}

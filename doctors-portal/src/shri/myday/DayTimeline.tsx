/**
 * The day as one row of bars across the hours, 7 AM to 7 PM — wider where
 * something falls outside them (`DayModel.range`) — the Today panel's chart
 * (`TodayPanel`), after the scheduling tools' day view:
 *
 *   · the hours along the top, every half hour, 12-hour with AM and PM;
 *   · each activity a bar in its own colour, named on it with its time
 *     ("OPD · 8:00 – 9:00 AM"); a patient booked outside a session, the same;
 *   · free time a dashed green bar with a +, no words — from now on, tapping it
 *     schedules a patient at the minute tapped (the hover card's minute); free
 *     time already gone is drawn, never offered; extra hours the doctor opened
 *     carry a clock with a + instead;
 *   · off hours (lunch among them) hatched grey — from now on, tapping them asks
 *     whether to open extra hours there or to schedule there anyway; blocked
 *     time hatched red with ⊘;
 *   · the Now line, red, labelled with the time.
 *
 * One size on every screen, phone or desktop: PX_PER_MIN, and every stretch of
 * five minutes or more at least MIN_BAR wide, so a 15-minute booking or gap is a
 * bar the size of a half hour. Where the screen is narrower the row scrolls
 * sideways, opened at Now; where it is wider the longer stretches stretch to
 * fill it. The hours, the Now line, the hover card and a tap all read the same
 * scale (`data-scale`, minute → fraction of the row).
 *
 * Hovering anywhere on the row says what is at that minute, how long is left
 * of it, and what comes next — inside the OPD on now, the patient the queue
 * calls next. A bar says as much as fits (container queries): its icon, name
 * and time; a shorter time ("8–9 AM") where the full one does not fit; its
 * icon alone on a half-hour. EVERY bar does something, however narrow — an
 * activity opens its screen, free time schedules, off hours offer extra hours,
 * blocked time offers to unblock — except free time and off hours already gone.
 * A bar is as wide as its time, or MIN_BAR, so the layout audit does not hold it
 * to 44px (`data-timeline-bar`); each activity is also a full-size card under the
 * row. The model is `dayModel.ts`.
 */

import { Ban, ClockPlus, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { canonical } from '../app/paths'
import { range12, span12, time12 } from '../lib/clock'
import { cn } from '../lib/cn'
import { iconFor } from '../ui/icons'
import { Icon } from '../ui/primitives'

import { isActivity, type ActivityKind, type DayModel, type Span, type TimelineItem } from './dayModel'
import { FREE, HATCH_BLOCKED, HATCH_OFF, actStyle } from './timelineStyle'

/** The row's scale on every screen: twelve hours are about 1,330px, before the short stretches widen. */
const PX_PER_MIN = 1.85
/** The narrowest a stretch of five minutes or more is drawn: a 15-minute booking or gap as wide as a half hour. */
const MIN_BAR = 72

/** The hours drawn, as minutes (`mins`) and where each falls on the row, as a fraction of its width (`fracs`) — straight lines between. */
type Scale = { mins: number[]; fracs: number[] }

/** Every bar edge cuts the row; each piece of five minutes or more gets MIN_BAR at least, the rest share what is left by their minutes. */
function scaleFor(model: DayModel, width: number): Scale {
  const [r0, r1] = model.range
  const mins = [...new Set([r0, r1, ...model.items.flatMap((i) => [i.start, i.drawEnd])])].filter((m) => m >= r0 && m <= r1).sort((a, b) => a - b)
  const len = mins.slice(1).map((b, i) => b - mins[i])
  const least = len.map((m) => (m >= 5 ? MIN_BAR : 0))
  const held = new Set<number>()
  let k = width / (r1 - r0)
  for (;;) {
    const heldW = [...held].reduce((n, i) => n + least[i], 0)
    const rest = len.reduce((n, m, i) => (held.has(i) ? n : n + m), 0)
    k = rest ? Math.max(0, width - heldW) / rest : 0
    const more = len.flatMap((m, i) => (!held.has(i) && m * k < least[i] ? [i] : []))
    if (!more.length) break
    for (const i of more) held.add(i)
  }
  const fracs = [0]
  len.forEach((m, i) => fracs.push(fracs[i] + (held.has(i) ? least[i] : m * k) / width))
  return { mins, fracs }
}

/** The row's own width, the same on every screen: PX_PER_MIN, and MIN_BAR for each short stretch. */
function widthFor(model: DayModel): number {
  const [r0, r1] = model.range
  const mins = [...new Set([r0, r1, ...model.items.flatMap((i) => [i.start, i.drawEnd])])].filter((m) => m >= r0 && m <= r1).sort((a, b) => a - b)
  return mins.slice(1).reduce((n, b, i) => n + Math.max(b - mins[i] >= 5 ? MIN_BAR : 0, (b - mins[i]) * PX_PER_MIN), 0)
}

/** The piece of the row a value falls in: the last piece whose start is at or before it. */
function pieceOf(edges: number[], v: number): number {
  let i = 0
  while (i < edges.length - 2 && edges[i + 1] <= v) i += 1
  return i
}

/** Where a minute falls on the row, as a fraction of its width. */
function fracOf(s: Scale, min: number): number {
  const i = pieceOf(s.mins, min)
  const [a, b] = [s.mins[i], s.mins[i + 1]]
  return s.fracs[i] + ((Math.min(Math.max(min, a), b) - a) / (b - a)) * (s.fracs[i + 1] - s.fracs[i])
}

/** The minute at a fraction of the row's width. */
function minOf(s: Scale, f: number): number {
  const i = pieceOf(s.fracs, f)
  const [a, b] = [s.fracs[i], s.fracs[i + 1]]
  return s.mins[i] + (b > a ? ((Math.min(Math.max(f, a), b) - a) / (b - a)) * (s.mins[i + 1] - s.mins[i]) : 0)
}

const at = (s: Scale, min: number) => `${fracOf(s, min) * 100}%`
const between = (s: Scale, a: number, b: number) => `${(fracOf(s, b) - fracOf(s, a)) * 100}%`

export function DayTimeline({
  model,
  nextPatient,
  onSchedule,
  onOffHours,
  onBlocked,
}: {
  model: DayModel
  /** The OPD queue's next patient, today — who its Call button calls. */
  nextPatient?: { name: string; token: string }
  /** Schedule a patient at a minute of free time; `until` is where that free time ends. */
  onSchedule: (at: number, until: number) => void
  /** Off hours tapped at a minute: open extra hours there, or schedule there anyway. */
  onOffHours: (at: number, off: Span) => void
  /** Blocked time tapped: offer to unblock it. */
  onBlocked: (blockId: string) => void
}) {
  const navigate = useNavigate()
  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const minW = widthFor(model)
  const [w, setW] = useState(minW)
  const scale = scaleFor(model, Math.max(w, minW))
  const [hover, setHover] = useState<{ min: number; x: number; top: number; left: number } | null>(null)

  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Where the row scrolls, open it at Now (or the day's first activity), a third of the way in.
  const focusMin = model.now ?? model.items.find((i) => isActivity(i.kind))?.start ?? 8 * 60
  const focus = fracOf(scale, focusMin)
  useEffect(() => {
    const s = scrollRef.current
    if (!s || s.scrollWidth <= s.clientWidth) return
    s.scrollLeft = Math.max(0, 26 + focus * (s.scrollWidth - 52) - s.clientWidth / 3)
  }, [focus])

  const minuteAt = (clientX: number) => {
    const r = rowRef.current!.getBoundingClientRect()
    const x = Math.min(Math.max(clientX - r.left, 0), r.width)
    return Math.min(model.range[1] - 5, Math.round(minOf(scale, x / r.width) / 5) * 5)
  }
  /** The minute tapped — the same one the hover card names — kept inside the bar and at least 10 minutes before it ends; from the keyboard, its start. */
  const tapped = (item: TimelineItem, clientX?: number) => {
    const first = Math.ceil(item.start / 5) * 5
    const at = clientX !== undefined && rowRef.current ? minuteAt(clientX) : first
    return Math.min(Math.max(at, first), item.end - Math.min(10, item.end - first))
  }
  const tap = (item: TimelineItem, clientX?: number) => {
    if (item.kind === 'blocked') return item.entry?.block && onBlocked(item.entry.block.id)
    if (item.kind === 'off') return onOffHours(tapped(item, clientX), [item.start, item.end])
    onSchedule(tapped(item, clientX), item.end)
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

  const marks = Array.from({ length: (model.range[1] - model.range[0]) / 30 + 1 }, (_, i) => model.range[0] + i * 30)
  // A half hour is named only where there is room between its neighbours; the hours always are.
  const roomy = (m: number) =>
    m % 60 === 0 || [m - 30, m + 30].filter((n) => n >= model.range[0] && n <= model.range[1]).every((n) => Math.abs(fracOf(scale, n) - fracOf(scale, m)) * w >= 40)
  const nowSide = model.now !== null && model.now > model.range[1] - 90 ? 'left' : 'right'

  return (
    <div ref={wrapRef} className="relative">
      <div ref={scrollRef} className="sh-scrollbar -mx-[6px] overflow-x-auto px-[6px] pb-[4px]">
        <div className="relative px-[26px]" style={{ minWidth: minW + 52 }}>
          <div className="relative">
            {/* Now, named above the hours. */}
            <div className="relative h-[36px]" aria-hidden="true">
              {model.now !== null && (
                <span
                  className={cn('absolute bottom-[4px] flex flex-col text-[13px]/[15px] font-semibold tabular-nums text-(--now-ink)', nowSide === 'right' ? 'pl-[10px]' : '-translate-x-full items-end pr-[10px]')}
                  style={{ left: at(scale, model.now) }}
                >
                  <span>Now</span>
                  <span>{time12(model.now)}</span>
                </span>
              )}
            </div>

            {/* The hours, every half hour. */}
            <div className="relative h-[32px] text-[12px]/[15px] tabular-nums" aria-hidden="true">
              {marks.filter(roomy).map((m) => {
                const t = time12(m)
                return (
                  <span key={m} className={cn('absolute top-0 flex -translate-x-1/2 flex-col items-center whitespace-nowrap', m % 60 === 0 ? 'font-semibold text-sh-text' : 'text-sh-text-3')} style={{ left: at(scale, m) }}>
                    <span>{t.slice(0, -3)}</span>
                    <span className="text-[11px]/[13px]">{t.slice(-2)}</span>
                  </span>
                )
              })}
            </div>
            <Ticks marks={marks} scale={scale} />

            {/* The row. */}
            <div
              ref={rowRef}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
              className="relative h-[64px]"
              data-scale={JSON.stringify(scale.mins.map((m, i) => [m, Number(scale.fracs[i].toFixed(5))]))}
            >
              {model.items.map((item) => (
                <Bar key={item.id} item={item} scale={scale} px={(fracOf(scale, item.drawEnd) - fracOf(scale, item.start)) * w - 4} onOpen={(to) => navigate(canonical(to))} onTap={tap} />
              ))}
              {hover && (
                <span aria-hidden="true" className="pointer-events-none absolute -bottom-[10px] -top-[10px] z-[3] flex w-[2px] -translate-x-1/2 flex-col items-center justify-between" style={{ left: hover.x }}>
                  <span className="size-[8px] rounded-full bg-sh-text-2" />
                  <span className="w-[2px] flex-1 bg-sh-text-2/70" />
                  <span className="size-[8px] rounded-full bg-sh-text-2" />
                </span>
              )}
            </div>
            <Ticks marks={marks} scale={scale} />

            {/* The Now line, from its label through the row. */}
            {model.now !== null && (
              <span aria-hidden="true" className="pointer-events-none absolute bottom-0 top-[30px] z-[2] flex -translate-x-1/2 flex-col items-center" style={{ left: at(scale, model.now) }}>
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

function Ticks({ marks, scale }: { marks: number[]; scale: Scale }) {
  return (
    <div className="relative h-[8px]" aria-hidden="true">
      {marks.map((m) => (
        <span key={m} className="absolute inset-y-0 w-px bg-sh-line-strong" style={{ left: at(scale, m) }} />
      ))}
    </div>
  )
}

/** One bar: an activity, free time, off hours or blocked time — a button where it does something and is wide enough to tap. */
function Bar({ item, scale, px, onOpen, onTap }: { item: TimelineItem; scale: Scale; px: number; onOpen: (to: string) => void; onTap: (item: TimelineItem, clientX?: number) => void }) {
  const place: CSSProperties = { left: `calc(${at(scale, item.start)} + 2px)`, width: `calc(${between(scale, item.start, item.drawEnd)} - 4px)` }
  const when = range12(item.start, item.end)
  /** Anything drawn is tapped — a sliver too thin to see is not drawn as a control. */
  const tappable = px >= 2
  const base = '@container absolute inset-y-0 flex min-w-0 items-center overflow-hidden rounded-[12px] px-[6px] text-left'
  /** The time, full where it fits, short where it does not. */
  const time = (
    <>
      <span className="max-w-full truncate text-[11px]/[14px] tabular-nums @min-[104px]:hidden">{span12(item.start, item.end)}</span>
      <span className="hidden max-w-full truncate text-[11px]/[14px] tabular-nums @min-[104px]:block">{when}</span>
    </>
  )

  if (item.kind === 'off') {
    if (item.past || !tappable) return <span aria-hidden="true" title={`${item.title} · ${when}`} className={cn(base, HATCH_OFF)} style={place} />
    return (
      <button
        type="button"
        data-timeline-bar=""
        onClick={(e) => onTap(item, e.detail > 0 ? e.clientX : undefined)}
        aria-label={`${item.title} ${when} — open extra hours or schedule here`}
        title={`${item.title} ${when} — tap to open extra hours or schedule here`}
        className={cn(base, HATCH_OFF, 'cursor-pointer transition-[box-shadow] duration-150 hover:shadow-[inset_0_0_0_1.5px_var(--line-strong)]')}
        style={place}
      />
    )
  }

  if (item.kind === 'blocked') {
    const Tag = tappable && item.entry?.block ? 'button' : 'span'
    return (
      <Tag
        {...(Tag === 'button'
          ? { type: 'button' as const, 'data-timeline-bar': '', onClick: () => onTap(item), 'aria-label': `${item.title} ${when} — unblock` }
          : {})}
        title={`${item.title} · ${when}${Tag === 'button' ? ' — tap to unblock' : ''}`}
        className={cn(base, HATCH_BLOCKED, 'border-[1.5px] border-dashed border-sh-crit text-sh-crit-fg', Tag === 'button' && 'cursor-pointer')}
        style={place}
      >
        <span className="flex w-full min-w-0 items-center justify-center gap-[6px] @min-[70px]:justify-start">
          <Icon icon={Ban} size={15} className="hidden shrink-0 @min-[16px]:block" />
          <span className="hidden min-w-0 flex-col @min-[70px]:flex">
            <span className="truncate text-[13px]/[16px] font-semibold">Blocked</span>
            <span className="truncate text-[11px]/[14px]">{item.title.replace(/^Blocked · /, '')}</span>
          </span>
        </span>
      </Tag>
    )
  }

  if (item.kind === 'free') {
    if (item.past) return <span aria-hidden="true" title={`${item.title} · ${when} · gone`} className={cn(base, 'border-[1.5px] border-dashed border-sh-line-strong')} style={place} />
    // A picture, not words: + where a patient can be scheduled, a clock with + in extra hours.
    const words = <Icon icon={item.extra ? ClockPlus : Plus} size={18} strokeWidth={2.25} className="hidden shrink-0 @min-[18px]:block" />
    return tappable ? (
      <button
        type="button"
        data-timeline-bar=""
        onClick={(e) => onTap(item, e.detail > 0 ? e.clientX : undefined)}
        aria-label={`${item.title} ${when} — schedule an appointment`}
        title={`${item.title} ${when} — tap a time to schedule`}
        className={cn(base, FREE, 'cursor-pointer justify-center transition-[filter] duration-150 hover:brightness-[0.97]')}
        style={place}
      >
        {words}
      </button>
    ) : (
      <span title={`${item.title} ${when}`} className={cn(base, FREE, 'justify-center')} style={place}>
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
    <button type="button" data-timeline-bar="" onClick={() => onOpen(e.to!)} aria-label={`${item.title}, ${when}${e.detail ? `, ${e.detail}` : ''}`} title={`${item.title} · ${when}`} className={cn(cls, 'transition-[filter] duration-150 hover:brightness-105')} style={style}>
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
        : { dot: 'var(--avail-edge)', name: item.extra ? 'Available · extra hours' : 'Available', aside: `${left} min free` }
      : item.kind === 'off'
        ? { dot: 'var(--off-hatch)', name: 'Off hours', aside: item.past ? '' : 'Tap for options' }
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

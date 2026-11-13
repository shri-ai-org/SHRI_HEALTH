/**
 * §5.7 — My Day's calendar card: one component, two states. The WEEK is the
 * default — this week, Monday first, one row of days with the selected day's
 * detail drawn under it (`DayDetail`). "Month" expands the whole month grid in
 * place, where a day peeks on hover and pins on a click, as before; "Week"
 * collapses it back to the week that holds the selected day. Both draw the
 * same day cell — load dots, the critical marker, the blocked marker — from
 * the live calendar (`logic/schedule.ts`).
 *
 * ‹ › step a week, or a month when expanded; "Today" appears only once you
 * have moved away. The grid is one tab stop: ←/→ a day, ↑/↓ a week, PgUp/PgDn
 * a month, Home/End the week's first and last day; Tab leaves it. A sideways
 * swipe changes the week (or month) on a touch screen. Every day stays a 44px
 * target; under 1024px the month's peek opens as a bottom sheet.
 */

import { format } from 'date-fns'
import { AnimatePresence, motion } from 'framer-motion'
import { Ban, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Stethoscope } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Link } from 'react-router-dom'

import { cn } from '../lib/cn'
import { NOW, fmtMonth, fmtTime12 } from '../lib/clock'
import { monthSlide } from '../lib/motion'
import { useShri } from '../state/store'
import { useMediaQuery } from '../ui/hooks'
import { clinicDate, clinicNow } from '../../../shri-health/format'
import { isoDay, useProviderWeek } from '../../../shri-health/myday'
import { recordPath } from '../../../shri-health/record'
import type { AppointmentSummary } from '../../../../src/api/generated/model'
import { EmptyState } from '../ui/EmptyState'
import { Card, Icon, Pill, PillTag, RoundButton } from '../ui/primitives'

import { DayDetail, LoadMeter } from './DayDetail'
import { DayPeek } from './DayPeek'
import { useMyDay, type CalendarDay } from './useMyDay'

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const HOVER_OPEN_MS = 280
const HOVER_CLOSE_MS = 160
const SWIPE_PX = 40

const dateOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const isoOf = (d: Date) => format(d, 'yyyy-MM-dd')
const addDays = (iso: string, n: number) => {
  const d = dateOf(iso)
  return isoOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n))
}

/** "21 – 27 Sep 2026" · "28 Sep – 4 Oct 2026". */
function weekTitle(week: CalendarDay[]): string {
  const a = week[0].date
  const b = week[6].date
  return a.getMonth() === b.getMonth() ? `${a.getDate()} – ${format(b, 'd MMM yyyy')}` : `${format(a, 'd MMM')} – ${format(b, 'd MMM yyyy')}`
}

const REAL_API = typeof __SHRI_REAL_API__ !== 'undefined' && __SHRI_REAL_API__

/**
 * With the API: this week on the clinic's clock, Monday first, today marked, and under each day the
 * number of patients booked with the signed-in provider (GET /me's practitionerId, #221). Working
 * hours, leave and blocks need the provider schedules, which MD can't read yet (gap 63).
 */
function ApiWeek({ className }: { className?: string }) {
  const today = clinicNow()
  const todayIso = isoDay(today)
  const [anchor, setAnchor] = useState(todayIso)
  const [selected, setSelected] = useState(todayIso)
  const a = dateOf(anchor)
  const monday = new Date(a.getFullYear(), a.getMonth(), a.getDate() - ((a.getDay() + 6) % 7))
  const days = Array.from({ length: 7 }, (_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i))
  const week = useProviderWeek(monday)
  const booked = (d: Date) => (week.status === 'done' ? (week.value.get(isoDay(d)) ?? []) : [])
  const showingToday = days.some((d) => isoDay(d) === todayIso)
  const step = (n: 1 | -1) => {
    const next = addDays(isoDay(monday), 7 * n)
    setAnchor(next)
    setSelected(next)
  }
  const goToday = () => {
    setAnchor(todayIso)
    setSelected(todayIso)
  }
  const chosen = days.find((d) => isoDay(d) === selected) ?? days[0]
  const sunday = days[6]
  const title = monday.getMonth() === sunday.getMonth() ? `${format(monday, 'MMM d')} – ${format(sunday, 'd, yyyy')}` : `${format(monday, 'MMM d')} – ${format(sunday, 'MMM d, yyyy')}`
  return (
    <Card
      className={cn('relative max-[360px]:-mx-[16px] max-[360px]:rounded-none lg:min-h-0 lg:flex-[3]', className)}
      title={title}
      titleSize="sm"
      right={
        <>
          {!showingToday && (
            <Pill variant="primary" size="sm" onClick={goToday} className="mr-[2px]" aria-label="Back to today">
              Today
            </Pill>
          )}
          <span className="flex items-center gap-[10px]">
            <RoundButton icon={ChevronLeft} size={34} iconSize={17} label="Previous week" onClick={() => step(-1)} />
            <RoundButton icon={ChevronRight} size={34} iconSize={17} label="Next week" onClick={() => step(1)} />
          </span>
        </>
      }
    >
      <div className="grid grid-cols-7 gap-[3px] pb-[4px] max-sm:-mx-[18px] max-[360px]:gap-x-0" aria-hidden="true">
        {WEEKDAYS.map((w) => (
          <span key={w} className="text-center text-[12px]/[18px] text-sh-muted">
            {w}
          </span>
        ))}
      </div>
      <div role="grid" aria-label={`Week of ${format(monday, 'MMMM d, yyyy')}`} className="grid grid-cols-7 gap-[3px] px-[4px] py-[4px] max-sm:-mx-[18px] max-sm:px-0 max-[360px]:gap-x-0">
        {days.map((d) => {
          const iso = isoDay(d)
          const n = booked(d).length
          const level = loadOf(n)
          return (
            <button
              key={iso}
              type="button"
              role="gridcell"
              aria-selected={iso === selected}
              aria-current={iso === todayIso ? 'date' : undefined}
              aria-label={`${format(d, 'EEEE, MMMM d')}${week.status === 'done' ? `, ${n} booked · ${LOAD[level]}` : ''}`}
              onClick={() => setSelected(iso)}
              className={cn('flex h-[56px] flex-col items-center justify-center gap-[3px] rounded-[14px] transition-colors duration-150 hover:bg-sh-accent-soft max-sm:focus-visible:outline-offset-[-3px]', iso === selected && 'bg-sh-accent-soft')}
            >
              <span
                className={cn(
                  'inline-flex size-[30px] items-center justify-center rounded-full text-[13px]/none tabular-nums',
                  iso === todayIso ? 'bg-sh-accent font-semibold text-sh-accent-ink' : 'text-sh-text',
                  iso === selected && 'ring-[3px] ring-(--day-selected-ring)',
                )}
              >
                {d.getDate()}
              </span>
              <span className="flex h-[8px] items-center gap-[3px]" aria-hidden="true">
                {Array.from({ length: level }, (_, i) => (
                  <span key={i} className="size-[4px] rounded-full bg-sh-accent" />
                ))}
              </span>
            </button>
          )
        })}
      </div>
      <div className="mt-[10px] flex flex-wrap items-center gap-x-[14px] gap-y-[4px] text-[11px] text-sh-muted" aria-label="Legend">
        <Legend dots={1}>Light</Legend>
        <Legend dots={2}>Moderate</Legend>
        <Legend dots={3}>Busy</Legend>
      </div>
      {week.status === 'not-a-provider' && <EmptyState compact icon={CalendarDays} why="Your sign-in isn't linked to a provider, so there are no bookings of your own to show." />}
      {week.status === 'failed' && <EmptyState compact icon={CalendarDays} why="Your week could not be loaded. Reload the page to try again." />}
      {week.status === 'done' && <ApiDay date={chosen} isToday={isoDay(chosen) === todayIso} past={isoDay(chosen) < todayIso} bookings={booked(chosen)} />}
    </Card>
  )
}

/** Patients booked a day: up to 4 is light, up to 9 moderate, 10 or more busy. */
const loadOf = (n: number) => (n === 0 ? 0 : n < 5 ? 1 : n < 10 ? 2 : 3)
const LOAD = ['free day', 'light day', 'moderate day', 'busy day']

/** The chosen day under the week, as the sample's day card: the date, its load, and who is booked. */
function ApiDay({ date, isToday, past, bookings }: { date: Date; isToday: boolean; past: boolean; bookings: AppointmentSummary[] }) {
  const level = loadOf(bookings.length)
  return (
    <div className="sh-scrollbar -mx-[6px] mt-[14px] min-h-0 flex-1 overflow-y-auto border-t border-sh-line px-[6px] pt-[14px]">
      <div className="flex items-center gap-[12px]">
        <span className="flex size-[52px] shrink-0 flex-col items-center justify-center rounded-[16px] bg-sh-accent text-sh-accent-ink" aria-hidden="true">
          <span className="text-[20px]/[22px] font-semibold tabular-nums">{date.getDate()}</span>
          <span className="text-[10px]/[12px] font-medium uppercase tracking-[0.06em]">{format(date, 'EEE')}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px]/[20px] font-medium">{format(date, 'MMMM yyyy')}</span>
          <span className="block text-[12px]/[16px] text-sh-text-3">{isToday ? 'Today' : past ? 'Earlier' : 'Coming up'}</span>
        </span>
        <LoadMeter level={level} critical={false} word={LOAD[level]} />
      </div>
      <div className="mt-[12px] flex flex-wrap items-center gap-[6px]">
        <PillTag variant="control" size="sm" className="font-medium">
          {bookings.length} booked
        </PillTag>
        <span className="text-[12px] font-medium text-sh-text-2">{LOAD[level]}</span>
      </div>
      {bookings.length > 0 ? (
        <div className="mt-[14px]">
          <p className="mb-[4px] text-[12px] text-sh-text-3">Booked with you</p>
          <ul className="flex flex-col" aria-label={`Booked with you on ${format(date, 'EEEE MMMM d')}`}>
            {bookings.map((b) => {
              const done = b.status === 'fulfilled' || b.status === 'noshow' || b.visitStatus === 'checked-out'
              return (
                <li key={b.id} className={cn('flex items-center gap-[8px]', done && 'opacity-60')}>
                  <Link to={recordPath(b.patient, 'record')} className="flex min-h-[44px] min-w-0 flex-1 items-center gap-[10px] rounded-[12px] px-[6px] py-[4px] transition-colors duration-150 hover:bg-sh-hover">
                    <span className="inline-flex size-[32px] shrink-0 items-center justify-center rounded-full bg-sh-inner text-sh-text-2">
                      <Icon icon={Stethoscope} size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]/[16px] font-medium">{b.patient.displayName}</span>
                      <span className="block truncate text-[11px]/[14px] text-sh-text-3">{b.reasonForVisit ?? b.appointmentType.name}</span>
                    </span>
                    <PillTag variant="primary" size="xs" className="font-semibold tabular-nums">
                      {fmtTime12(clinicDate(b.startAt))}
                    </PillTag>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ) : (
        <p className="mt-[12px] text-[13px] text-sh-text-2">No patients are booked with you this day.</p>
      )}
    </div>
  )
}

export function Calendar({ className }: { className?: string }) {
  if (REAL_API) return <ApiWeek className={className} />
  return <SampleCalendar className={className} />
}

function SampleCalendar({ className }: { className?: string }) {
  const d = useMyDay()
  const view = useShri((s) => s.calendarView)
  const anchor = useShri((s) => s.calendarAnchor)
  const selected = useShri((s) => s.selectedDay)
  const dir = useShri((s) => s.calendarDir)
  const goWeek = useShri((s) => s.goWeek)
  const goMonth = useShri((s) => s.goMonth)
  const goToday = useShri((s) => s.goToday)
  const selectDay = useShri((s) => s.selectDay)
  const setView = useShri((s) => s.setCalendarView)
  const peekDay = useShri((s) => s.peekDay)
  const peekPinned = useShri((s) => s.peekPinned)
  const pinPeek = useShri((s) => s.pinPeek)
  const closePeek = useShri((s) => s.closePeek)

  const sheet = useMediaQuery('(max-width: 1023.98px)')
  const sheetRef = useRef(sheet)
  useEffect(() => {
    sheetRef.current = sheet
  }, [sheet])

  const anchorDate = useMemo(() => dateOf(anchor), [anchor])
  const week = useMemo(() => d.weekDays(anchorDate), [d, anchorDate])
  const month = useMemo(() => d.monthWeeks(anchorDate.getFullYear(), anchorDate.getMonth()), [d, anchorDate])
  const rows = view === 'week' ? [week] : month
  const selectedDay = useMemo(() => d.dayInfo(dateOf(selected)), [d, selected])
  const showingToday = view === 'week' ? week.some((x) => x.isToday) : anchorDate.getFullYear() === NOW.getFullYear() && anchorDate.getMonth() === NOW.getMonth()
  const title = view === 'week' ? weekTitle(week) : fmtMonth(anchorDate)
  const slideKey = view === 'week' ? `w-${week[0].iso}` : `m-${format(anchorDate, 'yyyy-MM')}`
  const step = (n: 1 | -1) => (view === 'week' ? goWeek(n) : goMonth(n))

  /* ---- the month's hover peek: 280ms in, 160ms out; the popover itself keeps it open */
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = (t: typeof openTimer) => {
    if (t.current) clearTimeout(t.current)
    t.current = null
  }
  function hoverIn(iso: string) {
    if (view !== 'month') return
    clear(closeTimer)
    if (sheetRef.current || useShri.getState().peekPinned) return
    clear(openTimer)
    openTimer.current = setTimeout(() => useShri.getState().openPeek(iso), HOVER_OPEN_MS)
  }
  function hoverOut() {
    clear(openTimer)
    if (useShri.getState().peekPinned) return
    clear(closeTimer)
    closeTimer.current = setTimeout(() => {
      if (!useShri.getState().peekPinned) useShri.getState().closePeek()
    }, HOVER_CLOSE_MS)
  }
  useEffect(
    () => () => {
      clear(openTimer)
      clear(closeTimer)
    },
    [],
  )

  /* A pinned peek closes on scroll or resize (Esc and the scrim are the shell's). */
  const peekRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!peekPinned) return
    const close = (e?: Event) => {
      if (e && peekRef.current && e.target instanceof Node && peekRef.current.contains(e.target)) return
      useShri.getState().closePeek()
    }
    const arm = setTimeout(() => {
      window.addEventListener('resize', close)
      window.addEventListener('scroll', close, true)
    }, 300)
    return () => {
      clearTimeout(arm)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [peekPinned])

  /* ---- choosing a day: the week shows it underneath; the month pins its peek */
  function choose(day: CalendarDay) {
    clear(openTimer)
    clear(closeTimer)
    selectDay(day.iso)
    if (view === 'month') {
      if (peekPinned && peekDay === day.iso) closePeek()
      else pinPeek(day.iso)
    }
  }

  /* ---- one tab stop, arrows inside: the roving focus follows the selected day */
  const grid = useRef<HTMLDivElement>(null)
  // Set by a key press, so focus follows the keyboard onto the new day (and into a new week or month) — never on a click.
  const moved = useRef(false)
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    // From the stable wrapper, not the animated grid: while a week slides, the leaving grid is still mounted and would take the ref.
    const cells = grid.current?.querySelectorAll<HTMLElement>(`[data-iso="${selected}"]`)
    cells?.[cells.length - 1]?.focus()
  }, [selected, slideKey])
  function onKey(e: KeyboardEvent) {
    const monthOf = (iso: string, n: number) => {
      const x = dateOf(iso)
      const target = new Date(x.getFullYear(), x.getMonth() + n, 1)
      const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
      return isoOf(new Date(target.getFullYear(), target.getMonth(), Math.min(x.getDate(), last)))
    }
    const weekday = (dateOf(selected).getDay() + 6) % 7
    const next: Record<string, string | undefined> = {
      ArrowLeft: addDays(selected, -1),
      ArrowRight: addDays(selected, 1),
      ArrowUp: addDays(selected, -7),
      ArrowDown: addDays(selected, 7),
      Home: addDays(selected, -weekday),
      End: addDays(selected, 6 - weekday),
      PageUp: monthOf(selected, -1),
      PageDown: monthOf(selected, 1),
    }
    const to = next[e.key]
    if (to) {
      e.preventDefault()
      closePeek()
      moved.current = true
      selectDay(to)
    } else if ((e.key === 'Enter' || e.key === ' ') && view === 'month') {
      e.preventDefault()
      pinPeek(selected)
    }
  }

  /* ---- a sideways swipe changes the week (or month) */
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY }
  }
  const onPointerUp = (e: PointerEvent) => {
    const s = swipe.current
    swipe.current = null
    if (!s) return
    const dx = e.clientX - s.x
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(e.clientY - s.y) < SWIPE_PX) step(dx < 0 ? 1 : -1)
  }

  const label = (x: CalendarDay) =>
    `${format(x.date, 'EEEE d MMMM yyyy')} · ${x.levelWord}${x.critical ? ' · critical' : ''}${x.blocks.length > 0 ? ` · blocked: ${x.blocks.map((b) => b.block!.reason).join(', ')}` : ''}`

  return (
    <Card
      className={cn('relative max-[360px]:-mx-[16px] max-[360px]:rounded-none', view === 'week' && 'lg:min-h-0 lg:flex-[3]', className)}
      title={title}
      titleSize="sm"
      right={
        <>
          {!showingToday && (
            <Pill variant="primary" size="sm" onClick={goToday} className="mr-[2px]" aria-label="Back to today">
              Today
            </Pill>
          )}
          {/* 10px apart: two 34px buttons, each with a 44px target that doesn't overlap the other's. */}
          <span className="flex items-center gap-[10px]">
            <RoundButton icon={ChevronLeft} size={34} iconSize={17} label={view === 'week' ? 'Previous week' : 'Previous month'} onClick={() => step(-1)} />
            <RoundButton icon={ChevronRight} size={34} iconSize={17} label={view === 'week' ? 'Next week' : 'Next month'} onClick={() => step(1)} />
          </span>
          <Pill variant="control" size="sm" icon={view === 'week' ? ChevronDown : ChevronUp} aria-expanded={view === 'month'} onClick={() => setView(view === 'week' ? 'month' : 'week')} className="ml-[6px]">
            {view === 'week' ? 'Month' : 'Week'}
          </Pill>
        </>
      }
    >
      <div className="grid grid-cols-7 gap-[3px] pb-[4px] max-sm:-mx-[18px] max-[360px]:gap-x-0" aria-hidden="true">
        {WEEKDAYS.map((w) => (
          <span key={w} className="text-center text-[12px]/[18px] text-sh-muted">
            {w}
          </span>
        ))}
      </div>

      <div ref={grid} className="relative -mx-[4px] overflow-hidden px-[4px] py-[4px] max-sm:-mx-[18px] max-sm:px-0" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <AnimatePresence mode="popLayout" custom={dir} initial={false}>
          <motion.div
            key={slideKey}
            custom={dir}
            variants={monthSlide}
            initial="enter"
            animate="centre"
            exit="exit"
            role="grid"
            aria-label={view === 'week' ? `Week of ${weekTitle(week)}` : fmtMonth(anchorDate)}
            onKeyDown={onKey}
            className="flex flex-col gap-[3px]"
          >
            {rows.map((r, wi) => (
              <div key={wi} role="row" className="grid grid-cols-7 gap-[3px] max-[360px]:gap-x-0">
                {r.map((x) => (
                  <DayCell
                    key={x.iso}
                    day={x}
                    tall={view === 'week'}
                    focusable={x.iso === selected || (!rows.flat().some((y) => y.iso === selected) && x.isToday)}
                    selected={view === 'week' ? x.iso === selected : peekDay === x.iso}
                    pinned={peekPinned && peekDay === x.iso}
                    label={label(x)}
                    onEnter={() => hoverIn(x.iso)}
                    onLeave={hoverOut}
                    onChoose={() => choose(x)}
                  />
                ))}
              </div>
            ))}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="mt-[10px] flex flex-wrap items-center gap-x-[14px] gap-y-[4px] text-[11px] text-sh-muted" aria-label="Legend">
        <Legend dots={1}>Light</Legend>
        <Legend dots={2}>Moderate</Legend>
        <Legend dots={3}>Busy</Legend>
        <Legend dots={1} crit>
          Critical
        </Legend>
        <span className="inline-flex items-center gap-[5px]">
          <Icon icon={Ban} size={10} className="text-sh-crit-fg" />
          Blocked
        </span>
      </div>

      {/* The week: the chosen day, in full, under it. It fills the card and scrolls inside. */}
      {view === 'week' && (
        <div key={selectedDay.iso} className="sh-scrollbar -mx-[6px] mt-[14px] min-h-0 flex-1 overflow-y-auto border-t border-sh-line px-[6px] pt-[14px]">
          <DayDetail day={selectedDay} />
        </div>
      )}

      <div ref={peekRef} className="contents">
        <AnimatePresence>
          {view === 'month' && peekDay && <DayPeek key={peekDay} iso={peekDay} pinned={peekPinned} sheet={sheet} onEnter={() => clear(closeTimer)} onLeave={hoverOut} />}
        </AnimatePresence>
      </div>
    </Card>
  )
}

function DayCell({
  day: d,
  tall,
  focusable,
  selected,
  pinned,
  label,
  onEnter,
  onLeave,
  onChoose,
}: {
  day: CalendarDay
  tall: boolean
  focusable: boolean
  selected: boolean
  pinned: boolean
  label: string
  onEnter: () => void
  onLeave: () => void
  onChoose: () => void
}) {
  const blocked = d.blocks.length > 0
  return (
    <button
      type="button"
      role="gridcell"
      data-iso={d.iso}
      tabIndex={focusable ? 0 : -1}
      aria-label={label}
      aria-selected={selected}
      aria-pressed={pinned}
      aria-current={d.isToday ? 'date' : undefined}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onChoose}
      className={cn(
        // The grid meets the card edge on a phone, so the focus ring is drawn inside the cell.
        'flex flex-col items-center justify-center gap-[3px] rounded-[14px] transition-colors duration-150 hover:bg-sh-accent-soft max-sm:focus-visible:outline-offset-[-3px]',
        tall ? 'h-[56px]' : 'h-[44px]',
        selected && 'bg-sh-accent-soft',
      )}
    >
      <span
        className={cn(
          'inline-flex size-[30px] items-center justify-center rounded-full text-[13px]/none tabular-nums',
          d.isToday ? 'bg-sh-accent font-semibold text-sh-accent-ink' : d.inMonth ? 'text-sh-text' : 'text-(--other-month)',
          selected && 'ring-[3px] ring-(--day-selected-ring)',
          blocked && !d.isToday && 'line-through decoration-(--crit-fg)',
        )}
      >
        {d.date.getDate()}
      </span>
      <span className="flex h-[8px] items-center gap-[3px]" aria-hidden="true">
        {blocked && <Icon icon={Ban} size={8} strokeWidth={3} className={cn('text-sh-crit-fg', !d.inMonth && 'opacity-40')} />}
        {Array.from({ length: d.level }, (_, i) => (
          <span key={i} className={cn('size-[4px] rounded-full', d.critical && i === d.level - 1 ? 'bg-sh-crit' : 'bg-sh-accent', !d.inMonth && 'opacity-40')} />
        ))}
      </span>
    </button>
  )
}

function Legend({ dots, crit, children }: { dots: number; crit?: boolean; children: string }) {
  return (
    <span className="inline-flex items-center gap-[5px]">
      <span className="inline-flex items-center gap-[2px]" aria-hidden="true">
        {Array.from({ length: dots }, (_, i) => (
          <span key={i} className={cn('size-[4px] rounded-full', crit ? 'bg-sh-crit' : 'bg-sh-accent')} />
        ))}
      </span>
      {children}
    </span>
  )
}

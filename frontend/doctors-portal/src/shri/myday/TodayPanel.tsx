/**
 * §5.4 — Today, the Dashboard's full-width panel: the day as one row of bars
 * across the hours (`DayTimeline`), its key, and the day's events as cards.
 *
 * The day shown is the calendar's chosen day (`useShri.selectedDay`) — one
 * state, so this panel and the calendar beside it never disagree: ‹ › move
 * both a day, Today brings both back. On today the header names what is on
 * now and the time; the cards show the whole day, or only what is on and
 * next; the OPD's next patient is the queue's own (`nextToCall`), the one its
 * Call button calls. Tapping free time still to come schedules a patient at
 * the minute tapped (`NewAppointmentDialog`); tapping off hours still to come
 * asks whether to open extra hours there for the front office, or schedule
 * there anyway — an early operation. Never time already gone.
 * Every count is the live calendar's (`dayModel.ts`).
 */

import { format } from 'date-fns'
import { CalendarClock, CalendarSearch, ChevronLeft, ChevronRight, ClockPlus, Plus, UserRound } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { clinicDate, clinicNow } from '../../../shri-health/format'
import { useProviderDay, type ProviderDay } from '../../../shri-health/myday'
import { summaryPatient } from '../../../shri-health/kit'
import type { DayBlock } from '@/data/myday'

import { canonical } from '../app/paths'
import { NOW, fmtTime12, range12, time12 } from '../lib/clock'
import { cn } from '../lib/cn'
import { nextToCall } from '../../../shri-health/opd'
import { recordPath } from '../../../shri-health/record'
import type { StatusBoardItem } from '../../../../src/api/generated/model'
import type { Tone } from '../mocks/types'
import { useShri } from '../state/store'
import { EmptyState } from '../ui/EmptyState'
import { iconFor } from '../ui/icons'
import { Card, Chip, Diamond, Icon, Pill, RoundButton } from '../ui/primitives'

import { DayTimeline } from './DayTimeline'
import { KIND_LABEL, dayModel, duration, hourLine, isActivity, type ActivityKind, type DayModel, type Span, type TimelineItem } from './dayModel'
import { FREE, HATCH_BLOCKED, HATCH_OFF, actStyle } from './timelineStyle'
import { useMyDay } from './useMyDay'

const EMPHASIS_TONE: Record<NonNullable<DayBlock['emphasis']>[number]['tone'], Tone> = { critical: 'crit', warning: 'warn', pending: 'pend' }
const UPCOMING = 5

/** "6 patients · 2 need attention" → its parts, the ones the plan marks as critical, warning or pending in that tone. */
function partsOf(b: DayBlock): { text: string; tone?: Tone }[] {
  return b.summary.split(' · ').map((text) => {
    const em = b.emphasis?.find((e) => text.includes(e.text) || e.text.includes(text))
    return { text, tone: em ? EMPHASIS_TONE[em.tone] : undefined }
  })
}

const dateOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const isoOf = (d: Date) => format(d, 'yyyy-MM-dd')
const plusDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

const REAL_API = typeof __SHRI_REAL_API__ !== 'undefined' && __SHRI_REAL_API__

/** The clinic's day in U.S. form, "Thursday, Nov 5, 2026" (D40). */
const usDay = (d: Date) => new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }).format(d)

export function TodayPanel({ className }: { className?: string }) {
  if (REAL_API) return <ApiToday className={className} />
  return <SampleToday className={className} />
}

function SampleToday({ className }: { className?: string }) {
  const d = useMyDay()
  const navigate = useNavigate()
  const selected = useShri((s) => s.selectedDay)
  const selectDay = useShri((s) => s.selectDay)
  const goToday = useShri((s) => s.goToday)
  const openDialog = useShri((s) => s.openScheduleDialog)
  const { dayInfo } = d
  const day = useMemo(() => dayInfo(dateOf(selected)), [dayInfo, selected])
  const model = useMemo(() => dayModel(day), [day])
  const [whole, setWhole] = useState(true)

  const gone = !day.isToday && day.date < NOW
  const events = model.items.filter((i) => isActivity(i.kind)).sort((x, y) => x.start - y.start)
  const ahead = day.isToday ? events.filter((e) => e.end > model.now!) : events
  const shown = whole ? events : ahead.slice(0, UPCOMING)
  const current = day.isToday ? events.find((e) => e.start <= model.now! && model.now! < e.end) : undefined
  // A booked patient is an OPD visit, in the OPD's green: the key names it once, as OPD.
  const kinds = [...new Set(events.map((e) => (e.kind === 'patient' ? 'opd' : e.kind) as ActivityKind))]
  const has = (k: string) => model.items.some((i) => i.kind === k && !i.past)

  // The OPD's next patient, as the queue calls them.
  const next = day.isToday ? nextToCall(d.opd) : undefined
  const nextPatient = next ? { name: summaryPatient(next.patientId).name, token: next.clinic?.token ?? 'Teleconsult' } : undefined

  return (
    <Card className={cn('gap-0', className)} aria-labelledby="sh-today-title">
      <header className="flex flex-wrap items-start gap-x-[16px] gap-y-[12px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-[12px]">
            <h2 id="sh-today-title" className="text-[26px]/[1.15] font-semibold tracking-[-0.02em] text-sh-text">
              {day.isToday ? 'Today' : format(day.date, 'EEEE')}
            </h2>
            {current && (
              <span className="inline-flex h-[34px] items-center gap-[8px] rounded-full bg-sh-pend-bg px-[14px] text-[14px] font-medium text-sh-pend-fg">
                <Icon icon={iconFor(current.entry!.icon)} size={16} />
                Now · {current.title}
              </span>
            )}
          </div>
          <p className="mt-[4px] text-[14px] text-sh-text-2">{day.isToday ? format(day.date, 'EEEE, dd MMM yyyy') : `${format(day.date, 'dd MMM yyyy')} · ${gone ? 'Earlier' : 'Coming up'}`}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-[10px]">
          <div className="flex items-center gap-[4px] rounded-full bg-sh-control p-[3px]">
            <RoundButton icon={ChevronLeft} size={44} variant="card" label="Previous day" onClick={() => selectDay(isoOf(plusDays(day.date, -1)))} />
            <Pill variant={day.isToday ? 'card' : 'ghost'} size="xl" aria-pressed={day.isToday} onClick={goToday} className={cn(day.isToday && 'shadow-[0_1px_3px_rgb(0_0_0/0.12)]')}>
              Today
            </Pill>
            <RoundButton icon={ChevronRight} size={44} variant="card" label="Next day" onClick={() => selectDay(isoOf(plusDays(day.date, 1)))} />
          </div>
          {model.now !== null && (
            <span className="inline-flex h-[44px] items-center gap-[8px] rounded-full bg-sh-crit-bg px-[16px] text-[14px] font-medium tabular-nums text-sh-crit-fg max-sm:hidden">
              <span className="size-[10px] rounded-full bg-(--now-line)" aria-hidden="true" />
              Now · {time12(model.now)}
            </span>
          )}
        </div>
      </header>

      <div className="mt-[8px]">
        <DayTimeline
          model={model}
          nextPatient={nextPatient}
          onSchedule={(at, until) => openDialog({ kind: 'schedule', date: day.iso, at, until })}
          onOffHours={(at, [from, to]) => openDialog({ kind: 'offHours', date: day.iso, at, from, to })}
          onBlocked={(blockId) => openDialog({ kind: 'unblock', blockId })}
        />
      </div>

      {/* The key — and, for a screen reader, the day in one sentence. */}
      <div className="mt-[10px] flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
        <div role="img" aria-label={model.summary} className="inline-flex flex-wrap items-center gap-x-[18px] gap-y-[8px] rounded-[14px] border border-sh-line px-[14px] py-[10px] text-[13px] text-sh-text-2">
          {kinds.map((k) => (
            <span key={k} className="inline-flex items-center gap-[7px]">
              <span className="size-[13px] rounded-[4px]" style={actStyle(k)} />
              {KIND_LABEL[k]}
            </span>
          ))}
          {model.items.some((i) => i.kind === 'free' && !i.past && !i.extra) && (
            <span className="inline-flex items-center gap-[7px]">
              <span className={cn('inline-flex h-[16px] w-[22px] items-center justify-center rounded-[4px]', FREE)}>
                <Icon icon={Plus} size={11} strokeWidth={2.5} />
              </span>
              Available
            </span>
          )}
          {model.items.some((i) => i.extra) && (
            <span className="inline-flex items-center gap-[7px]">
              <span className={cn('inline-flex h-[16px] w-[22px] items-center justify-center rounded-[4px]', FREE)}>
                <Icon icon={ClockPlus} size={11} strokeWidth={2.5} />
              </span>
              Extra hours
            </span>
          )}
          {has('blocked') && (
            <span className="inline-flex items-center gap-[7px]">
              <span className={cn('h-[13px] w-[18px] rounded-[4px] border border-dashed border-sh-crit', HATCH_BLOCKED)} />
              Blocked
            </span>
          )}
          {has('off') && (
            <span className="inline-flex items-center gap-[7px]">
              <span className={cn('h-[13px] w-[18px] rounded-[4px]', HATCH_OFF)} />
              Off hours
            </span>
          )}
        </div>
        <p className="ml-auto text-[13px] tabular-nums text-sh-text-2">
          Busy <b className="font-semibold text-sh-text">{duration(model.busyMin)}</b> · Free <b className="font-semibold text-sh-text">{duration(model.freeMin)}</b>
          {model.nextFree !== null && (
            <>
              {' '}
              · Next free <b className="font-semibold text-sh-text">{time12(model.nextFree)}</b>
            </>
          )}
        </p>
      </div>

      <ul className="sr-only" aria-label={`Hour by hour, ${format(day.date, 'EEEE d MMMM')}`}>
        {model.cells.map((c) => (
          <li key={c.start}>{hourLine(c)}</li>
        ))}
      </ul>

      {/* The day's events — the whole day by default, or only what is on and next. */}
      <section aria-labelledby="sh-upcoming-title" className="mt-[20px] border-t border-sh-line pt-[18px]">
        <div className="flex flex-wrap items-center gap-[12px]">
          <h3 id="sh-upcoming-title" className="text-[20px]/[1.2] font-semibold tracking-[-0.01em] text-sh-text">
            {!whole ? 'Upcoming' : day.isToday ? 'Today’s schedule' : gone ? 'That day' : 'The day’s schedule'}
          </h3>
          <span className="inline-flex h-[30px] items-center rounded-full border border-sh-line-strong px-[12px] text-[13px] text-sh-text-2">
            {whole ? `${shown.length} event${shown.length === 1 ? '' : 's'}` : `Next ${shown.length} event${shown.length === 1 ? '' : 's'}`}
          </span>
          {day.isToday ? (
            <Pill variant="outline" size="xl" icon={CalendarSearch} onClick={() => setWhole(!whole)} className="ml-auto">
              {whole ? 'Show upcoming only' : 'View full day'}
            </Pill>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <p className="mt-[12px] rounded-[14px] bg-sh-inner px-[14px] py-[12px] text-[14px] text-sh-text-2">
            {events.length === 0 ? 'Nothing is scheduled on this day.' : 'Nothing else is scheduled for today.'}
          </p>
        ) : (
          <ol className="mt-[12px] grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-[12px]" aria-label={whole ? 'The day’s events' : 'Upcoming events'}>
            {shown.map((e) => (
              <li key={e.id} className="flex">
                <EventCard item={e} now={e.id === current?.id} block={d.blocks.find((b) => `block-${b.id}` === e.id)} aiActive={d.aiActive} past={day.isToday ? e.end <= model.now! : gone} onOpen={(to) => navigate(canonical(to))} />
              </li>
            ))}
          </ol>
        )}
      </section>

    </Card>
  )
}

const VISIT_WORDS: Record<string, string> = {
  arrived: 'Arrived',
  'checked-in': 'Checked in',
  roomed: 'Roomed',
  'with-provider': 'With you',
  'checked-out': 'Seen',
}

/** A booking's state in a word: the visit step, else the booking's own status. */
function visitWords(i: StatusBoardItem): string {
  if (i.status === 'noshow') return 'No-show'
  const step = i.visitStatus ? VISIT_WORDS[i.visitStatus] : undefined
  if (step) return i.visitStatus === 'roomed' && i.roomName ? `${step} · ${i.roomName}` : step
  return i.status === 'fulfilled' ? 'Seen' : 'Booked'
}

/**
 * With the API: the signed-in provider's own day (GET /me's practitionerId, #221): their bookings
 * today from the status board, as the sample's event cards, and their open times from the slots.
 * The hour-by-hour timeline needs working hours and blocks, which MD can't read yet (gap 63).
 */
function ApiToday({ className }: { className?: string }) {
  const navigate = useNavigate()
  const todayIso = isoOf(clinicNow())
  const [iso, setIso] = useState(todayIso)
  const day = useProviderDay(iso)
  const date = dateOf(iso)
  const isToday = iso === todayIso
  const model = useMemo(() => (day.status === 'done' ? apiDayModel(day.value, isToday) : null), [day, isToday])
  return (
    <Card className={cn('gap-0', className)} aria-labelledby="sh-today-title">
      <header className="flex flex-wrap items-start gap-x-[16px] gap-y-[12px]">
        <div className="min-w-0">
          <h2 id="sh-today-title" className="text-[26px]/[1.15] font-semibold tracking-[-0.02em] text-sh-text">
            {isToday ? 'Today' : format(date, 'EEEE')}
          </h2>
          <p className="mt-[4px] text-[14px] text-sh-text-2">{isToday ? usDay(date) : `${usDay(date)} · ${iso < todayIso ? 'Earlier' : 'Coming up'}`}</p>
        </div>
        {/* No Morning brief with the API: the brief is the AI chart summary, which has no service yet
            (getChartSummary, Vimal's #267), so it would show sample patients. */}
        <div className="ml-auto flex flex-wrap items-center gap-[10px]">
          <div className="flex items-center gap-[4px] rounded-full bg-sh-control p-[3px]">
            <RoundButton icon={ChevronLeft} size={44} variant="card" label="Previous day" onClick={() => setIso(isoOf(plusDays(date, -1)))} />
            <Pill variant={isToday ? 'card' : 'ghost'} size="xl" aria-pressed={isToday} onClick={() => setIso(todayIso)} className={cn(isToday && 'shadow-[0_1px_3px_rgb(0_0_0/0.12)]')}>
              Today
            </Pill>
            <RoundButton icon={ChevronRight} size={44} variant="card" label="Next day" onClick={() => setIso(isoOf(plusDays(date, 1)))} />
          </div>
          {model?.now != null && (
            <span className="inline-flex h-[44px] items-center gap-[8px] rounded-full bg-sh-crit-bg px-[16px] text-[14px] font-medium tabular-nums text-sh-crit-fg max-sm:hidden">
              <span className="size-[10px] rounded-full bg-(--now-line)" aria-hidden="true" />
              Now · {time12(model.now)}
            </span>
          )}
        </div>
      </header>
      {day.status === 'loading' ? (
        <p role="status" className="mt-[12px] text-[13px] text-sh-text-3">
          Loading your day…
        </p>
      ) : day.status === 'not-a-provider' ? (
        <EmptyState compact icon={CalendarClock} why="Your sign-in isn't linked to a provider, so there is no schedule of your own to show." className="mt-[12px]" />
      ) : day.status === 'failed' ? (
        <EmptyState compact icon={CalendarClock} why="Your schedule could not be loaded. Reload the page to try again." className="mt-[12px]" />
      ) : (
        model && (
          <>
            <div className="mt-[8px]">
              {/* The front desk books, so free and off time are drawn, not offered; a booking opens its record. */}
              <DayTimeline model={model} onSchedule={() => undefined} onOffHours={() => undefined} onBlocked={() => undefined} readOnly />
            </div>
            <ApiKey model={model} />
            <ul className="sr-only" aria-label={`Hour by hour, ${format(date, 'EEEE MMMM d')}`}>
              {model.cells.map((c) => (
                <li key={c.start}>{hourLine(c)}</li>
              ))}
            </ul>
            <ProviderSchedule day={day.value} isToday={isToday} onOpen={(to) => navigate(to)} />
          </>
        )
      )}
    </Card>
  )
}

/** The timeline's key — bookings, open times, off hours — and the day in numbers, as the sample's. */
function ApiKey({ model }: { model: DayModel }) {
  const has = (k: TimelineItem['kind'], past?: boolean) => model.items.some((i) => i.kind === k && (past === undefined || !i.past === !past))
  return (
    <div className="mt-[10px] flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
      <div role="img" aria-label={model.summary} className="inline-flex flex-wrap items-center gap-x-[18px] gap-y-[8px] rounded-[14px] border border-sh-line px-[14px] py-[10px] text-[13px] text-sh-text-2">
        {has('patient') && (
          <span className="inline-flex items-center gap-[7px]">
            <span className="size-[13px] rounded-[4px]" style={actStyle('patient')} />
            {KIND_LABEL.patient}
          </span>
        )}
        {has('free', false) && (
          <span className="inline-flex items-center gap-[7px]">
            <span className={cn('inline-flex h-[16px] w-[22px] items-center justify-center rounded-[4px]', FREE)}>
              <Icon icon={Plus} size={11} strokeWidth={2.5} />
            </span>
            Open time
          </span>
        )}
        {has('off') && (
          <span className="inline-flex items-center gap-[7px]">
            <span className={cn('h-[13px] w-[18px] rounded-[4px]', HATCH_OFF)} />
            Off hours
          </span>
        )}
      </div>
      <p className="ml-auto text-[13px] tabular-nums text-sh-text-2">
        Busy <b className="font-semibold text-sh-text">{duration(model.busyMin)}</b> · Open <b className="font-semibold text-sh-text">{duration(model.freeMin)}</b>
        {model.nextFree !== null && (
          <>
            {' '}
            · Next free <b className="font-semibold text-sh-text">{time12(model.nextFree)}</b>
          </>
        )}
      </p>
    </div>
  )
}

const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes()

function merged(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

function without(spans: Span[], cut: Span[]): Span[] {
  return cut.reduce<Span[]>(
    (acc, [cs, ce]) => acc.flatMap(([s, e]): Span[] => (ce <= s || cs >= e ? [[s, e]] : ([cs > s ? [s, cs] : null, ce < e ? [ce, e] : null].filter(Boolean) as Span[]))),
    spans,
  )
}

const lengthOf = (spans: Span[]) => spans.reduce((n, [a, b]) => n + b - a, 0)

/**
 * The provider's real day as the sample's timeline draws it: each booking a bar (its own start and
 * end, from the appointment list), the open times from the slots, and everything else off hours.
 * No sessions, ward rounds or blocked time: the API has none of them yet.
 */
function apiDayModel(day: ProviderDay, isToday: boolean): DayModel {
  const at = (iso: string) => minutesOf(clinicDate(iso))
  const now = isToday ? minutesOf(clinicNow()) : null
  const board = new Map(day.items.map((i) => [i.appointmentId, i]))
  const booked = day.appointments
    .map((a) => ({ a, span: [at(a.startAt), Math.max(at(a.startAt) + 5, at(a.endAt))] as Span }))
    .sort((x, y) => x.span[0] - y.span[0])
  const busy = merged(booked.map((b) => b.span))
  const open = without(merged(day.slots.filter((s) => !s.overbook).map((s) => [at(s.startAt), at(s.endAt)] as Span)), busy)
  const first = Math.min(7 * 60, ...busy.map((b) => b[0]), ...open.map((o) => o[0]))
  const last = Math.max(19 * 60, ...busy.map((b) => b[1]), ...open.map((o) => o[1]))
  const range: Span = [Math.floor(first / 30) * 30, Math.ceil(last / 30) * 30]
  const off = without([range], [...busy, ...open])
  const gone = now ?? (day.appointments[0] && clinicDate(day.appointments[0].startAt) < clinicNow() ? range[1] : range[0])

  const acts: TimelineItem[] = booked.map(({ a, span }) => {
    const name = board.get(a.id)?.patient?.displayName ?? a.patient.displayName
    return {
      id: a.id,
      kind: 'patient',
      start: span[0],
      end: span[1],
      drawEnd: span[1],
      title: name,
      entry: {
        id: a.id,
        at: clinicDate(a.startAt),
        until: clinicDate(a.endAt),
        title: name,
        detail: a.reasonForVisit ?? a.appointmentType.name,
        kind: 'appointment',
        icon: 'Stethoscope',
        to: recordPath(a.patient, 'record'),
        patientId: a.patient.id,
      },
    }
  })
  acts.forEach((x, i) => {
    const next = acts.slice(i + 1).find((n) => n.start > x.start)
    if (next && next.start < x.end) x.drawEnd = next.start
  })
  const items: TimelineItem[] = [...acts]
  const split = (kind: 'free' | 'off', [a, b]: Span, title: string) => {
    if (a < gone) items.push({ id: `${kind}-gone-${a}`, kind, start: a, end: Math.min(b, gone), drawEnd: Math.min(b, gone), title, past: true })
    if (b > gone) items.push({ id: `${kind}-${Math.max(a, gone)}`, kind, start: Math.max(a, gone), end: b, drawEnd: b, title })
  }
  for (const o of open) split('free', o, 'Available')
  for (const o of off) split('off', o, 'Off hours')
  items.sort((x, y) => x.start - y.start)

  const ahead = items.filter((i) => i.kind === 'free' && !i.past && i.end - i.start >= 15)
  const cells = Array.from({ length: Math.ceil((range[1] - range[0]) / 60) }, (_, i) => {
    const span: Span = [range[0] + i * 60, Math.min(range[1], range[0] + (i + 1) * 60)]
    const inside = (spans: Span[]) => lengthOf(spans.map(([a, b]) => [Math.max(a, span[0]), Math.min(b, span[1])] as Span).filter(([a, b]) => b > a))
    const here = acts.filter((x) => x.start >= span[0] && x.start < span[1])
    return { start: span[0], end: span[1], busyMin: inside(busy), blockedMin: 0, offMin: inside(off), freeMin: inside(open), bookings: here.length, titles: here.map((x) => x.title) }
  })
  const count = day.appointments.length
  return {
    range,
    items,
    busyMin: lengthOf(busy),
    blockedMin: 0,
    freeMin: lengthOf(open),
    offMin: lengthOf(off),
    nextFree: ahead[0]?.start ?? null,
    cells,
    now,
    summary: `${count} ${count === 1 ? 'patient' : 'patients'} booked; busy ${duration(lengthOf(busy))}, open ${duration(lengthOf(open))}.`,
  }
}

function ProviderSchedule({ day, isToday, onOpen }: { day: ProviderDay; isToday: boolean; onOpen: (to: string) => void }) {
  // The status board has the visit statuses; another day's bookings come from the appointment list.
  const items: StatusBoardItem[] =
    day.items.length > 0
      ? day.items
      : day.appointments.map((a) => ({ appointmentId: a.id, patient: a.patient, initials: '', provider: a.provider, startAt: a.startAt, status: a.status, visitStatus: a.visitStatus, appointmentType: a.appointmentType, reasonForVisit: a.reasonForVisit }))
  const seen = items.filter((i) => visitWords(i) === 'Seen').length
  const now = Date.now()
  const ahead = day.slots.filter((s) => !s.overbook && new Date(s.startAt).getTime() > now).length
  return (
    <section aria-labelledby="sh-upcoming-title" className="mt-[20px] border-t border-sh-line pt-[18px]">
      <div className="flex flex-wrap items-center gap-[12px]">
        <h3 id="sh-upcoming-title" className="text-[20px]/[1.2] font-semibold tracking-[-0.01em] text-sh-text">
          {isToday ? 'Today’s schedule' : 'The day’s schedule'}
        </h3>
        <span className="inline-flex h-[30px] items-center rounded-full border border-sh-line-strong px-[12px] text-[13px] text-sh-text-2">
          {items.length} {items.length === 1 ? 'patient' : 'patients'}
        </span>
        <p className="ml-auto text-[13px] tabular-nums text-sh-text-2">
          Seen <b className="font-semibold text-sh-text">{seen}</b> · Open times <b className="font-semibold text-sh-text">{ahead}</b>
        </p>
      </div>
      {items.length === 0 ? (
        <p className="mt-[12px] rounded-[14px] bg-sh-inner px-[14px] py-[12px] text-[14px] text-sh-text-2">{isToday ? 'No patients are booked with you today.' : 'No patients are booked with you that day.'}</p>
      ) : (
        <ol className="mt-[12px] grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-[12px]" aria-label={isToday ? 'Your patients today' : 'Your patients that day'}>
          {items.map((i) => (
            <li key={i.appointmentId} className="flex">
              <BookingCard item={i} onOpen={onOpen} />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** One booking, drawn as the sample's EventCard draws a patient. */
function BookingCard({ item, onOpen }: { item: StatusBoardItem; onOpen: (to: string) => void }) {
  const words = visitWords(item)
  const past = words === 'Seen' || words === 'No-show'
  const name = item.patient?.displayName ?? item.initials
  return (
    <button
      type="button"
      disabled={!item.patient}
      onClick={() => item.patient && onOpen(recordPath(item.patient, 'record'))}
      className="relative flex min-h-[96px] w-full items-center gap-[12px] overflow-hidden rounded-[16px] border border-sh-line bg-sh-card py-[12px] pl-[18px] pr-[10px] text-left transition-colors duration-150 hover:bg-sh-hover"
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[4px]" style={{ background: 'var(--act-patient)' }} />
      <span aria-hidden="true" className="flex size-[44px] shrink-0 items-center justify-center rounded-[12px]" style={actStyle('patient')}>
        <Icon icon={UserRound} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[12px]/[16px] tabular-nums', past ? 'text-sh-text-3' : 'text-sh-text-2')}>
          {fmtTime12(clinicDate(item.startAt))} · {words}
        </span>
        <span className={cn('block truncate text-[15px]/[20px] font-semibold', past ? 'text-sh-text-3' : 'text-sh-text')}>{name}</span>
        <span className="mt-[2px] block truncate text-[13px] text-sh-text-2">{item.reasonForVisit ?? item.appointmentType?.name ?? ''}</span>
      </span>
      <Icon icon={ChevronRight} size={16} className="shrink-0 text-sh-chev" />
    </button>
  )
}

function EventCard({ item, now, block, aiActive, past, onOpen }: { item: TimelineItem; now: boolean; block?: DayBlock; aiActive: boolean; past: boolean; onOpen: (to: string) => void }) {
  const k = item.kind as ActivityKind
  const e = item.entry!
  return (
    <button
      type="button"
      onClick={() => e.to && onOpen(e.to)}
      className={cn(
        'relative flex min-h-[96px] w-full items-center gap-[12px] overflow-hidden rounded-[16px] border border-sh-line bg-sh-card py-[12px] pl-[18px] pr-[10px] text-left transition-colors duration-150 hover:bg-sh-hover',
        now && 'border-sh-line-strong bg-(--now-row-bg)',
      )}
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[4px]" style={{ background: `var(--act-${k})` }} />
      <span aria-hidden="true" className="flex size-[44px] shrink-0 items-center justify-center rounded-[12px]" style={actStyle(k)}>
        <Icon icon={iconFor(e.icon)} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[12px]/[16px] tabular-nums', past ? 'text-sh-text-3' : 'text-sh-text-2')}>{range12(item.start, item.end)}</span>
        <span className="flex items-center gap-[6px]">
          <span className={cn('truncate text-[15px]/[20px] font-semibold', past ? 'text-sh-text-3' : 'text-sh-text')}>{item.title}</span>
          {block?.ai && aiActive && <Diamond />}
          {now && (
            <span className="inline-flex h-[20px] shrink-0 items-center gap-[4px] rounded-full bg-sh-primary px-[7px] text-[10px] font-semibold tracking-[0.05em] text-sh-on-primary">
              <span className="sh-now-dot size-[5px] rounded-full bg-sh-accent" aria-hidden="true" />
              NOW
            </span>
          )}
        </span>
        {block ? (
          <span className="mt-[2px] line-clamp-2 text-[13px]/[20px] text-sh-text-2">
            {partsOf(block).map((p, i) => (
              <span key={i}>
                {i > 0 && ' '}
                <span className="whitespace-nowrap">
                  {i > 0 && '•\u00a0'}
                  {p.tone ? <Chip word={p.text} tone={p.tone} className="align-middle" /> : p.text}
                </span>
              </span>
            ))}
          </span>
        ) : (
          e.detail && <span className="mt-[2px] block truncate text-[13px] text-sh-text-2">{e.detail}</span>
        )}
      </span>
      <Icon icon={ChevronRight} size={16} className="shrink-0 text-sh-chev" />
    </button>
  )
}

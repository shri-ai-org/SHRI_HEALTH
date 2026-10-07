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
import { CalendarSearch, ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { patient } from '@/data/kit'
import type { DayBlock } from '@/data/myday'

import { canonical } from '../app/paths'
import { NOW, range12, time12 } from '../lib/clock'
import { cn } from '../lib/cn'
import { nextToCall } from '../logic/opd'
import type { Tone } from '../mocks/types'
import { useShri } from '../state/store'
import { iconFor } from '../ui/icons'
import { Card, Chip, Diamond, Icon, Pill, RoundButton } from '../ui/primitives'

import { DayTimeline, FREE, HATCH_BLOCKED, HATCH_OFF, actStyle } from './DayTimeline'
import { KIND_LABEL, dayModel, duration, hourLine, isActivity, type ActivityKind, type TimelineItem } from './dayModel'
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

export function TodayPanel({ className }: { className?: string }) {
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
  const kinds = [...new Set(events.map((e) => e.kind as ActivityKind))]
  const has = (k: string) => model.items.some((i) => i.kind === k && !i.past)

  // The OPD's next patient, as the queue calls them.
  const next = day.isToday ? nextToCall(d.opd) : undefined
  const nextPatient = next ? { name: patient(next.patientId).name, token: next.clinic?.token ?? 'Teleconsult' } : undefined

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
          {has('free') && (
            <span className="inline-flex items-center gap-[7px]">
              <span className={cn('h-[13px] w-[18px] rounded-[4px]', FREE)} />
              Available
            </span>
          )}
          {model.items.some((i) => i.extra) && (
            <span className="inline-flex items-center gap-[7px]">
              <span className={cn('h-[13px] w-[18px] rounded-[4px]', FREE)} />
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
              {whole ? 'Show what is next' : 'View full day'}
            </Pill>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <p className="mt-[12px] rounded-[14px] bg-sh-inner px-[14px] py-[12px] text-[14px] text-sh-text-2">
            {events.length === 0 ? 'Nothing booked on this day.' : 'Nothing more today.'}
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

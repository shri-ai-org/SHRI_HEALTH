/**
 * §5.4 — the day as a vertical timeline, from the old build's day plan
 * (`dayPlanFor`). Rows share the card's height evenly; the rail runs behind
 * the badges; the current block carries the NOW pill; a block's summary line
 * becomes its chips, with the numbers the plan marks as critical, warning or
 * pending in those tones. A block opens the screen it names. When the card is
 * shorter than the day (a 960px page on a short laptop), the rows scroll inside
 * it with the same bottom fade as Patients Today. Above the rows, the day's busy
 * and free time hour by hour — the calendar's grid, compact (`HourGrid`).
 */

import { Check, ChevronRight, Clock } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { DayBlock } from '@/data/myday'

import { canonical } from '../app/paths'
import { NOW, fmtTime } from '../lib/clock'
import { cn } from '../lib/cn'
import type { Tone } from '../mocks/types'
import { iconFor } from '../ui/icons'
import { Card, Chip, Diamond, Icon } from '../ui/primitives'

import { HourGrid } from './HourGrid'
import { useMyDay } from './useMyDay'

const EMPHASIS_TONE: Record<NonNullable<DayBlock['emphasis']>[number]['tone'], Tone> = { critical: 'crit', warning: 'warn', pending: 'pend' }

/** "6 patients · 1 new · 5 follow-ups" → one chip per part; a leading number is the chip's number. */
function chipsOf(b: DayBlock): { num?: string; word: string; tone: Tone }[] {
  return b.summary.split(' · ').map((part) => {
    const em = b.emphasis?.find((e) => part.includes(e.text) || e.text.includes(part))
    const m = /^(\d+)\s+(.*)$/.exec(part)
    return { num: m?.[1], word: m ? m[2] : part, tone: em ? EMPHASIS_TONE[em.tone] : 'neu' }
  })
}

/** A block without an end lasts half an hour, as the old plan's `currentBlock` counts it. */
const endOf = (b: DayBlock) => b.until ?? new Date(b.at.getTime() + 30 * 60_000)

export function TodayTimeline({ className }: { className?: string }) {
  const d = useMyDay()
  const navigate = useNavigate()
  /* Bottom fade only while there is more below the fold. */
  const listRef = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  const measure = useCallback(() => {
    const el = listRef.current
    if (!el) return
    setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 2)
  }, [])
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    // The box and its content: a persona switch changes the rows, not the box.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [measure])

  return (
    <Card className={className} aria-labelledby="sh-today-title">
      <header className="mb-[14px] flex min-h-[34px] items-center gap-[10px]">
        <h2 id="sh-today-title" className="text-[19px]/[1.2] font-medium tracking-[-0.012em] text-sh-text">
          Today
        </h2>
        {d.current ? (
          <span className="inline-flex h-[24px] shrink-0 items-center gap-[6px] rounded-full bg-sh-primary pl-[9px] pr-[10px] text-[12px] font-medium text-sh-on-primary">
            <span className="sh-now-dot size-[6px] rounded-full bg-sh-accent" aria-hidden="true" />
            Now · {d.current.title}
          </span>
        ) : (
          <span className="inline-flex h-[24px] shrink-0 items-center rounded-full bg-sh-control px-[10px] text-[12px] font-medium text-sh-text">
            {d.blocks.length} activities
          </span>
        )}
        {d.upNext && (
          <span className="ml-auto inline-flex min-w-0 items-center gap-[6px] text-[13px] text-sh-text-2" title="Up next">
            <Icon icon={Clock} size={15} />
            <span className="truncate">
              Up next {fmtTime(d.upNext.at)} · <b className="font-semibold text-sh-text">{d.upNext.title}</b>
            </span>
          </span>
        )}
      </header>

      <HourGrid day={d.dayInfo(NOW)} compact className="mb-[10px] mt-0" />

      {/* Rows bleed 10px into the card gutter so the times line up with the title. */}
      <div ref={listRef} onScroll={measure} className={cn('sh-scrollbar -mx-[10px] flex min-h-0 flex-1 flex-col overflow-y-auto', more && 'sh-fade-bottom')}>
        <div className="relative flex flex-1 flex-col">
          <span aria-hidden="true" className="pointer-events-none absolute bottom-[28px] left-[103px] top-[28px] w-[2px] rounded-full bg-sh-line" />
          <ol className="flex flex-1 flex-col" aria-label="Today's plan">
            {d.blocks.map((b) => (
              <li key={b.id} className="flex flex-1">
                <Row block={b} current={d.current?.id === b.id} aiActive={d.aiActive} onOpen={() => navigate(canonical(b.to))} />
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Card>
  )
}

function Row({ block: b, current: cur, aiActive, onOpen }: { block: DayBlock; current: boolean; aiActive: boolean; onOpen: () => void }) {
  const past = !cur && endOf(b) <= NOW
  const OwnIcon = iconFor(b.icon)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={cur ? 'time' : undefined}
      className={cn(
        'relative grid flex-1 grid-cols-[62px_44px_minmax(0,1fr)_auto] grid-rows-[auto_auto] items-center gap-x-[10px] gap-y-[3px] rounded-sh-inner px-[10px] py-[6px] text-left transition-colors duration-150',
        cur ? 'bg-(--now-row-bg) shadow-[inset_3px_0_0_var(--accent)]' : 'hover:bg-sh-hover',
      )}
    >
      <span className="row-span-2 self-center">
        <span className={cn('block text-[17px]/[20px] font-semibold tabular-nums', past ? 'text-sh-text-3' : 'text-sh-text')}>{fmtTime(b.at)}</span>
        {b.until && <span className="block text-[11px]/[14px] tabular-nums text-sh-muted">–{fmtTime(b.until)}</span>}
      </span>

      <span
        className={cn(
          'relative row-span-2 inline-flex size-[40px] items-center justify-center justify-self-center rounded-full',
          past && 'bg-sh-inner text-sh-muted',
          cur && 'bg-sh-accent text-sh-accent-ink shadow-sh-glow',
          !past && !cur && 'bg-sh-card text-sh-text shadow-[inset_0_0_0_1.5px_var(--line-strong)]',
        )}
      >
        <Icon icon={past ? Check : OwnIcon} size={18} strokeWidth={cur ? 2 : 1.8} />
      </span>

      <span className={cn('flex min-w-0 items-center gap-[6px] text-[15px]/[20px] font-medium', past ? 'text-sh-text-3' : 'text-sh-text')}>
        <span className="truncate">{b.title}</span>
        {b.ai && aiActive && <Diamond />}
      </span>

      <span className="justify-self-end">
        {cur ? (
          <span className="inline-flex h-[22px] items-center gap-[5px] rounded-full bg-sh-primary pl-[8px] pr-[9px] text-[11px] font-semibold tracking-[0.05em] text-sh-on-primary shdark:bg-sh-accent shdark:text-sh-accent-ink">
            <span className="sh-now-dot size-[5px] rounded-full bg-sh-accent shdark:bg-sh-accent-ink" aria-hidden="true" />
            NOW
          </span>
        ) : (
          <Icon icon={ChevronRight} size={16} className="text-sh-chev" />
        )}
      </span>

      <span className="col-span-2 col-start-3 flex flex-wrap items-center gap-[4px]">
        {chipsOf(b).map((c, i) => (
          <Chip key={i} num={c.num} word={c.word} tone={c.tone} className={past ? 'opacity-70' : undefined} />
        ))}
      </span>
    </button>
  )
}

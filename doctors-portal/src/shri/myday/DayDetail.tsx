/**
 * One date, in detail — drawn inline under the week, and inside the month
 * view's popover (`DayPeek`), so it is one implementation in two places. From
 * the live calendar (`logic/schedule.ts`): the doctor's blocked time, their
 * sessions (a session inside blocked time says so), the patients booked with
 * them — the day's timeline is the Today panel's, which follows the chosen
 * day. A booking of the doctor's own that is still to come can be moved or cancelled here; any date from today on can
 * have time blocked. No AI brief: the calendar shows what is booked, not a
 * summary of it.
 */

import { format } from 'date-fns'
import { Ban, CalendarClock, CalendarX2, PhoneForwarded, Undo2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { useCurrentStaff } from '@/store/session'

import { canonical } from '../app/paths'
import { NOW, fmtMonth, fmtSpan12, fmtTime12 } from '../lib/clock'
import { cn } from '../lib/cn'
import { canChange, rangeLabel, type ShriEntry } from '../logic/schedule'
import { useShri } from '../state/store'
import { iconFor } from '../ui/icons'
import { Icon, Pill, PillTag, RoundButton } from '../ui/primitives'

import type { CalendarDay } from './useMyDay'

/** "Today" / "Earlier" / "Coming up" — the old day panel's three. */
function relation(day: CalendarDay) {
  if (day.isToday) return 'Today'
  return day.date < NOW ? 'Earlier' : 'Coming up'
}

/** "3 sessions · 2 booked" — today's sessions are the day plan's activities (the old `dayCounts`). */
function counts(day: CalendarDay) {
  const s = day.sessions.length
  const b = day.bookings.length
  const what = day.isToday ? (s === 1 ? 'activity' : 'activities') : s === 1 ? 'session' : 'sessions'
  return `${s} ${what} · ${b} booked`
}

export function DayDetail({ day, headerEnd, onLeave, className }: { day: CalendarDay; headerEnd?: ReactNode; onLeave?: () => void; className?: string }) {
  const navigate = useNavigate()
  const me = useCurrentStaff()
  const open = useShri((s) => s.openScheduleDialog)
  const past = day.date < new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate())

  function openEntry(e: ShriEntry) {
    if (!e.to) return
    onLeave?.()
    navigate(canonical(e.to))
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex items-center gap-[12px]">
        <span className="flex size-[52px] shrink-0 flex-col items-center justify-center rounded-[16px] bg-sh-accent text-sh-accent-ink" aria-hidden="true">
          <span className="text-[20px]/[22px] font-semibold tabular-nums">{day.date.getDate()}</span>
          <span className="text-[10px]/[12px] font-medium uppercase tracking-[0.06em]">{format(day.date, 'EEE')}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px]/[20px] font-medium">{fmtMonth(day.date)}</span>
          <span className="block text-[12px]/[16px] text-sh-text-3">{relation(day)}</span>
        </span>
        <LoadMeter level={day.level} critical={day.critical} word={day.levelWord} />
        {headerEnd}
      </div>

      <div className="mt-[12px] flex flex-wrap items-center gap-[6px]">
        <PillTag variant="control" size="sm" className="font-medium">
          {counts(day)}
        </PillTag>
        <span className="text-[12px] font-medium text-sh-text-2">{day.levelWord}</span>
        {!past && (
          <Pill variant="control" size="md" icon={Ban} className="ml-auto" onClick={() => open({ kind: 'block', from: day.iso })}>
            Block time
          </Pill>
        )}
      </div>

      {day.blocks.map((e) => (
        <div key={e.id} className="mt-[10px] flex items-center gap-[10px] rounded-[14px] bg-sh-crit-bg px-[12px] py-[8px] text-sh-crit-fg">
          <Icon icon={Ban} size={16} />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold">Blocked · {e.block!.reason}</span>
            <span className="block text-[12px] tabular-nums opacity-90">
              {rangeLabel(e.block!)}
              {e.block!.note ? ` · ${e.block!.note}` : ''}
            </span>
          </span>
          <Pill variant="card" size="md" icon={Undo2} onClick={() => open({ kind: 'unblock', blockId: e.block!.id })}>
            Unblock
          </Pill>
        </div>
      ))}

      {day.sessions.length + day.bookings.length === 0 ? (
        <p className="mt-[12px] rounded-[14px] bg-sh-inner px-[14px] py-[14px] text-[14px] text-sh-text-2">A clear day — nothing is booked.</p>
      ) : (
        <>

          {day.sessions.length > 0 && (
            <div className="mt-[14px]">
              <p className="mb-[6px] text-[12px] text-sh-text-3">Sessions</p>
              <div className="grid grid-cols-2 gap-[6px]">
                {day.sessions.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => openEntry(e)}
                    className={cn('flex min-h-[44px] items-center gap-[8px] rounded-[14px] bg-sh-inner px-[10px] py-[6px] text-left transition-colors duration-150 hover:bg-sh-hover-strong', e.blocked && 'opacity-60')}
                  >
                    <Icon icon={e.blocked ? Ban : iconFor(e.icon)} size={15} className="shrink-0 text-sh-text-2" />
                    <span className="min-w-0">
                      <span className={cn('block truncate text-[13px]/[16px] font-medium', e.blocked && 'line-through')}>{e.title}</span>
                      <span className="block text-[11px]/[14px] tabular-nums text-sh-muted">
                        {e.until ? fmtSpan12(e.at, e.until) : fmtTime12(e.at)}
                        {e.blocked ? ' · blocked' : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {day.bookings.length > 0 && (
            <div className="mt-[14px]">
              <p className="mb-[4px] text-[12px] text-sh-text-3">Booked with you</p>
              <ul className="flex flex-col" aria-label={`Booked with you on ${format(day.date, 'EEEE d MMMM')}`}>
                {day.bookings.map((e) => {
                  const a = e.appointment!
                  const mine = canChange(a, me.name)
                  return (
                    // 8px between the 36px buttons, so each keeps a 44px target of its own.
                    <li key={e.id} className={cn('flex items-center gap-[8px]', e.done && 'opacity-60')}>
                      <Link to={canonical(e.to ?? '/')} onClick={onLeave} className="flex min-h-[44px] min-w-0 flex-1 items-center gap-[10px] rounded-[12px] px-[6px] py-[4px] transition-colors duration-150 hover:bg-sh-hover">
                        <span className="inline-flex size-[32px] shrink-0 items-center justify-center rounded-full bg-sh-inner text-sh-text-2">
                          <Icon icon={iconFor(e.icon)} size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]/[16px] font-medium">{e.title}</span>
                          <span className="block truncate text-[11px]/[14px] text-sh-text-3">{e.detail}</span>
                        </span>
                        {a.rebooking ? (
                          <PillTag tone="warn" size="xs" icon={PhoneForwarded} className="font-semibold">
                            Front office rebooking
                          </PillTag>
                        ) : (
                          <PillTag variant="primary" size="xs" className="font-semibold tabular-nums">
                            {fmtTime12(e.at)}
                          </PillTag>
                        )}
                      </Link>
                      {mine && !a.rebooking && (
                        <>
                          <RoundButton icon={CalendarClock} size={36} iconSize={15} label={`Move ${e.title}'s appointment`} onClick={() => open({ kind: 'move', appointmentId: a.id })} />
                          <RoundButton icon={CalendarX2} size={36} iconSize={15} label={`Cancel ${e.title}'s appointment`} onClick={() => open({ kind: 'cancel', appointmentId: a.id })} />
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 3 bars 8/14/20px tall; filled = level; the last filled bar is red on a critical day. */
export function LoadMeter({ level, critical, word }: { level: number; critical: boolean; word: string }) {
  return (
    <span className="inline-flex h-[20px] shrink-0 items-end gap-[3px]" role="img" aria-label={`Load: ${word}`} title={word}>
      {[8, 14, 20].map((h, i) => {
        const filled = i < level
        const last = filled && i === level - 1
        return <span key={h} className={cn('w-[5px] rounded-[2px]', filled ? (last && critical ? 'bg-sh-crit' : 'bg-sh-accent') : 'bg-sh-line-strong')} style={{ height: h }} />
      })}
    </span>
  )
}

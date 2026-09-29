/**
 * S-05-05 · Blocks and leave — `/schedule/blocks` (`src/screens/m05/
 * S0505.tsx`): "Leave, blocks and one-off overrides."
 *
 * What makes it clinical rather than administrative is what happens to the
 * patients already booked: blocking time does not cancel them, it surfaces
 * them, and each one goes where the doctor chooses before anything is done
 * (`ScheduleDialogs` → Block time). The old screen drew a fixed week and a
 * fixed list of "booked" patients; this one is the doctor's live calendar —
 * the same blocks, sessions and bookings My Day's calendar shows — with the
 * blocks they have set and a way to lift each one. The front office is told
 * of every block and every unblock.
 */

import { format } from 'date-fns'
import { Ban, ChevronLeft, ChevronRight, Phone, Stethoscope, Syringe, Undo2, type LucideIcon } from 'lucide-react'

import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { NOW } from '../lib/clock'
import { dayIso, rangeLabel } from '../logic/schedule'
import { useCalendarWeek } from '../myday/useCalendarWeek'
import { useSchedule } from '../state/schedule'
import { useShri } from '../state/store'
import { Why } from '../ui/Disclosure'
import { EmptyState } from '../ui/EmptyState'
import { Card, Diamond, Icon, Pill, PillTag, RoundButton } from '../ui/primitives'

const SESSION_ICON: Record<string, LucideIcon> = { OPD: Stethoscope, 'Theatre list': Syringe, 'On call': Phone }

export function BlocksPage() {
  const open = useShri((s) => s.openScheduleDialog)
  const goWeek = useShri((s) => s.goWeek)
  const goToday = useShri((s) => s.goToday)
  const blocks = useSchedule((s) => s.blocks)
  const week = useCalendarWeek()
  const today = dayIso(NOW)
  const upcoming = [...blocks].filter((b) => b.to >= today).sort((a, b) => a.from.localeCompare(b.from))
  const todaysDay = week.find((d) => d.isToday)
  const sessionsToday = todaysDay?.sessions.length ?? 0
  const blockedToday = upcoming.filter((b) => b.from <= today && today <= b.to).length
  const blockedThisWeek = week.filter((d) => d.blocks.length > 0).length

  return (
    <ScreenFrame
      screenId="S-05-05"
      heading="Blocks and leave"
      sub={[`${sessionsToday} sessions today`, blockedToday > 0 && `${blockedToday} blocked today`, blockedThisWeek > 0 && `${blockedThisWeek} blocked this week`].filter(Boolean).join(' · ')}
      actions={
        <Pill variant="primary" size="xl" icon={Ban} onClick={() => open({ kind: 'block' })}>
          Block time
        </Pill>
      }
      rail={
        <Card titleSize="sm" title={<span className="inline-flex items-center gap-[8px]"><Diamond />AI-608 · cover suggestions</span>}>
          <p className="text-[13px] text-sh-text-2">Where a colleague has spare capacity in the same speciality on the same day, it is proposed as cover. It suggests; the rota owner decides.</p>
        </Card>
      }
      railTitle="Cover"
    >
      <div className="flex max-w-[1040px] flex-col gap-[16px]">
        <Card titleSize="sm" title="Your blocked time">
          {upcoming.length === 0 ? (
            <EmptyState compact icon={Ban} why="Nothing is blocked. Block time here, or from any day on My Day's calendar." />
          ) : (
            <ul aria-label="Your blocked time" className="flex flex-col gap-[8px]">
              {upcoming.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-[12px] rounded-[14px] bg-sh-inner px-[14px] py-[10px]">
                  <Icon icon={Ban} size={16} className="text-sh-crit-fg" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium tabular-nums">{rangeLabel(b)}</span>
                    <span className="block text-[12px] text-sh-text-3">
                      {b.reason}
                      {b.note ? ` · ${b.note}` : ''} · set by {b.by}
                    </span>
                  </span>
                  <Pill variant="control" size="lg" icon={Undo2} onClick={() => open({ kind: 'unblock', blockId: b.id })} aria-label={`Unblock ${rangeLabel(b)}`}>
                    Unblock
                  </Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          titleSize="sm"
          title={`Week of ${format(week[0].date, 'd MMM')}`}
          right={
            <span className="flex items-center gap-[10px]">
              {!week.some((d) => d.isToday) && (
                <Pill variant="primary" size="sm" onClick={goToday}>
                  This week
                </Pill>
              )}
              <RoundButton icon={ChevronLeft} size={34} iconSize={17} label="Previous week" onClick={() => goWeek(-1)} />
              <RoundButton icon={ChevronRight} size={34} iconSize={17} label="Next week" onClick={() => goWeek(1)} />
            </span>
          }
        >
          <ol aria-label="This week's sessions" className="grid grid-cols-1 gap-[8px] sm:grid-cols-2 md:grid-cols-4 xl:grid-cols-7">
            {week.map((d) => (
              <li key={d.iso} className={cn('flex flex-col gap-[6px] rounded-[14px] bg-sh-inner p-[10px]', d.isToday && 'inset-ring-2 inset-ring-(--accent)')}>
                <p className="flex items-center justify-between text-[12px] font-semibold uppercase tracking-[0.06em] text-sh-text-2">
                  {format(d.date, 'EEE d')}
                  {d.blocks.length > 0 && <Icon icon={Ban} size={12} className="text-sh-crit-fg" />}
                </p>
                {d.blocks.map((e) => (
                  <PillTag key={e.id} tone="crit" size="xs" icon={Ban} className="justify-start">
                    {e.block!.allDay ? 'All day' : `${e.block!.start}–${e.block!.end}`} · {e.block!.reason}
                  </PillTag>
                ))}
                {d.sessions.length === 0 && d.blocks.length === 0 && <p className="text-[12px] text-sh-text-3">—</p>}
                {d.sessions.map((e) => (
                  <span key={e.id} className={cn('flex items-start gap-[6px] text-[12px]', e.blocked ? 'text-sh-text-3 line-through' : 'text-sh-text')}>
                    <Icon icon={SESSION_ICON[e.title] ?? Stethoscope} size={12} className="mt-[2px] shrink-0 text-sh-text-3" />
                    <span className="min-w-0">
                      <span className="block tabular-nums">
                        {format(e.at, 'HH:mm')}
                        {e.until ? `–${format(e.until, 'HH:mm')}` : ''}
                      </span>
                      <span className="block truncate text-sh-text-2" title={e.title}>
                        {e.title}
                      </span>
                    </span>
                  </span>
                ))}
                {d.bookings.length > 0 && <p className="text-[12px] tabular-nums text-sh-text-2">{d.bookings.length} booked</p>}
                {d.date >= new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()) && (
                  <Pill variant="card" size="sm" icon={Ban} className="mt-auto self-start" onClick={() => open({ kind: 'block', from: d.iso })} aria-label={`Block ${format(d.date, 'EEEE d MMMM')}`}>
                    Block
                  </Pill>
                )}
              </li>
            ))}
          </ol>
        </Card>

        <Why label="Why a block surfaces patients, and who may set one">
          <p>
            Blocking a session does not cancel the patients already booked into it. They are listed before you confirm, not after, and each one moves where you choose — they are
            told the appointment has moved, not why.
          </p>
          <p>A block inside 14 days needs an administrator&rsquo;s override, because patients are already booked. Beyond 14 days it is yours to set.</p>
          <p className="text-sh-text-3">Approved by the medical superintendent for anything shorter.</p>
        </Why>
      </div>
    </ScreenFrame>
  )
}

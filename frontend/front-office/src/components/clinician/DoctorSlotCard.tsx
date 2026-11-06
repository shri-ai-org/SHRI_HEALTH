import { useState } from 'react'
import type { ReactNode } from 'react'
import { Check, MapPin, Sparkles } from 'lucide-react'
import { Avatar } from '../ui/Avatar'
import { Badge } from '../ui/Badge'
import { DoctorDayChart } from './DoctorDayChart'
import { cn } from '../../utils/cn'
import { formatRupees } from '../../utils/billing'
import { relativeDayLabel, shortDayLabel } from '../../utils/dates'
import { modesFor } from '../../utils/appointment'
import { initialsOf } from '../../utils/format'
import { useStoreValue } from '../../hooks/useStore'
import { addDaysToKey, getDoctorDateStrip } from '../../domain/selectors'
import type { DoctorSuggestion } from '../../domain/selectors'
import { dayStartTimestamp, formatTime } from '../../domain/time'

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * One doctor and their day, in one card — Doctor's Availability in the
 * booking page, and each row of the Doctors directory. The doctor (name,
 * Soonest tag, specialty, department, fee, room, next free time) sits on
 * top; tapping it takes their earliest time. Below, the doctor's own days as
 * small tabs and the chosen day as the clinicians' Dashboard chart: tapping
 * free time on it picks that slot. A doctor with no open time is greyed with
 * the reason.
 */
export function DoctorSlotCard({
  suggestion,
  today,
  now,
  soonest,
  selectedDate,
  selectedSlot,
  onPick,
  onOpen,
  wide = false,
  sharedDay,
  sharedRange,
  currentAppointmentId,
  children,
}: {
  suggestion: DoctorSuggestion
  today: string
  now: number
  /** The department's soonest doctor — tagged. */
  soonest: boolean
  /** The booking's date and time when this doctor is the chosen one. */
  selectedDate: string | null
  selectedSlot: string | null
  onPick: (providerId: string, date: string, slot: string) => void
  /** The directory: the doctor opens their profile instead of taking the
   *  earliest time. */
  onOpen?: (providerId: string) => void
  /** A long row where there is room: the doctor on the left, their days
   *  and times on the right (stacked again when the row is narrow). */
  wide?: boolean
  /** The booking page: one date and one time axis for every doctor, shown
   *  above the list — the card then has no day tabs or hours of its own. */
  sharedDay?: string
  sharedRange?: [number, number]
  /** Rescheduling: the booking being moved, marked on its doctor's chart. */
  currentAppointmentId?: string
  /** Extra controls under the doctor, for the chosen one (how they're seen). */
  children?: ReactNode
}) {
  const { provider, bookable, nextSlots, reason } = suggestion
  const chosen = Boolean(selectedSlot)
  const next = nextSlots[0] ?? null
  const strip = useStoreValue(getDoctorDateStrip, provider.providerId, now)
  const firstOpen = strip.find((d) => d.state === 'open')?.date ?? null
  const [ownDay, setOwnDay] = useState<string | null>(null)
  const shownDay = sharedDay ?? ownDay ?? (chosen ? selectedDate : null) ?? firstOpen ?? today
  const modes = modesFor(provider)
  const tomorrow = addDaysToKey(today, 1)

  return (
    <article
      aria-label={provider.name}
      className={cn(
        '@container h-full rounded-2xl border bg-surface-1 transition-[border-color,box-shadow] duration-200',
        chosen
          ? 'border-primary-600/70 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-primary-500)_14%,transparent)]'
          : 'border-border-soft shadow-card-sm',
        !bookable && 'opacity-60',
      )}
    >
      <div className={cn('flex h-full flex-col', wide && '@3xl:flex-row')}>
        <div className={cn('flex flex-col', wide && '@3xl:w-72 @3xl:shrink-0 @3xl:border-r @3xl:border-border-soft')}>
          {/* The doctor — tapping takes their earliest time (or, in the
              directory, opens their profile). */}
          <button
            type="button"
            disabled={onOpen ? false : !bookable || !next}
            onClick={() => {
              if (onOpen) onOpen(provider.providerId)
              else if (next) {
                setOwnDay(next.date)
                onPick(provider.providerId, next.date, next.slot)
              }
            }}
            aria-label={
              onOpen
                ? `${provider.name}, ${provider.specialty}, ${formatRupees(provider.consultationFee)} — open profile`
                : `${provider.name}, ${provider.specialty}, ${formatRupees(provider.consultationFee)}${
                    next ? ` — take the earliest time, ${relativeDayLabel(next.date, today)} ${formatTime(next.slot)}` : ''
                  }`
            }
            className={cn(
              'focus-ring flex w-full items-start gap-3 rounded-t-2xl px-3.5 pb-3 pt-3.5 text-left sm:px-4',
              wide && '@3xl:rounded-tr-none',
              (onOpen || (bookable && !chosen)) && 'hover:bg-surface-2/60',
              !onOpen && !bookable && 'cursor-not-allowed',
            )}
          >
            <Avatar name={provider.name} initials={initialsOf(provider.name)} size="md" />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-semibold text-ink">{provider.name}</span>
                {currentAppointmentId ? (
                  <Badge tone="info" size="xs">
                    Current
                  </Badge>
                ) : null}
                {soonest && bookable ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-success-bg px-1.5 py-0.5 text-2xs font-semibold text-success-fg">
                    <Sparkles size={11} aria-hidden="true" />
                    Soonest
                  </span>
                ) : null}
                {modes.includes('Teleconsult') ? (
                  <Badge tone="purple" size="xs">
                    {modes.length === 1 ? 'Teleconsult only' : 'Teleconsult'}
                  </Badge>
                ) : null}
              </span>
              <span className="mt-0.5 block text-xs text-ink-muted">
                {provider.specialty} · <span className="font-semibold tabular-nums text-ink">{formatRupees(provider.consultationFee)}</span>
              </span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-ink-subtle">
                <span>{provider.department}</span>
                {provider.room ? (
                  <span className="inline-flex items-center gap-1">
                    <MapPin size={12} aria-hidden="true" className="shrink-0" />
                    {provider.room}
                  </span>
                ) : null}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1.5">
              {chosen ? (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[image:var(--gradient-primary)] text-on-primary shadow-card-sm" aria-hidden="true">
                  <Check size={14} strokeWidth={3} />
                </span>
              ) : null}
              {/* Why a doctor can't be booked (on leave, not scheduled …) — the chart shows the free times. */}
              {bookable ? null : (
                <span className={cn('hidden rounded-md bg-surface-2 px-1.5 py-0.5 text-right text-xs font-semibold text-ink-subtle @md:inline-block', wide && '@3xl:hidden')}>
                  {reason}
                </span>
              )}
            </span>
          </button>
          {/* Phones (and the wide row): why the doctor can't be booked, on its own line. */}
          {bookable ? null : (
            <p className={cn('mx-3.5 -mt-1.5 mb-3 self-start rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-semibold text-ink-subtle @md:hidden', wide && '@3xl:ml-[4.25rem] @3xl:block sm:mx-4')}>
              {reason}
            </p>
          )}
        </div>

        {bookable ? (
          <div className={cn('flex min-w-0 flex-col gap-3 border-t border-border-soft px-3.5 pb-3.5 pt-3 sm:px-4', wide && '@3xl:flex-1 @3xl:border-t-0 @3xl:pt-3.5')}>
            {children}
            {/* The doctor's days. Every day can be shown: the chart says why one can't be booked. */}
            {sharedDay ? null : (
            <div className="scrollbar-hide scroll-fade-x -mx-1 -my-0.5 flex gap-1.5 overflow-x-auto overflow-y-hidden px-1 py-1" role="group" aria-label={`${provider.name} — day`}>
              {strip.map((d) => {
                const open = d.state === 'open'
                const active = d.date === shownDay
                const date = new Date(dayStartTimestamp(d.date))
                const label = d.date === today ? 'Today' : d.date === tomorrow ? 'Tmrw' : `${WEEKDAY[date.getDay()]} ${date.getDate()}`
                const note = open ? String(d.open) : d.state === 'full' ? 'Full' : d.state === 'leave' ? 'Leave' : 'Off'
                return (
                  <button
                    key={d.date}
                    type="button"
                    aria-pressed={active}
                    aria-label={`${label === 'Tmrw' ? 'Tomorrow' : label}, ${open ? `${d.open} available` : d.state === 'full' ? 'fully booked' : d.state === 'leave' ? 'on leave' : 'not working'}`}
                    onClick={() => setOwnDay(d.date)}
                    className={cn(
                      'focus-ring tap-reach inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-semibold transition-colors',
                      active
                        ? 'border-ink bg-ink text-surface-1'
                        : open
                          ? 'border-border-soft bg-surface-1 text-ink hover:border-border-strong'
                          : 'border-transparent bg-surface-2 text-ink-subtle hover:border-border-soft',
                    )}
                  >
                    {label}
                    <span
                      className={cn(
                        'rounded-full px-1.5 text-2xs font-semibold tabular-nums',
                        active ? 'bg-surface-1/20' : open ? 'bg-[color-mix(in_oklab,var(--color-hue-blue)_14%,var(--color-surface-1))] text-[color-mix(in_oklab,var(--color-hue-blue)_var(--tone-ink-amount),var(--tone-ink-mix))]' : '',
                      )}
                    >
                      {note}
                    </span>
                  </button>
                )
              })}
            </div>
            )}

            {/* That day as the clinicians' Dashboard chart: tap free time to book it. */}
            <DoctorDayChart
              providerId={provider.providerId}
              date={shownDay}
              now={now}
              sharedRange={sharedRange}
              currentAppointmentId={currentAppointmentId}
              onPick={(date, slot) => {
                setOwnDay(date)
                onPick(provider.providerId, date, slot)
              }}
            />
            {chosen && selectedDate && selectedSlot ? (
              <p className="text-sm text-ink" aria-live="polite">
                Chosen: <span className="font-semibold tabular-nums">{shortDayLabel(selectedDate)}, {formatTime(selectedSlot)}</span>.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  )
}

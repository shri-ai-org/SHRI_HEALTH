import type { ReactNode } from 'react'
import { Check, MapPin, Sparkles } from 'lucide-react'
import { Avatar } from '../ui/Avatar'
import { Badge } from '../ui/Badge'
import { ModeBadge } from '../appointment/ModeBadge'
import { cn } from '../../utils/cn'
import { formatRupees } from '../../utils/billing'
import { relativeDayLabel } from '../../utils/dates'
import { modesFor } from '../../utils/appointment'
import { initialsOf } from '../../utils/format'
import type { DoctorSuggestion } from '../../domain/selectors'
import { formatTime } from '../../domain/time'

/**
 * A department's doctors to choose from, soonest-free first. Each card says
 * who (specialty, room), what it costs and when they are next free; the
 * soonest one carries a "Soonest" tag as a suggestion only — nothing is
 * chosen until the desk taps a doctor. A doctor with no open time is shown,
 * greyed, with why, and can't be chosen.
 */
export function DoctorChoiceList({
  suggestions,
  selectedId,
  onChoose,
  today,
  marker,
  note,
}: {
  suggestions: DoctorSuggestion[]
  selectedId: string | null
  onChoose: (providerId: string) => void
  today: string
  /** A badge beside the name — "Current" in a reschedule. */
  marker?: (suggestion: DoctorSuggestion) => ReactNode
  /** A line under the details — the fee difference in a reschedule. */
  note?: (suggestion: DoctorSuggestion) => ReactNode
}) {
  if (suggestions.length === 0) return <p className="text-sm text-ink-muted">No doctors in this department.</p>
  const soonestId = suggestions.find((s) => s.bookable)?.provider.providerId ?? null
  return (
    <ul className="flex flex-col gap-2" aria-label="Doctors">
      {suggestions.map((s) => {
        const modes = modesFor(s.provider)
        const next = s.nextSlots[0]
        const selected = s.provider.providerId === selectedId
        const choosable = s.bookable
        const soonest = s.provider.providerId === soonestId
        return (
          <li key={s.provider.providerId}>
            <button
              type="button"
              disabled={!choosable}
              aria-pressed={choosable ? selected : undefined}
              onClick={() => onChoose(s.provider.providerId)}
              className={cn(
                'focus-ring group relative flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-all duration-200',
                selected
                  ? 'border-primary-600 bg-primary-50 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-primary-500)_16%,transparent)]'
                  : 'border-border-soft bg-surface-1 shadow-card-sm hover:-translate-y-0.5 hover:border-border-strong hover:shadow-card-md',
                !choosable && 'cursor-not-allowed opacity-55 hover:translate-y-0 hover:border-border-soft hover:shadow-card-sm',
              )}
            >
              <Avatar name={s.provider.name} initials={initialsOf(s.provider.name)} size="md" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
                  {s.provider.name}
                  {soonest && choosable ? (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-success-bg px-1.5 py-0.5 text-2xs font-semibold text-success-fg">
                      <Sparkles size={11} aria-hidden="true" />
                      Soonest
                    </span>
                  ) : null}
                  {marker?.(s)}
                  {modes.includes('Teleconsult') ? (
                    modes.length === 1 ? <Badge tone="purple" size="xs">Teleconsult only</Badge> : <ModeBadge mode="Teleconsult" />
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-ink-muted">
                  {s.provider.specialty} · <span className="font-semibold tabular-nums text-ink">{formatRupees(s.provider.consultationFee)}</span>
                </span>
                {s.provider.room ? (
                  <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-ink-subtle">
                    <MapPin size={12} aria-hidden="true" className="shrink-0" />
                    {s.provider.room}
                  </span>
                ) : null}
                <span className={cn('mt-1.5 inline-flex rounded-md px-1.5 py-0.5 text-xs font-semibold', choosable ? 'bg-info-bg text-info-fg' : 'bg-surface-2 text-ink-subtle')}>
                  {choosable && next ? `Earliest slot · ${relativeDayLabel(next.date, today)}, ${formatTime(next.slot)}` : s.reason}
                </span>
                {note?.(s)}
              </span>
              {selected ? (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[image:var(--gradient-primary)] text-on-primary shadow-card-sm" aria-hidden="true">
                  <Check size={14} strokeWidth={3} />
                </span>
              ) : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

import { useMemo, useState } from 'react'
import type { CSSProperties, ElementType } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutGrid, Search, UserRoundPlus } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { DoctorIllustration } from '../components/ui/illustrations/DoctorIllustration'
import { Button } from '../components/ui/Button'
import { SoftIconTile } from '../components/ui/IconTile'
import { DoctorSlotCard } from '../components/clinician/DoctorSlotCard'
import { useStoreValue } from '../hooks/useStore'
import { useNow } from '../hooks/useNow'
import { useFlow } from '../flows/useFlow'
import { addDaysToKey, compareDepartments, getDirectorySuggestions, getDoctorRows, getToday } from '../domain/selectors'
import { getDoctorsDateStrip, getDoctorsDayRange } from '../domain/doctorDaySelectors'
import { DayTimelineAxis, DayTimelineLegend } from '../components/dayTimeline/DayTimeline'
import { dayStartTimestamp } from '../domain/time'
import type { DoctorSuggestion } from '../domain/selectors'
import { departmentIcon, departmentTone } from '../utils/departments'
import { TONE_HEX } from '../utils/toneHex'
import type { IconTone } from '../utils/toneHex'
import { cn } from '../utils/cn'
import type { DoctorRow } from '../types/doctor'

const AVAILABILITY_FILTERS = ['All', 'Bookable now', 'Available', 'Fully booked', 'Unavailable'] as const
type AvailabilityFilter = (typeof AVAILABILITY_FILTERS)[number]

const ALL = 'All specialities'

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Minutes after midnight, for the shared axis's Now label. */
function minutesOfDay(timestamp: number): number {
  const d = new Date(timestamp)
  return d.getHours() * 60 + d.getMinutes()
}

function matchesAvailability(row: DoctorRow | undefined, filter: AvailabilityFilter): boolean {
  if (filter === 'All') return true
  if (!row) return false
  if (filter === 'Bookable now') return Boolean(row.nextSlot)
  if (filter === 'Available') return row.status === 'Available'
  if (filter === 'Fully booked') return row.status === 'Fully booked'
  return ['On leave', 'Not scheduled', 'Inactive'].includes(row.status)
}

/**
 * Doctors — every doctor as the booking page shows them: who they are, their
 * fee and room, and their own days and open times. Classified by speciality
 * (one section per department, or one at a time from the chips), searchable,
 * and filtered by availability. Tapping a time starts booking it for a
 * patient; tapping the doctor opens their profile.
 */
export function DoctorDirectoryPage() {
  const navigate = useNavigate()
  const now = useNow(30000)
  const today = useStoreValue(getToday)
  const { openFlow } = useFlow()

  const [query, setQuery] = useState('')
  const [speciality, setSpeciality] = useState(ALL)
  const [availability, setAvailability] = useState<AvailabilityFilter>('All')

  const doctors = useStoreValue(getDirectorySuggestions, now)
  const rows = useStoreValue(getDoctorRows, now)

  // Search and availability narrow everyone; the speciality chips then
  // count and pick from what is left.
  const matching = useMemo(() => {
    const byId = new Map(rows.map((row) => [row.provider.providerId, row]))
    const term = query.trim().toLowerCase()
    return doctors.filter(({ provider }) => {
      const matchesTerm =
        !term ||
        provider.name.toLowerCase().includes(term) ||
        provider.specialty.toLowerCase().includes(term) ||
        provider.department.toLowerCase().includes(term)
      return matchesTerm && matchesAvailability(byId.get(provider.providerId), availability)
    })
  }, [doctors, rows, query, availability])

  const groups = useMemo(() => {
    const map = new Map<string, DoctorSuggestion[]>()
    for (const doctor of matching) {
      const list = map.get(doctor.provider.department) ?? []
      list.push(doctor)
      map.set(doctor.provider.department, list)
    }
    return [...map.entries()].sort((a, b) => compareDepartments(a[0], b[0]))
  }, [matching])

  const departments = useMemo(() => [...new Set(doctors.map((d) => d.provider.department))].sort(compareDepartments), [doctors])
  const shown = speciality === ALL ? groups : groups.filter(([department]) => department === speciality)
  const shownCount = shown.reduce((sum, [, list]) => sum + list.length, 0)
  const countOf = (department: string) => groups.find(([d]) => d === department)?.[1].length ?? 0

  // One day and one time axis for every doctor shown, pinned while the doctors scroll under it.
  const shownIds = useMemo(() => shown.flatMap(([, list]) => list.map((d) => d.provider.providerId)), [shown])
  const [dayChoice, setDayChoice] = useState<string | null>(null)
  const days = useStoreValue(getDoctorsDateStrip, shownIds, now)
  const day = dayChoice ?? days.find((d) => d.open > 0)?.date ?? today
  const range = useStoreValue(getDoctorsDayRange, shownIds, now, day)

  function book(providerId: string, date: string, slot: string) {
    openFlow('schedule', { doctor: providerId, date, slot })
  }

  return (
    <div>
      <PageHeader
        title="Doctors"
        illustration={<DoctorIllustration className="h-8 w-8" />}
        illustrationTone="indigo"
        actions={
          <Button size="sm" onClick={() => navigate('/doctors/register')}>
            <UserRoundPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
            Register doctor
          </Button>
        }
      />

      {/* Find and narrow. */}
      <div className="surface-raised mt-4 flex flex-col gap-3 rounded-xl border border-border-soft bg-surface-1 p-3 sm:mt-5 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border-soft bg-surface-1 px-3 transition-colors focus-within:border-primary-600 focus-within:ring-4 focus-within:ring-primary-600/10 hover:border-border-strong">
            <Search className="h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.75} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search doctor, speciality or department"
              aria-label="Search doctors"
              className="min-h-11 w-full min-w-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
            />
          </div>
          <div className="scrollbar-hide scroll-fade-x -mx-1 -my-1 flex gap-1.5 overflow-x-auto overflow-y-hidden px-1 py-1 lg:mx-0 lg:px-0" role="group" aria-label="Availability">
            {AVAILABILITY_FILTERS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={availability === option}
                onClick={() => setAvailability(option)}
                className={cn(
                  'focus-ring tap-reach inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full border px-3 text-xs font-semibold transition-colors',
                  availability === option
                    ? 'border-transparent bg-[image:var(--gradient-primary)] text-on-primary shadow-card-sm'
                    : 'border-border-soft bg-surface-1 text-ink-muted hover:border-border-strong hover:text-ink',
                )}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        {/* Classified by speciality. */}
        <div className="flex flex-col gap-1.5 border-t border-border-soft pt-3">
          <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-subtle">By speciality</p>
          <div className="scrollbar-hide scroll-fade-x -mx-1 -my-1 flex gap-1.5 overflow-x-auto overflow-y-hidden px-1 py-1 sm:flex-wrap sm:overflow-visible" role="group" aria-label="Speciality">
            <SpecialityChip label="All" count={matching.length} icon={LayoutGrid} hue="blue" active={speciality === ALL} onClick={() => setSpeciality(ALL)} />
            {departments.map((department) => (
              <SpecialityChip
                key={department}
                label={department}
                count={countOf(department)}
                icon={departmentIcon(department)}
                hue={departmentTone(department)}
                active={speciality === department}
                onClick={() => setSpeciality(department)}
              />
            ))}
          </div>
        </div>
      </div>

      <p className="mt-4 text-xs text-ink-muted" aria-live="polite">
        {shownCount} of {doctors.length} doctors{speciality === ALL ? '' : ` · ${speciality}`}
      </p>

      {/* The date and the time axis stay put; only the doctors' rows scroll under them. */}
      {shownIds.length > 0 ? (
        <div className="sticky top-0 z-20 mt-2 flex flex-col gap-1 rounded-xl border border-border-soft bg-surface-1 pb-1 pt-2 shadow-card-sm">
          <div className="scrollbar-hide scroll-fade-x flex gap-1.5 overflow-x-auto overflow-y-hidden px-3.5 py-1 sm:px-4" role="group" aria-label="Day">
            {days.map((d) => {
              const active = d.date === day
              const dt = new Date(dayStartTimestamp(d.date))
              const label = d.date === today ? 'Today' : d.date === addDaysToKey(today, 1) ? 'Tmrw' : `${WEEKDAY_SHORT[dt.getDay()]} ${dt.getDate()}`
              return (
                <button
                  key={d.date}
                  type="button"
                  aria-pressed={active}
                  aria-label={`${label === 'Tmrw' ? 'Tomorrow' : label}, ${d.open} open times`}
                  onClick={() => setDayChoice(d.date)}
                  className={cn(
                    'focus-ring tap-reach inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-semibold transition-colors',
                    active
                      ? 'border-ink bg-ink text-surface-1'
                      : d.open > 0
                        ? 'border-border-soft bg-surface-1 text-ink hover:border-border-strong'
                        : 'border-transparent bg-surface-2 text-ink-subtle hover:border-border-soft',
                  )}
                >
                  {label}
                  <span
                    className={cn(
                      'rounded-full px-1.5 text-2xs font-semibold tabular-nums',
                      active ? 'bg-surface-1/20' : d.open > 0 ? 'bg-[color-mix(in_oklab,var(--color-hue-blue)_14%,var(--color-surface-1))] text-[color-mix(in_oklab,var(--color-hue-blue)_var(--tone-ink-amount),var(--tone-ink-mix))]' : '',
                    )}
                  >
                    {d.open > 0 ? d.open : 'Full'}
                  </span>
                </button>
              )
            })}
          </div>
          {/* Lined up with the charts inside the cards: this bar's border stands in for theirs. */}
          <div className="@container relative">
            <div className="px-3.5 pt-1 sm:px-4 @3xl:absolute @3xl:bottom-2 @3xl:left-0 @3xl:w-[18rem] @3xl:pt-0">
              <DayTimelineLegend />
            </div>
            <div className="px-3.5 sm:px-4 @3xl:pl-[calc(18rem+1rem)]">
              <DayTimelineAxis range={range} now={day === today ? minutesOfDay(now) : null} />
            </div>
          </div>
        </div>
      ) : null}

      {/* One section per speciality. */}
      <div className="mt-3 flex flex-col gap-6">
        {shown.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border-soft px-4 py-10 text-center text-sm text-ink-subtle">
            No doctors match
          </p>
        ) : (
          shown.map(([department, list]) => {
            const bookable = list.filter((d) => d.bookable).length
            return (
              <section key={department} aria-label={department}>
                <header className="mb-3 flex items-center gap-3">
                  <SoftIconTile icon={departmentIcon(department)} tone={departmentTone(department)} size="md" />
                  <div className="min-w-0">
                    <h2 className="text-base font-bold tracking-tight text-ink">{department}</h2>
                    <p className="text-xs text-ink-muted">
                      {list.length} {list.length === 1 ? 'doctor' : 'doctors'} · {bookable} with open times
                    </p>
                  </div>
                </header>
                {/* The speciality's doctors one below the other, each a long
                    row — who on the left, their days and times on the right. */}
                <ul aria-label={`${department} doctors`} className="flex flex-col gap-3">
                  {list.map((doctor, index) => (
                    <li key={doctor.provider.providerId} className="min-w-0">
                      <DoctorSlotCard
                        suggestion={doctor}
                        today={today}
                        now={now}
                        soonest={index === 0 && doctor.bookable}
                        selectedDate={null}
                        selectedSlot={null}
                        onPick={book}
                        onOpen={(providerId) => navigate(`/doctors/${providerId}`)}
                        sharedDay={day}
                        sharedRange={range}
                        wide
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )
          })
        )}
      </div>
    </div>
  )
}

function SpecialityChip({
  label,
  count,
  icon: Icon,
  hue,
  active,
  onClick,
}: {
  label: string
  count: number
  icon: ElementType
  hue: IconTone
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'focus-ring tap-reach inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border pl-2 pr-2.5 text-xs font-semibold transition-colors',
        active ? 'border-ink bg-ink text-surface-1' : 'border-border-soft bg-surface-1 text-ink hover:border-border-strong',
      )}
    >
      <Icon size={14} strokeWidth={2} aria-hidden="true" style={active ? undefined : { color: TONE_HEX[hue] }} />
      {label}
      <span
        style={active ? undefined : ({ '--tone': TONE_HEX[hue] } as CSSProperties)}
        className={cn('rounded-full px-1.5 text-2xs tabular-nums', active ? 'bg-surface-1/20' : 'ink-tone bg-[color-mix(in_oklab,var(--tone)_14%,var(--color-surface-1))]')}
      >
        {count}
      </span>
    </button>
  )
}

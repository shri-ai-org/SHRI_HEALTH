import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarCheck2 } from 'lucide-react'
import { DayTimeline, DayTimelineKey } from '../dayTimeline/DayTimeline'
import { clock12, dayModel, minutesFrom, time12 } from '../dayTimeline/dayModel'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { useStoreValue } from '../../hooks/useStore'
import { getState } from '../../domain/store'
import { getProviderById, getToday } from '../../domain/selectors'
import type { FreeSlot } from '../../domain/selectors'
import { getDoctorDay, getDoctorNextPatient, getNextFreeSlotFrom } from '../../domain/doctorDaySelectors'
import type { DoctorDay } from '../../domain/doctorDaySelectors'
import { dayStartTimestamp, formatTime } from '../../domain/time'
import { relativeDayLabel } from '../../utils/dates'

/** What a tap on time that can't be booked says, and what it offers instead. */
interface Notice {
  title: string
  text: string
  /** The doctor's next free time, to book instead. */
  book: FreeSlot | null
  /** Leave is managed on the doctor's profile. */
  profile: boolean
}

/** "Wednesday 15 October". */
function longDate(date: string): string {
  return new Date(dayStartTimestamp(date)).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}

/** The free slot a tap at `at` books: the slot under it, or — where that one
 *  has started or is a break — the next free slot in the same free stretch. */
function slotForTap(day: DoctorDay, at: number, until: number): string | null {
  const under = day.board.find((e) => minutesFrom(e.slot) <= at && at < minutesFrom(e.slot) + day.slotMinutes)
  if (under?.status === 'available') return under.slot
  return day.board.find((e) => e.status === 'available' && minutesFrom(e.slot) > at && minutesFrom(e.slot) < until)?.slot ?? null
}

/**
 * One doctor's day as the clinicians' Dashboard chart (components/dayTimeline),
 * with its key — on every screen that lists doctors. Tapping free time books
 * the slot under the pointer, as tapping a time does (`onPick`); leave
 * explains itself in a small dialog; a booked bar opens its patient. Only the
 * doctor's working hours are drawn — breaks and leave show as such, and a day
 * the doctor does not work says so instead of drawing a chart.
 */
export function DoctorDayChart({
  providerId,
  date,
  now,
  onPick,
  currentAppointmentId,
  sharedRange,
}: {
  providerId: string
  date: string
  /** The app's clock (useNow): the Now line and what has gone. */
  now: number
  /** Free time tapped: the slot to book, on that screen's terms. */
  onPick: (date: string, slot: string) => void
  /** Reschedule: the booking being moved, drawn as "Current: …"; tapping it does nothing. */
  currentAppointmentId?: string
  /** Draw these hours on a plain scale with no axis of its own, under a shared DayTimelineAxis. */
  sharedRange?: [number, number]
}) {
  const navigate = useNavigate()
  const today = useStoreValue(getToday)
  const day = useStoreValue(getDoctorDay, providerId, now, date)
  const provider = useStoreValue(getProviderById, providerId)
  const nextPatient = useStoreValue(getDoctorNextPatient, providerId, now)
  const [notice, setNotice] = useState<Notice | null>(null)
  const name = provider?.name ?? 'The doctor'

  const model = useMemo(() => {
    const bookings = day.input.bookings?.map((b) => (b.id === currentAppointmentId ? { ...b, title: `Current: ${b.title}` } : b))
    const drawn = dayModel({ ...day.input, bookings, range: sharedRange })
    // "Next free" names the first slot that can be booked, as the day tabs and
    // the doctor's card do, not the first free minute (which can fall inside a
    // slot that has already started).
    const first = day.board.find((e) => e.status === 'available')
    const nextFree = first ? minutesFrom(first.slot) : null
    const summary = drawn.summary.replace(/, earliest available [^,]*$/, '') + (nextFree !== null ? `, earliest available ${clock12(nextFree)}` : '')
    return { ...drawn, nextFree, summary }
  }, [day, currentAppointmentId, sharedRange])

  const nextFreeFrom = (minute: number) => getNextFreeSlotFrom(getState(), providerId, now, date, minute)

  function schedule(at: number, until: number) {
    const slot = slotForTap(day, at, until)
    if (slot) {
      onPick(date, slot)
      return
    }
    const under = day.board.find((e) => minutesFrom(e.slot) <= at && at < minutesFrom(e.slot) + day.slotMinutes)
    const started = under?.status === 'past'
    setNotice({
      title: started ? 'This slot has started' : 'No slot at this time',
      text: started
        ? `The ${formatTime(under.slot)} slot with ${name} has already started.`
        : `${name} has no slot that starts at ${time12(at)}.`,
      book: nextFreeFrom(at),
      profile: false,
    })
  }

  function blocked() {
    const reason = (day.leave?.reason ?? 'Leave').trim().replace(/\.+$/, '')
    setNotice({
      title: 'On leave',
      text: `${name} is on leave ${date === today ? 'today' : `on ${longDate(date)}`}: ${reason}.`,
      book: null,
      profile: true,
    })
  }

  /** "Book 2:00 PM" on the day shown; "Book tomorrow, 9:30 AM" or "Book Thu 16 Oct, 9:30 AM" on another. */
  const bookLabel = (free: FreeSlot) => {
    if (free.date === date) return `Book ${formatTime(free.slot)}`
    const label = relativeDayLabel(free.date, today)
    return `Book ${label === 'Today' || label === 'Tomorrow' ? label.toLowerCase() : label}, ${formatTime(free.slot)}`
  }

  // A day the doctor does not work has no hours to draw — nothing to book.
  if (day.work.length === 0 && !day.leave) {
    const free = nextFreeFrom(0)
    return (
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border-soft px-4 py-5 text-sm text-ink-muted">
        <p>{`${name} does not work ${date === today ? 'today' : `on ${longDate(date)}`}.`}</p>
        {free ? (
          <Button size="sm" onClick={() => onPick(free.date, free.slot)}>
            <CalendarCheck2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            {bookLabel(free)}
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="min-w-0">
      <DayTimeline
        model={model}
        fit={Boolean(sharedRange)}
        hideAxis={Boolean(sharedRange)}
        nextPatient={nextPatient ?? undefined}
        onSchedule={schedule}
        onBlocked={blocked}
        onOpen={(item) => {
          if (item.id === currentAppointmentId) return
          const uhid = day.uhids[item.id]
          if (uhid) navigate(`/patients/${uhid}`)
        }}
      />
      <DayTimelineKey model={model} hideKey={Boolean(sharedRange)} />

      <Modal
        open={notice !== null}
        onClose={() => setNotice(null)}
        title={notice?.title}
        className="sm:max-w-sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setNotice(null)} className="max-sm:flex-1">
              Close
            </Button>
            {notice?.profile ? (
              <Button onClick={() => navigate(`/doctors/${providerId}`)} className="max-sm:flex-1">
                Open profile
              </Button>
            ) : null}
            {notice?.book ? (
              <Button
                onClick={() => {
                  const free = notice.book!
                  setNotice(null)
                  onPick(free.date, free.slot)
                }}
                className="max-sm:flex-1"
              >
                <CalendarCheck2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                {bookLabel(notice.book)}
              </Button>
            ) : null}
          </>
        }
      >
        <p className="text-sm text-ink">{notice?.text}</p>
        {notice && !notice.profile && !notice.book ? (
          <p className="mt-2 text-sm text-ink-muted">{name} has no available slots in the coming two weeks.</p>
        ) : null}
      </Modal>
    </div>
  )
}

import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  BedDouble,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  DoorOpen,
  IndianRupee,
  LogIn,
  MoreHorizontal,
  UserCheck,
  UserX,
  X,
} from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { AppointmentIllustration } from '../components/ui/illustrations/AppointmentIllustration'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Alert } from '../components/ui/Alert'
import { StatFilter } from '../components/ui/StatFilter'
import type { StatFilterItem } from '../components/ui/StatFilter'
import { OutpatientList } from '../components/outpatient/OutpatientList'
import { BookingDialog } from '../components/appointment/BookingDialog'
import { PatientsTabs } from '../components/patient/PatientsTabs'
import { useStoreValue } from '../hooks/useStore'
import { useNow } from '../hooks/useNow'
import { useToast } from '../hooks/useToast'
import { useFlow } from '../flows/useFlow'
import { getState } from '../domain/store'
import { getBillsForAppointment, getProviderById } from '../domain/selectors'
import { OUTPATIENT_FILTERS, getOutpatients } from '../domain/outpatientSelectors'
import type { OutpatientFilter, OutpatientRow } from '../domain/outpatientSelectors'
import { markNoShow } from '../domain/actions'
import { CheckInToggle } from '../components/appointment/CheckInToggle'
import { todayKey } from '../domain/time'

function readFilter(value: string | null): OutpatientFilter {
  return OUTPATIENT_FILTERS.includes(value as OutpatientFilter) ? (value as OutpatientFilter) : 'today'
}

const EMPTY_TITLE: Record<OutpatientFilter, string> = {
  today: 'No outpatients today',
  'check-in': 'Everyone booked has arrived',
  waiting: 'Nobody is waiting',
  'with-doctor': 'Nobody is with a doctor',
  done: 'Nobody seen yet today',
  upcoming: 'Nothing booked ahead',
}

/**
 * Patients › Outpatients — from booking to the doctor's room: today's bookings
 * at their stage, and the bookings ahead. Each figure is also
 * the filter for the list under it.
 *
 * Call / In room / Complete are the doctor's room's steps — they live here
 * because the desk has to see them; the desk's own step is Check in.
 */
export function OutpatientsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const now = useNow(15000)
  const { notify } = useToast()
  const { openFlow } = useFlow()
  const [error, setError] = useState<string | null>(null)
  // The booking whose reschedule-or-cancel dialog is open.
  const [dialog, setDialog] = useState<{ appointmentId: string; startWith: 'choose' | 'cancel' } | null>(null)

  const query = new URLSearchParams(location.search)
  const filter = readFilter(query.get('filter'))
  const providerId = query.get('provider') ?? ''
  const provider = useStoreValue(getProviderById, providerId)
  const today = todayKey(new Date(now))
  const { rows, counts } = useStoreValue(getOutpatients, now, filter, false, providerId)

  // Filters are views of this page, not places — they don't fill history.
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(location.search)
    if (value === null) next.delete(key)
    else next.set(key, value)
    navigate({ search: `?${next.toString()}` }, { replace: true })
  }

  function run(action: () => void, done: string, detail?: string) {
    setError(null)
    try {
      action()
      notify(done, { detail })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      notify('Could not do that', { tone: 'error', detail: message })
    }
  }

  function actionsFor(row: OutpatientRow) {
    const name = row.patient?.name
    const admit = row.patient ? (
      <Button size="sm" variant="secondary" onClick={() => openFlow('admit', { uhid: row.patient!.uhid })}>
        <BedDouble className="h-3.5 w-3.5" strokeWidth={1.75} />
        Admit
      </Button>
    ) : null
    const token = row.token
    switch (row.stage) {
      case 'to-check-in': {
        const appointment = row.appointment!
        if (appointment.status !== 'Confirmed') {
          const bill = getBillsForAppointment(getState(), appointment.appointmentId)[0]
          // Paid at the billing counter; check-in opens once it is received.
          return bill ? (
            <Button size="sm" variant="secondary" onClick={() => navigate(`/payments/${bill.paymentId}`)}>
              <IndianRupee className="h-3.5 w-3.5" strokeWidth={1.75} />
              View bill
            </Button>
          ) : null
        }
        return (
          <>
            {row.canMarkNoShow ? (
              <Button size="sm" variant="secondary" onClick={() => run(() => markNoShow(appointment.appointmentId), 'Marked as no-show', `${name} · fee kept`)}>
                <UserX className="h-3.5 w-3.5" strokeWidth={1.75} />
                No-show
              </Button>
            ) : null}
            <CheckInToggle appointment={appointment} patientName={name} />
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Reschedule or cancel ${name ?? 'this booking'}`}
              title="Reschedule or cancel"
              onClick={() => setDialog({ appointmentId: appointment.appointmentId, startWith: 'choose' })}
            >
              <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </>
        )
      }
      case 'waiting':
        return token ? (
          <>
            {admit}
            {/* A mistaken check-in can be taken back until the patient is called. */}
            {row.appointment ? <CheckInToggle appointment={row.appointment} patientName={name} /> : null}
          </>
        ) : null
      case 'called':
        return admit
      case 'in-room':
        return token ? <>{admit}</> : null
      case 'done':
        // Admission is usually advised in the doctor's room.
        return token?.status === 'Completed' || row.appointment?.status === 'Completed' ? admit : null
      case 'upcoming':
        return row.appointment ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => openFlow('reschedule', { appointment: row.appointment!.appointmentId })}>
              <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.75} />
              Reschedule
            </Button>
            <Button size="sm" variant="ghost" className="text-critical-fg" onClick={() => setDialog({ appointmentId: row.appointment!.appointmentId, startWith: 'cancel' })}>
              Cancel
            </Button>
          </>
        ) : null
    }
  }

  const items: StatFilterItem<OutpatientFilter>[] = [
    { key: 'today', label: 'Today', value: counts.today, tone: 'info', icon: CalendarClock },
    { key: 'check-in', label: 'To check in', value: counts['check-in'], tone: 'warning', icon: LogIn },
    { key: 'waiting', label: 'Waiting for consultation', value: counts.waiting, tone: 'purple', icon: UserCheck },
    { key: 'with-doctor', label: 'With doctor', value: counts['with-doctor'], tone: 'teal', icon: DoorOpen },
    { key: 'done', label: 'Done today', value: counts.done, tone: 'stable', icon: CheckCircle2 },
    { key: 'upcoming', label: 'Upcoming', value: counts.upcoming, tone: 'indigo', icon: CalendarDays },
  ]

  return (
    <div>
      <PageHeader
        title="Patients"
        illustration={<AppointmentIllustration className="h-8 w-8" />}
        illustrationTone="info"
        tabs={<PatientsTabs />}
        actions={
          <Button size="sm" onClick={() => openFlow('schedule')}>
            <CalendarPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
            Schedule Appointment
          </Button>
        }
      />

      <div className="flex flex-col gap-5 mt-4 sm:mt-5">
        <StatFilter
          label="Show outpatients"
          items={items}
          selected={filter}
          onSelect={(next) => setParam('filter', next)}
          columns="sm:grid-cols-3 xl:grid-cols-6"
        />

        <div className="flex flex-wrap items-center gap-2">
          {provider ? (
            <span className="inline-flex min-h-11 max-w-full items-center gap-1 rounded-full border border-primary-600 bg-primary-50 pl-3.5 pr-0.5 text-sm font-semibold text-primary-text">
              {provider.name}
              <button
                type="button"
                onClick={() => setParam('provider', null)}
                aria-label={`Show every doctor, not only ${provider.name}`}
                className="focus-ring tap-target shrink-0 rounded-full hover:bg-surface-2"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              </button>
            </span>
          ) : null}
        </div>

        {error ? <Alert tone="warning">{error}</Alert> : null}

        <Card accentTone="info">
          <OutpatientList
            rows={rows}
            today={today}
            onOpenPatient={(patientId) => navigate(`/patients/${patientId}`)}
            renderActions={actionsFor}
            emptyTitle={EMPTY_TITLE[filter]}
          />
        </Card>
      </div>

      {dialog ? (
        <BookingDialog
          key={`${dialog.appointmentId}|${dialog.startWith}`}
          appointmentId={dialog.appointmentId}
          startWith={dialog.startWith}
          onClose={() => setDialog(null)}
          onReschedule={(appointmentId) => {
            // The dialog closes before the flow opens over the page.
            setDialog(null)
            openFlow('reschedule', { appointment: appointmentId })
          }}
        />
      ) : null}
    </div>
  )
}

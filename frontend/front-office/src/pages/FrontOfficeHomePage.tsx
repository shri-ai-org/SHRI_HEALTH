import type { CSSProperties, ElementType } from 'react'
import {
  AlertTriangle,
  BedDouble,
  CalendarClock,
  CircleAlert,
  CircleDot,
  IndianRupee,
  Info,
  Undo2,
  UserCheck,
  UserPlus,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { AbhaScanButton } from '../components/patient/AbhaScanButton'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { Card, CardHeader } from '../components/ui/Card'
import { EmptyState } from '../components/ui/EmptyState'
import { StatCard } from '../components/frontoffice/StatCard'
import { figureRowClass } from '../utils/figure'
import { AppointmentsTable } from '../components/appointment/AppointmentsTable'
import { useStoreValue } from '../hooks/useStore'
import { getTodayTrends } from '../domain/reportSelectors'
import { useNow } from '../hooks/useNow'
import { useToast } from '../hooks/useToast'
import { useFlow } from '../flows/useFlow'
import { TodoCard } from '../components/todo/TodoCard'
import { getAppointmentsForDate, getBillingOverview, getNeedsAttention, getQueueView } from '../domain/selectors'
import { getOutpatients } from '../domain/outpatientSelectors'
import { getPatientRows } from '../domain/patientSelectors'
import { todayKey } from '../domain/time'
import type { NeedsAttentionItem } from '../domain/selectors'
import { getInpatientRows } from '../domain/admissionSelectors'
import { returnGuestPass } from '../domain/actions'
import { CheckInToggle } from '../components/appointment/CheckInToggle'
import { formatRupees } from '../utils/billing'
import { appointmentStatusLabel } from '../utils/appointment'
import { TONE_VAR } from '../utils/tone'

const ATTENTION_ICON: Record<NeedsAttentionItem['tone'], ElementType> = {
  critical: CircleAlert,
  warning: AlertTriangle,
  info: Info,
  neutral: CircleDot,
}

const ATTENTION_ROWS = 6

/**
 * The front desk at a glance: five figures that each open the place that
 * holds them, the doctors now (with Schedule beside each), then today's
 * outpatients and what needs attention, with their one action each.
 */
export function FrontOfficeHomePage() {
  const navigate = useNavigate()
  const { notify } = useToast()
  const { openFlow } = useFlow()
  // 15 s tick: minute-level context. The clock only re-derives; nothing here
  // changes on a timer.
  const now = useNow(15000)

  const appointments = useStoreValue(getAppointmentsForDate)
  const queue = useStoreValue(getQueueView, now)
  const billing = useStoreValue(getBillingOverview)
  const trends = useStoreValue(getTodayTrends, now)
  const inpatients = useStoreValue(getInpatientRows, now)
  const needsAttention = useStoreValue(getNeedsAttention, now)
  const outpatients = useStoreValue(getOutpatients, now, 'today', false, '')
  const patientRows = useStoreValue(getPatientRows)
  const today = todayKey(new Date(now))
  const registeredToday = patientRows.filter((row) => todayKey(new Date(row.patient.createdAt)) === today).length

  const booked = appointments.filter((a) => a.status !== 'Cancelled')
  const toCheckIn = appointments.filter((a) => a.status === 'Confirmed')
  // Display order only: what is still to happen first (stable sort keeps time order).
  const isClosed = (status: string) => status === 'Completed' || status === 'Cancelled' || status === 'No-show'
  const todaysList = [...appointments].sort((a, b) => Number(isClosed(a.status)) - Number(isClosed(b.status)))

  function act(run: () => void, done: string, detail?: string) {
    try {
      run()
      notify(done, { detail })
    } catch (err) {
      notify('Could not do that', { tone: 'error', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  function attentionAction(item: NeedsAttentionItem) {
    const action = item.action
    if (!action) return null
    switch (action.kind) {
      case 'bill':
        return (
          <Button size="sm" variant="secondary" onClick={() => navigate(`/payments/${action.paymentId}`)}>
            <IndianRupee className="h-3.5 w-3.5" strokeWidth={1.75} />
            View bill
          </Button>
        )
      case 'admit':
        return (
          <Button size="sm" onClick={() => openFlow('admit', { uhid: action.patientId })}>
            <BedDouble className="h-3.5 w-3.5" strokeWidth={1.75} />
            Admit
          </Button>
        )
      case 'return-pass':
        return (
          <Button size="sm" variant="secondary" onClick={() => act(() => returnGuestPass(action.passId), 'Pass returned', action.passId)}>
            <Undo2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            Return
          </Button>
        )
      case 'open':
        return (
          <Button size="sm" variant="ghost" onClick={() => navigate(action.to)}>
            {action.label}
          </Button>
        )
    }
  }

  return (
    <div>
      <PageHeader
        title="SHRI Health Care Entry"
        pinActions
        actions={
          <>
          <AbhaScanButton />
          <Button onClick={() => navigate('/register/new')}>
            <UserPlus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            {/* "Register" alone fits beside the title on a phone. */}
            <span className="sm:hidden">Register</span>
            <span className="hidden sm:inline">Register Patient</span>
          </Button>
          </>
        }
      />

      <div className="flex flex-col gap-4 sm:gap-5 mt-4 sm:mt-5">
        {/* Five figures, one purpose each — each card opens the place that holds it. */}
        <section aria-label="Today at a glance" className={figureRowClass('sm:grid-cols-3 xl:grid-cols-5')}>
          <StatCard
            hue="blue"
            icon={CalendarClock}
            value={outpatients.counts.today}
            label="Outpatients today"
            trend={trends.APPOINTMENT_SCHEDULED}
            to="/patients/outpatients"
            title="Show everyone booked for today"
          />
          <StatCard
            hue="orange"
            icon={UserCheck}
            value={queue.waiting.length}
            label="Waiting for consultation"
            trend={trends.PATIENT_CHECKED_IN}
            to="/patients/outpatients?filter=waiting"
            title="Show who is waiting for consultation"
          />
          <StatCard
            hue="violet"
            icon={BedDouble}
            value={inpatients.length}
            label="Inpatients"
            trend={trends.PATIENT_ADMITTED}
            to="/patients/inpatients"
            title="Show who is admitted, and the beds"
          />
          <StatCard
            hue="red"
            icon={IndianRupee}
            value={formatRupees(billing.dueAmount)}
            label="Payment pending today"
            trend={trends.PAYMENT_COMPLETED}
            to="/billing?filter=due"
            title="Bills raised today still to pay at the billing counter — opens every bill with payment pending"
          />
          <StatCard
            hue="teal"
            icon={UserPlus}
            value={registeredToday}
            label="Registered today"
            trend={trends.PATIENT_REGISTERED}
            to="/patients?filter=today"
            title="Show the patients registered today"
          />
        </section>

        <div className="grid grid-cols-1 items-start gap-4 sm:gap-5 min-[1400px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {/* Today's outpatients — one action per row */}
          <section className="min-w-0" aria-label="Today's outpatients">
            <Card accentTone="info">
              <CardHeader
                icon={CalendarClock}
                iconTone="info"
                title="Today's outpatients"
                subtitle={`${booked.length} booked · ${toCheckIn.length} to check in`}
                action={
                  <Button size="sm" variant="ghost" onClick={() => navigate('/patients/outpatients')}>
                    View all
                  </Button>
                }
              />
              {/* A booking still to arrive shows its one action where its status would be. */}
              <AppointmentsTable
                appointments={todaysList}
                compact
                maxRows={8}
                // Not here yet → Check in; checked in → Waiting (a second click
                // undoes a mistaken check-in); called or in the room → With
                // doctor; then how the visit ended.
                renderStatus={(appointment) =>
                  appointment.status === 'Confirmed' || (appointment.status === 'Checked-in' && appointment.token?.status === 'Waiting') ? (
                    <CheckInToggle appointment={appointment} patientName={appointment.patient?.name} pressedLabel="Waiting for consultation" />
                  ) : appointment.status === 'Checked-in' && (appointment.token?.status === 'Called' || appointment.token?.status === 'In consultation') ? (
                    <Badge tone="teal" className="px-2">
                      With doctor
                    </Badge>
                  ) : (
                    <Badge status={appointment.token?.status === 'No-show' ? 'No-show' : appointment.status} className="px-2">
                      {appointment.token?.status === 'No-show' ? 'No-show' : appointmentStatusLabel(appointment.status)}
                    </Badge>
                  )
                }
              />
            </Card>
          </section>

          <div className="flex min-w-0 flex-col gap-4 sm:gap-5">
          {/* Needs attention — most urgent first, one action each */}
          <section className="min-w-0" aria-label="Needs attention">
            <Card accentTone="warning">
              <CardHeader icon={AlertTriangle} iconTone="warning" title="Needs attention" subtitle={`${needsAttention.length} open`} />
              {needsAttention.length === 0 ? (
                <EmptyState title="Nothing needs attention" />
              ) : (
                <div className="flex flex-col gap-1.5 p-2.5 sm:p-3">
                  {needsAttention.slice(0, ATTENTION_ROWS).map((item) => {
                    const Icon = ATTENTION_ICON[item.tone]
                    const hue = TONE_VAR[item.tone]
                    // Each row tinted by how urgent it is, with a bar of the
                    // hue on its leading edge — critical rose, warning amber.
                    const tone = { '--tone': hue ? `var(--color-${hue})` : 'var(--color-ink-subtle)' } as CSSProperties
                    return (
                      <div
                        key={item.id}
                        style={tone}
                        className="relative flex items-center gap-3 overflow-hidden rounded-lg border border-[color-mix(in_oklab,var(--tone)_22%,transparent)] bg-[linear-gradient(100deg,color-mix(in_oklab,var(--tone)_12%,var(--color-surface-1))_0%,color-mix(in_oklab,var(--tone)_4%,var(--color-surface-1))_70%)] py-2.5 pl-4 pr-3 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-[var(--tone)]"
                      >
                        <span className="chip-solid flex h-7 w-7 shrink-0 items-center justify-center rounded-full">
                          <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-ink">{item.title}</p>
                          <p className="truncate text-xs text-ink-muted" title={item.detail}>
                            {item.detail}
                          </p>
                        </div>
                        <div className="shrink-0">{attentionAction(item)}</div>
                      </div>
                    )
                  })}
                  {needsAttention.length > ATTENTION_ROWS ? (
                    <p className="px-1.5 pt-1 text-xs text-ink-subtle">+ {needsAttention.length - ATTENTION_ROWS} more, less urgent</p>
                  ) : null}
                </div>
              )}
            </Card>
          </section>

          {/* The desk's own quick to-do notes, kept in this browser */}
          <section className="min-w-0" aria-label="To-do">
            <TodoCard />
          </section>
          </div>
        </div>
      </div>
    </div>
  )
}

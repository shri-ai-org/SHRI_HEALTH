import { useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { CalendarCheck, Stethoscope } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { doctorStatusLabel } from '../utils/appointment'
import { Avatar } from '../components/ui/Avatar'
import { Alert } from '../components/ui/Alert'
import { EmptyState } from '../components/ui/EmptyState'
import { DoctorDayChart } from '../components/clinician/DoctorDayChart'
import { AppointmentsTable } from '../components/appointment/AppointmentsTable'
import { useStoreValue } from '../hooks/useStore'
import { useNow } from '../hooks/useNow'
import { useToast } from '../hooks/useToast'
import {
  getDoctorRow,
  getSlotBoard,
  getAppointmentsForProvider,
  getToday,
} from '../domain/selectors'
import { setDoctorStatus } from '../domain/actions'
import { DoctorLeaveCard } from '../components/doctor/DoctorLeaveCard'
import { initialsOf } from '../utils/format'
import { useFlow } from '../flows/useFlow'
import { formatTimeRange } from '../domain/time'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function DoctorProfilePage() {
  const { providerId } = useParams<{ providerId: string }>()
  const navigate = useNavigate()
  const now = useNow(30000)
  const { notify } = useToast()
  const { openFlow } = useFlow()
  const id = providerId ?? ''
  const today = useStoreValue(getToday)

  const row = useStoreValue(getDoctorRow, id, now)
  const slotEntries = useStoreValue(getSlotBoard, id, now)
  const appointments = useStoreValue(getAppointmentsForProvider, id)

  const [error, setError] = useState<string | null>(null)

  if (!row) {
    return (
      <div>
        <PageHeader title="Doctor not found" />
        <div className="mt-5 sm:mt-6">
          <Card accentTone="indigo" className="max-w-xl">
            <CardBody>
              <EmptyState
                icon={Stethoscope}
                title="No such doctor"
                action={<Button size="sm" onClick={() => navigate('/doctors')}>Doctors</Button>}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    )
  }

  const { provider, status, schedule } = row

  function run(fn: () => void, successMessage: string): boolean {
    setError(null)
    try {
      fn()
      notify(successMessage)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      notify('Action failed', { tone: 'error', detail: message })
      return false
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Doctor profile"
        title={provider.name}
        subtitle={`${provider.department} · ${provider.specialty} · ${provider.employeeId}`}
        actions={
          <>
            <Button size="sm" onClick={() => openFlow('schedule', { doctor: id })}>
              <CalendarCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
              Schedule Appointment
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-4 sm:gap-5 mt-4 sm:mt-5">
        {error ? <Alert tone="critical">{error}</Alert> : null}

        <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[340px_minmax(0,1fr)]">
          {/* Profile */}
          <div className="flex min-w-0 flex-col gap-6">
            <Card accentTone="indigo">
              <CardBody className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <Avatar name={provider.name} initials={initialsOf(provider.name)} size="lg" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{provider.name}</p>
                    <p className="truncate text-xs text-ink-muted">{provider.qualification ?? '—'}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <Badge status={status}>{doctorStatusLabel(status)}</Badge>
                      <Badge status={provider.status} className="text-2xs" />
                    </div>
                  </div>
                </div>

                <dl className="space-y-2 border-t border-border-soft pt-3 text-sm">
                  <Row label="Department" value={provider.department} />
                  <Row label="Speciality" value={provider.specialty} />
                  <Row label="Registration no." value={provider.registrationNumber} />
                  <Row label="Experience" value={`${provider.experienceYears} yrs`} />
                  <Row label="Consultation" value={provider.consultationType} />
                  <Row label="Fee" value={provider.consultationFee ? `₹${provider.consultationFee}` : '—'} />
                  <Row label="Room" value={provider.room ?? '—'} />
                  <Row label="Mobile" value={provider.mobile} />
                  <Row label="Email" value={provider.email ?? '—'} />
                  <Row label="Role" value={provider.role} />
                </dl>

                <div className="border-t border-border-soft pt-3">
                  {provider.status === 'Active' ? (
                    <Button
                      variant="secondary"
                      className="w-full"
                      onClick={() => run(() => setDoctorStatus(id, 'Inactive'), 'Doctor deactivated')}
                    >
                      Deactivate account
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      onClick={() => run(() => setDoctorStatus(id, 'Active'), 'Doctor activated')}
                    >
                      Activate account
                    </Button>
                  )}
                </div>
              </CardBody>
            </Card>

            <DoctorLeaveCard providerId={id} providerName={provider.name} />
          </div>

          {/* Schedule + appointments */}
          <div className="flex min-w-0 flex-col gap-6">
            <Card accentTone="info">
              <CardHeader
                icon={CalendarCheck}
                iconTone="info"
                title="Today's schedule"
                subtitle={
                  schedule
                    ? `${formatTimeRange(schedule.sessionStart, schedule.sessionEnd)} · ${schedule.slotMinutes}-minute slots · ${provider.schedule.workingDays.map((d) => DAY_LABELS[d]).join(', ')}`
                    : 'No session configured for today'
                }
                action={<span className="text-xs tabular-nums text-ink-subtle">{row.openSlotCount} open</span>}
              />
              <CardBody>
                {slotEntries.length === 0 ? (
                  <EmptyState title={status === 'On leave' ? 'On leave today' : 'No session today'} />
                ) : (
                  <DoctorDayChart providerId={id} date={today} now={now} onPick={(date, slot) => openFlow('schedule', { doctor: id, date, slot })} />
                )}
              </CardBody>
            </Card>

            <Card accentTone="info">
              <CardHeader
                icon={Stethoscope}
                iconTone="info"
                title="Today's appointments"
                action={
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/patients/outpatients?provider=${id}`)}>
                    Outpatients · {appointments.length}
                  </Button>
                }
              />
              <AppointmentsTable appointments={appointments} />
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-ink-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm font-medium text-ink" title={String(value)}>
        {value}
      </dd>
    </div>
  )
}

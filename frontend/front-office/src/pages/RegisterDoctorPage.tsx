import { useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, UserRoundPlus, Stethoscope, Building2, CalendarCheck, ShieldCheck } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { DoctorIllustration } from '../components/ui/illustrations/DoctorIllustration'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { MobileInput } from '../components/ui/MobileInput'
import { Alert } from '../components/ui/Alert'
import { Badge } from '../components/ui/Badge'
import { Avatar } from '../components/ui/Avatar'
import { useStoreValue } from '../hooks/useStore'
import { useToast } from '../hooks/useToast'
import { useFlow } from '../flows/useFlow'
import { getDepartments } from '../domain/selectors'
import { registerDoctor } from '../domain/actions'
import { initialsOf } from '../utils/format'
import { cn } from '../utils/cn'
import type { ConsultationType, DoctorRole, Gender, Provider, ProviderStatus } from '../types/doctor'
import { inputClass } from '../utils/formClasses'
import { formatTimeRange } from '../domain/time'

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
]
const GENDERS: Gender[] = ['Male', 'Female', 'Other']
const CONSULT_TYPES: ConsultationType[] = ['Outpatient', 'Outpatient + Teleconsult', 'Teleconsult only']
const ROLES: DoctorRole[] = ['Consultant', 'Senior Consultant', 'Associate Consultant', 'Visiting Consultant', 'Registrar']
const SLOT_LENGTHS = [10, 15, 20, 30, 45]


interface DoctorFormState {
  name: string
  gender: Gender
  dateOfBirth: string
  mobile: string
  email: string
  department: string
  specialty: string
  qualification: string
  registrationNumber: string
  experienceYears: string
  employeeId: string
  consultationType: ConsultationType
  consultationFee: string
  room: string
  workingDays: number[]
  startTime: string
  endTime: string
  slotMinutes: number
  loginEmail: string
  role: DoctorRole
  status: ProviderStatus
}

const EMPTY: DoctorFormState = {
  name: '',
  gender: 'Male',
  dateOfBirth: '',
  mobile: '',
  email: '',
  department: '',
  specialty: '',
  qualification: '',
  registrationNumber: '',
  experienceYears: '',
  employeeId: '',
  consultationType: 'Outpatient',
  consultationFee: '',
  room: '',
  workingDays: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '13:00',
  slotMinutes: 15,
  loginEmail: '',
  role: 'Consultant',
  status: 'Active',
}

/**
 * Doctor Management creates the doctor's HOSPITAL PROFILE — identity,
 * department, schedule and account status. It does not grant or imply any
 * clinical capability: no notes, no diagnosis, no patient history. What it
 * does do is make the doctor appear in the directory and become bookable.
 */
export function RegisterDoctorPage() {
  const navigate = useNavigate()
  const { notify } = useToast()
  const { openFlow } = useFlow()
  const departments = useStoreValue(getDepartments)

  const [form, setForm] = useState<DoctorFormState>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<Provider | null>(null)

  function update<K extends keyof DoctorFormState>(field: K, value: DoctorFormState[K]) {
    setForm((current) => ({ ...current, [field]: value }))
    setError(null)
  }

  function toggleDay(day: number) {
    setForm((current) => ({
      ...current,
      workingDays: current.workingDays.includes(day)
        ? current.workingDays.filter((d) => d !== day)
        : [...current.workingDays, day].sort(),
    }))
    setError(null)
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    try {
      const provider = registerDoctor({
        ...form,
        schedule: {
          workingDays: form.workingDays,
          startTime: form.startTime,
          endTime: form.endTime,
          slotMinutes: Number(form.slotMinutes),
          breaks: [],
        },
      })
      setCreated(provider)
      notify('Doctor registered', { detail: `${provider.name} · ${provider.department}` })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      notify('Registration failed', { tone: 'error', detail: message })
    }
  }

  if (created) {
    const bookable = created.status === 'Active'
    return (
      <div>
        <PageHeader title="Register Doctor" />
        <div className="mt-5 sm:mt-6">
          <Card accentTone="indigo" className="max-w-2xl">
            <CardBody className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success-bg">
                  <CheckCircle2 className="h-5 w-5 text-success-fg" strokeWidth={1.75} />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-ink">{created.name} registered</p>
                    <Badge status={created.status} />
                  </div>
                  <p className="mt-0.5 text-sm text-ink-muted">
                    {created.department} · {created.specialty} · {created.employeeId} · consults{' '}
                    {formatTimeRange(created.schedule.startTime, created.schedule.endTime)} in {created.schedule.slotMinutes}-minute
                    slots
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2.5 border-t border-border-soft pt-4">
                <Button onClick={() => navigate(`/doctors/${created.providerId}`)}>Open doctor profile</Button>
                <Button variant="secondary" onClick={() => navigate('/doctors')}>
                  Doctor directory
                </Button>
                {bookable ? (
                  <Button variant="secondary" onClick={() => openFlow('schedule', { doctor: created.providerId })}>
                    Schedule Appointment
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  onClick={() => {
                    setCreated(null)
                    setForm(EMPTY)
                  }}
                >
                  Register another
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Register Doctor"
        illustration={<DoctorIllustration className="h-8 w-8" />}
        illustrationTone="indigo"
      />

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_340px] mt-4 sm:mt-5">
          <div className="flex min-w-0 flex-col gap-6">
            {error ? <Alert tone="critical">{error}</Alert> : null}

            <Card accentTone="indigo">
              <CardHeader icon={UserRoundPlus} iconTone="indigo" title="Basic information" />
              <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Doctor name" required className="sm:col-span-2">
                  <input
                    value={form.name}
                    onChange={(e) => update('name', e.target.value)}
                    placeholder="Dr. Full Name"
                    className={inputClass}
                  />
                </Field>
                <Field label="Gender">
                  <div className="flex gap-1.5">
                    {GENDERS.map((option) => (
                      <Choice key={option} active={form.gender === option} onClick={() => update('gender', option)}>
                        {option}
                      </Choice>
                    ))}
                  </div>
                </Field>
                <Field label="Date of birth">
                  <input
                    type="date"
                    value={form.dateOfBirth}
                    onChange={(e) => update('dateOfBirth', e.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Mobile number" required>
                  <MobileInput
                    value={form.mobile}
                    onValueChange={(value) => update('mobile', value)}
                    placeholder="10-digit mobile number"
                    className={inputClass}
                  />
                </Field>
                <Field label="Email">
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => update('email', e.target.value)}
                    placeholder="name@hospital.org"
                    className={inputClass}
                  />
                </Field>
              </CardBody>
            </Card>

            <Card accentTone="indigo">
              <CardHeader icon={Stethoscope} iconTone="indigo" title="Professional information" />
              <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Department" required>
                  <select
                    value={form.department}
                    onChange={(e) => update('department', e.target.value)}
                    className={inputClass}
                  >
                    <option value="">Select a department…</option>
                    {departments.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Speciality" required>
                  <input
                    value={form.specialty}
                    onChange={(e) => update('specialty', e.target.value)}
                    placeholder="e.g. Interventional Cardiology"
                    className={inputClass}
                  />
                </Field>
                <Field label="Qualification">
                  <input
                    value={form.qualification}
                    onChange={(e) => update('qualification', e.target.value)}
                    placeholder="MBBS, MD, DM"
                    className={inputClass}
                  />
                </Field>
                <Field label="Medical registration number" required>
                  <input
                    value={form.registrationNumber}
                    onChange={(e) => update('registrationNumber', e.target.value)}
                    placeholder="State council registration"
                    className={inputClass}
                  />
                </Field>
                <Field label="Years of experience">
                  <input
                    value={form.experienceYears}
                    onChange={(e) => update('experienceYears', e.target.value.replace(/[^0-9]/g, ''))}
                    inputMode="numeric"
                    placeholder="Years"
                    className={inputClass}
                  />
                </Field>
              </CardBody>
            </Card>

            <Card accentTone="indigo">
              <CardHeader icon={Building2} iconTone="indigo" title="Hospital information" />
              <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Doctor / employee ID">
                  <input
                    value={form.employeeId}
                    onChange={(e) => update('employeeId', e.target.value)}
                    placeholder="SHRI-DOC-000"
                    className={inputClass}
                  />
                </Field>
                <Field label="Consultation type">
                  <select
                    value={form.consultationType}
                    onChange={(e) => update('consultationType', e.target.value as ConsultationType)}
                    className={inputClass}
                  >
                    {CONSULT_TYPES.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Consultation fee (₹)">
                  <input
                    value={form.consultationFee}
                    onChange={(e) => update('consultationFee', e.target.value.replace(/[^0-9]/g, ''))}
                    inputMode="numeric"
                    placeholder="200"
                    className={inputClass}
                  />
                </Field>
                <Field label="Consultation room / location">
                  <input
                    value={form.room}
                    onChange={(e) => update('room', e.target.value)}
                    placeholder="Room 4, Block A"
                    className={inputClass}
                  />
                </Field>
              </CardBody>
            </Card>

            <Card accentTone="stable">
              <CardHeader icon={CalendarCheck} iconTone="stable" title="Schedule" />
              <CardBody className="flex flex-col gap-4">
                <Field label="Working days" required>
                  <div className="flex flex-wrap gap-1.5">
                    {DAYS.map((day) => (
                      <Choice
                        key={day.value}
                        active={form.workingDays.includes(day.value)}
                        onClick={() => toggleDay(day.value)}
                      >
                        {day.label}
                      </Choice>
                    ))}
                  </div>
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label="Session starts" required>
                    <input
                      type="time"
                      value={form.startTime}
                      onChange={(e) => update('startTime', e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Session ends" required>
                    <input
                      type="time"
                      value={form.endTime}
                      onChange={(e) => update('endTime', e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Slot duration">
                    <select
                      value={form.slotMinutes}
                      onChange={(e) => update('slotMinutes', Number(e.target.value))}
                      className={inputClass}
                    >
                      {SLOT_LENGTHS.map((option) => (
                        <option key={option} value={option}>
                          {option} minutes
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </CardBody>
            </Card>

            <Card accentTone="stable">
              <CardHeader icon={ShieldCheck} iconTone="stable" title="Account" />
              <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Login email / username">
                  <input
                    value={form.loginEmail}
                    onChange={(e) => update('loginEmail', e.target.value)}
                    placeholder="name@hospital.org"
                    className={inputClass}
                  />
                </Field>
                <Field label="Role">
                  <select
                    value={form.role}
                    onChange={(e) => update('role', e.target.value as DoctorRole)}
                    className={inputClass}
                  >
                    {ROLES.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Account status">
                  <div className="flex gap-1.5">
                    {(['Active', 'Inactive'] as ProviderStatus[]).map((option) => (
                      <Choice key={option} active={form.status === option} onClick={() => update('status', option)}>
                        {option}
                      </Choice>
                    ))}
                  </div>
                </Field>
              </CardBody>
            </Card>
          </div>

          {/* Summary / submit */}
          <div className="min-w-0">
            <Card accentTone="indigo" className="2xl:sticky 2xl:top-6">
              <CardBody className="flex flex-col gap-4">
                <div className="flex items-center gap-2.5">
                  <Avatar initials={form.name ? initialsOf(form.name) : 'DR'} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{form.name || 'New doctor'}</p>
                    <p className="truncate text-xs text-ink-muted">
                      {form.department || 'Department'} · {form.specialty || 'Speciality'}
                    </p>
                  </div>
                </div>

                <dl className="space-y-2 border-t border-border-soft pt-3 text-sm">
                  <Row label="Working days" value={form.workingDays.length ? `${form.workingDays.length} ${form.workingDays.length === 1 ? 'day' : 'days'}/week` : '—'} />
                  <Row label="Session" value={form.startTime && form.endTime ? formatTimeRange(form.startTime, form.endTime) : '—'} />
                  <Row label="Slot length" value={`${form.slotMinutes} min`} />
                  <Row label="Fee" value={form.consultationFee ? `₹${form.consultationFee}` : '—'} />
                  <Row label="Status" value={form.status} />
                </dl>

                <div className="flex flex-col gap-2 border-t border-border-soft pt-4">
                  <Button type="submit">Register doctor</Button>
                  <Button type="button" variant="secondary" onClick={() => navigate('/doctors')}>
                    Cancel
                  </Button>
                </div>
              </CardBody>
            </Card>
          </div>
        </div>
      </form>
    </div>
  )
}

function Field({
  label,
  required,
  children,
  className,
}: {
  label: string
  required?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <label className="text-xs font-medium text-ink-muted">
        {label} {required ? <span className="text-critical-fg">*</span> : null}
      </label>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'focus-ring min-h-11 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'border-primary-600 bg-primary-600 text-on-primary'
          : 'border-border bg-surface-1 text-ink hover:bg-surface-2',
      )}
    >
      {children}
    </button>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-ink-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm font-medium text-ink" title={value}>
        {value}
      </dd>
    </div>
  )
}

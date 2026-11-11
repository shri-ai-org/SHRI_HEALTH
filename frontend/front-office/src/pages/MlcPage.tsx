import { useState } from 'react'
import { FileWarning, ShieldCheck, Send } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { Alert } from '../components/ui/Alert'
import { EmptyState } from '../components/ui/EmptyState'
import { useStoreValue } from '../hooks/useStore'
import { useNow } from '../hooks/useNow'
import { useToast } from '../hooks/useToast'
import { PatientPickField } from '../components/patient/PatientPickField'
import { getMlcRecords, getPatientById } from '../domain/selectors'
import { registerMlc, markMlcIntimationSent, acknowledgeMlcIntimation } from '../domain/actions'
import { todayKey } from '../domain/time'
import { formatRelativeTime, formatClock } from '../utils/format'
import { cn } from '../utils/cn'
import type { MlcCategory } from '../types/frontDesk'
import { errorClass, errorWithinClass, inputClass } from '../utils/formClasses'
import { revealFirstInvalid } from '../utils/revealInvalid'
import { FieldError } from '../components/patient/AgeConfirm'

const CATEGORIES: MlcCategory[] = ['Road traffic accident', 'Assault', 'Poisoning', 'Burns', 'Suicide attempt', 'Other']
const BROUGHT_BY = ['Police', 'Relative', 'Bystander', 'Ambulance']


export function MlcPage() {
  const now = useNow(60000)
  const { notify } = useToast()
  const [patientId, setPatientId] = useState('')
  const patient = useStoreValue(getPatientById, patientId)
  const records = useStoreValue(getMlcRecords)

  const [category, setCategory] = useState<MlcCategory | ''>('')
  const [broughtBy, setBroughtBy] = useState('Police')
  const [policeStation, setPoliceStation] = useState('')
  const [incidentAt, setIncidentAt] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The submit stays clickable: tried with something missing, it marks each such field.
  const [attempted, setAttempted] = useState(false)
  const problem = {
    patient: patient ? null : 'Choose the patient.',
    category: category ? null : 'Choose the MLC category.',
    policeStation: policeStation.trim() ? null : 'Enter the police station.',
  }
  const shown = (key: keyof typeof problem) => (attempted ? problem[key] : null)

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (!patient || !category || !policeStation.trim()) {
      setAttempted(true)
      revealFirstInvalid()
      return
    }
    try {
      const record = registerMlc({
        patientId: patient?.patientId ?? '',
        category: category || 'Other',
        broughtBy,
        policeStation,
        incidentAt,
      })
      notify('MLC registered', { detail: `${record.mlcId} · ${record.patientName}` })
      setPatientId('')
      setCategory('')
      setPoliceStation('')
      setIncidentAt('')
      setAttempted(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      notify('Could not register MLC', { tone: 'error', detail: message })
    }
  }

  function run(fn: (id: string) => void, id: string, message: string) {
    try {
      fn(id)
      notify(message)
    } catch (err) {
      notify('Action failed', { tone: 'error', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div>
      <PageHeader title="Medico-Legal Case Registration" />

      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[380px_minmax(0,1fr)] mt-4 sm:mt-5">
        <Card accentTone="warning" className="min-w-0">
          <CardHeader icon={FileWarning} iconTone="warning" title="Register an MLC" />
          <CardBody>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {error ? <Alert tone="critical">{error}</Alert> : null}

              <div>
                <p className="mb-1.5 text-xs font-medium text-ink-muted">
                  Patient <span className="text-critical-fg">*</span>
                </p>
                <div data-invalid={shown('patient') ? 'true' : undefined} className={cn(shown('patient') && errorWithinClass)}>
                  <PatientPickField
                    patient={patient}
                    onChange={(next) => setPatientId(next.patientId)}
                    placeholder="Search for the patient"
                  />
                </div>
                <FieldError message={shown('patient')} />
              </div>

              <div>
                <label className="text-xs font-medium text-ink-muted">
                  MLC category <span className="text-critical-fg">*</span>
                </label>
                <div data-invalid={shown('category') ? 'true' : undefined} className="mt-1.5 flex flex-wrap gap-1.5">
                  {CATEGORIES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setCategory(option)}
                      className={cn(
                        'focus-ring min-h-11 rounded-full border px-3.5 text-sm font-medium transition-colors',
                        category === option
                          ? 'border-primary-600 bg-primary-600 text-on-primary'
                          : shown('category')
                            ? 'border-critical-fg/50 bg-surface-1 text-ink hover:bg-surface-2'
                            : 'border-border bg-surface-1 text-ink hover:bg-surface-2',
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
                <FieldError message={shown('category')} />
              </div>

              <div>
                <label className="text-xs font-medium text-ink-muted">
                  Brought by <span className="text-critical-fg">*</span>
                </label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {BROUGHT_BY.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setBroughtBy(option)}
                      className={cn(
                        'focus-ring min-h-11 rounded-full border px-3.5 text-sm font-medium transition-colors',
                        broughtBy === option
                          ? 'border-primary-600 bg-primary-600 text-on-primary'
                          : 'border-border bg-surface-1 text-ink hover:bg-surface-2',
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-ink-muted">
                  Police station <span className="text-critical-fg">*</span>
                </label>
                <input
                  value={policeStation}
                  onChange={(event) => setPoliceStation(event.target.value)}
                  placeholder="Station with jurisdiction"
                  aria-invalid={Boolean(shown('policeStation'))}
                  className={cn(inputClass, 'mt-1.5', shown('policeStation') && errorClass)}
                />
                <FieldError message={shown('policeStation')} />
              </div>

              <div>
                <label className="text-xs font-medium text-ink-muted">Incident date & time</label>
                <input
                  type="datetime-local"
                  value={incidentAt}
                  onChange={(event) => setIncidentAt(event.target.value)}
                  className={cn(inputClass, 'mt-1.5')}
                />
              </div>

              <Button type="submit">
                Allocate MLC number
              </Button>
            </form>
          </CardBody>
        </Card>

        <Card accentTone="warning" className="min-w-0">
          <CardHeader
            title="MLC register"
            action={<span className="text-xs tabular-nums text-ink-subtle">{records.length}</span>}
          />
          {records.length === 0 ? (
            <EmptyState icon={FileWarning} title="No MLC records" />
          ) : (
            <div className="divide-y divide-border-soft">
              {records.map((record) => (
                <div key={record.mlcId} className="flex flex-col gap-2 px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      {record.mlcId} · {record.patientName}
                    </p>
                    <p className="truncate text-xs text-ink-muted">
                      {record.category} · brought by {record.broughtBy} · {record.policeStation} ·{' '}
                      {formatRelativeTime(record.registeredAt, now)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {record.acknowledgedAt ? (
                      <Badge tone="stable">
                        Acknowledged{' '}
                        {todayKey(new Date(record.acknowledgedAt)) === todayKey(new Date(now))
                          ? formatClock(record.acknowledgedAt)
                          : formatRelativeTime(record.acknowledgedAt, now)}
                      </Badge>
                    ) : record.intimationSent ? (
                      <Badge tone="warning">Acknowledgement pending</Badge>
                    ) : (
                      <Badge tone="critical">Intimation pending</Badge>
                    )}
                    {!record.intimationSent ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => run(markMlcIntimationSent, record.mlcId, 'Police intimation sent')}
                      >
                        <Send className="h-3.5 w-3.5 text-info-fg" strokeWidth={1.75} />
                        Send intimation
                      </Button>
                    ) : !record.acknowledgedAt ? (
                      <Button
                        size="sm"
                        onClick={() => run(acknowledgeMlcIntimation, record.mlcId, 'Acknowledgement captured')}
                      >
                        <ShieldCheck className="h-3.5 w-3.5 text-success-fg" strokeWidth={1.75} />
                        Capture acknowledgement
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

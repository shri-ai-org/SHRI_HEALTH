import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { BedDouble, BedSingle, LogOut } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { AdmissionIllustration } from '../components/ui/illustrations/AdmissionIllustration'
import { Card } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { ResponsiveTable } from '../components/ui/ResponsiveTable'
import { EmptyState } from '../components/ui/EmptyState'
import { WardIcon } from '../components/ui/WardIcon'
import { StatFilter } from '../components/ui/StatFilter'
import type { StatFilterItem } from '../components/ui/StatFilter'
import { BillStatusBadge } from '../components/payment/BillStatusBadge'
import { useStoreValue } from '../hooks/useStore'
import { useNow } from '../hooks/useNow'
import { useFlow } from '../flows/useFlow'
import { getDischargedOn, getInpatientRows, getWardSummaries } from '../domain/admissionSelectors'
import { todayKey } from '../domain/time'
import { BILL_STATUS_LABEL, BILL_STATUS_TONE, formatRupees } from '../utils/billing'
import { formatClock } from '../utils/format'
import { formatDateKey } from '../utils/dates'
import { Avatar } from '../components/ui/Avatar'
import { initialsOf } from '../utils/format'
import { cn } from '../utils/cn'
import type { Admission, Bed, Ward } from '../types/admission'
import { PatientStatusIcons } from '../components/patient/PatientStatusIcons'
import { usePatientCareStatus } from '../hooks/useCareStatus'
import { PatientsTabs } from '../components/patient/PatientsTabs'

type InpatientFilter = 'admitted' | 'beds' | 'discharged'

const FILTERS: InpatientFilter[] = ['admitted', 'beds', 'discharged']

function readFilter(search: string): InpatientFilter {
  const value = new URLSearchParams(search).get('filter')
  return FILTERS.includes(value as InpatientFilter) ? (value as InpatientFilter) : 'admitted'
}

function isCritical(ward: string | null): boolean {
  return ward === 'ICU' || ward === 'Emergency'
}

function at(timestamp: number): string {
  return `${formatDateKey(todayKey(new Date(timestamp)))} · ${formatClock(timestamp)}`
}

function payerOf(admission: Admission): string {
  return admission.paymentType === 'Self Pay' ? 'Self pay' : (admission.insuranceProvider ?? admission.paymentType)
}

/**
 * Patients › Inpatients: who is in a bed, which beds are free
 * and who went home today — each figure is also the filter for the list
 * under it. Discharge sits on the patient's row, and a requested admission
 * is given its bed on its own row. A new admission starts from the
 * patient's profile, never here.
 */
export function InpatientsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { openFlow } = useFlow()
  const now = useNow(60000)
  const filter = readFilter(location.search)

  const rows = useStoreValue(getInpatientRows, now)
  const wards = useStoreValue(getWardSummaries)
  const discharged = useStoreValue(getDischargedOn, now)
  const [wardChoice, setWardChoice] = useState<Ward | null>(null)
  const activeWard = wards.find((w) => w.ward === wardChoice) ?? wards[0] ?? null

  const bedsFree = wards.reduce((sum, w) => sum + w.available, 0)

  function selectFilter(next: InpatientFilter) {
    const query = new URLSearchParams(location.search)
    query.set('filter', next)
    // A filter is a view of this page, not a place — don't fill history.
    navigate({ search: `?${query.toString()}` }, { replace: true })
  }

  const openProfile = (patientId: string) => navigate(`/patients/${patientId}`)

  const items: StatFilterItem<InpatientFilter>[] = [
    {
      key: 'admitted',
      label: 'Inpatients',
      value: rows.length,
      tone: 'purple',
      icon: BedDouble,
    },
    { key: 'beds', label: 'Beds available', value: bedsFree, tone: 'stable', icon: BedSingle },
    { key: 'discharged', label: 'Discharged today', value: discharged.length, tone: 'teal', icon: LogOut },
  ]

  return (
    <div>
      <PageHeader
        title="Patients"
        illustration={<AdmissionIllustration className="h-8 w-8" />}
        illustrationTone="purple"
        tabs={<PatientsTabs />}
      />

      <div className="flex flex-col gap-4 sm:gap-5 mt-4 sm:mt-5">
        <StatFilter label="Show" items={items} selected={filter} onSelect={selectFilter} />

        {filter === 'admitted' ? (
          <Card accentTone="purple">
            {rows.length === 0 ? (
              <EmptyState icon={BedDouble} title="Nobody is admitted" />
            ) : (
              <ResponsiveTable
                rows={rows}
                rowKey={(row) => row.admission.admissionId}
                caption="Admitted patients"
                columns={[
                  { key: 'patient', header: 'Patient', mobile: 'title', sortValue: (r) => r.admission.patientName, cell: ({ admission: a }) => <PatientCell patientId={a.patientId} name={a.patientName} detail={`${a.patientId} · ${a.admissionNumber}`} onOpen={() => openProfile(a.patientId)} /> },
                  { key: 'bed', header: 'Ward · bed', mobile: 'subtitle', cell: ({ admission: a }) => <WardLabel ward={a.wardLabel} bed={a.bedNumber} /> },
                  { key: 'day', header: 'Day', className: 'whitespace-nowrap tabular-nums text-ink', sortValue: (r) => r.billing.days, cell: ({ billing }) => `Day ${billing.days}` },
                  {
                    key: 'doctor',
                    header: 'Doctor',
                    className: 'text-ink-muted',
                    sortValue: (r) => r.admission.doctorName,
                    cell: ({ admission: a }) => (
                      <>
                        <span className="block tbl:whitespace-nowrap">{a.doctorName}</span>
                        <span className="block text-xs text-ink-subtle">{a.department}</span>
                      </>
                    ),
                  },
                  {
                    key: 'bill',
                    header: 'Bill',
                    mobile: 'aside',
                    cell: ({ admission: a, billing, billStatus }) => (
                      <>
                        <Badge tone={BILL_STATUS_TONE[billStatus]}>
                          {billing.pending > 0 ? `${BILL_STATUS_LABEL[billStatus]} · ${formatRupees(billing.pending)}` : BILL_STATUS_LABEL[billStatus]}
                        </Badge>
                        <span className="mt-1 block text-xs text-ink-subtle">{payerOf(a)}</span>
                      </>
                    ),
                  },
                  {
                    key: 'actions',
                    header: <span className="sr-only">Actions</span>,
                    className: 'whitespace-nowrap text-right',
                    mobile: 'actions',
                    cell: ({ admission: a }) => (
                      <Button size="sm" variant="secondary" onClick={() => openFlow('discharge', { uhid: a.patientId })}>
                        <LogOut size={14} aria-hidden="true" />
                        Discharge
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        ) : null}

        {filter === 'beds' ? (
          <Card accentTone="purple">
            <div className="flex flex-wrap gap-2 border-b border-border-soft px-4 py-4 sm:px-5" role="group" aria-label="Ward">
              {wards.map((w) => {
                const active = w.ward === activeWard?.ward
                return (
                  <button
                    key={w.ward}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setWardChoice(w.ward)}
                    className={cn(
                      'focus-ring flex min-h-11 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors',
                      active ? 'border-primary-600 bg-primary-50 text-primary-text' : 'border-border bg-surface-1 text-ink-muted hover:bg-surface-2',
                    )}
                  >
                    <WardIcon ward={w.ward} className={cn('h-4 w-4', isCritical(w.ward) && 'text-critical-fg')} />
                    {w.ward}
                    <span className={cn('text-xs tabular-nums', w.available > 0 ? 'text-success-fg' : 'text-critical-fg')}>
                      {w.available}/{w.total} available
                    </span>
                  </button>
                )
              })}
            </div>
            {activeWard ? (
              <ul className="grid grid-cols-1 gap-2 px-4 py-4 sm:px-5 min-[480px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {activeWard.beds.map((bed) => (
                  <BedTile
                    key={bed.bedId}
                    bed={bed}
                    occupant={rows.find((r) => r.admission.admissionId === bed.currentAdmissionId)?.admission ?? null}
                    onOpen={openProfile}
                  />
                ))}
              </ul>
            ) : null}
          </Card>
        ) : null}

        {filter === 'discharged' ? (
          <Card accentTone="purple">
            {discharged.length === 0 ? (
              <EmptyState icon={LogOut} title="No discharges yet today" />
            ) : (
              <ResponsiveTable
                rows={discharged}
                rowKey={(row) => row.admission.admissionId}
                caption="Discharged today"
                columns={[
                  { key: 'patient', header: 'Patient', mobile: 'title', sortValue: (r) => r.admission.patientName, cell: ({ admission: a }) => <PatientCell patientId={a.patientId} name={a.patientName} detail={`${a.patientId} · ${a.admissionNumber}`} onOpen={() => openProfile(a.patientId)} /> },
                  { key: 'bed', header: 'Ward · bed', mobile: 'subtitle', cell: ({ admission: a }) => <WardLabel ward={a.wardLabel} bed={a.bedNumber} /> },
                  { key: 'when', header: 'Discharged', className: 'whitespace-nowrap text-ink-muted', sortValue: (r) => r.admission.dischargedAt ?? '', cell: ({ admission: a }) => (a.dischargedAt ? at(a.dischargedAt) : '—') },
                  { key: 'type', header: 'Type', className: 'whitespace-nowrap text-ink-muted', cell: ({ admission: a }) => a.dischargeType ?? 'Normal Discharge' },
                  {
                    key: 'bill',
                    header: 'Bill',
                    className: 'whitespace-nowrap',
                    mobile: 'aside',
                    cell: ({ bill }) =>
                      bill ? (
                        <span className="flex flex-wrap items-center justify-end gap-2 tbl:justify-start">
                          <span className="tabular-nums text-ink">{formatRupees(bill.totalAmount)}</span>
                          <BillStatusBadge payment={bill} />
                        </span>
                      ) : (
                        '—'
                      ),
                  },
                ]}
              />
            )}
          </Card>
        ) : null}
      </div>
    </div>
  )
}

function PatientCell({ patientId, name, detail, onOpen }: { patientId: string; name: string; detail: string; onOpen: () => void }) {
  const care = usePatientCareStatus()
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {/* In the table only — a phone card keeps the room for the name. */}
      <span className="hidden shrink-0 tbl:inline-flex">
        <Avatar name={name} initials={initialsOf(name)} size="sm" />
      </span>
    <div className="min-w-0">
      <span className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="focus-ring -my-3 truncate rounded py-3 text-left font-medium text-ink underline-offset-2 hover:underline"
        >
          {name}
        </button>
        <PatientStatusIcons status={care[patientId]} />
      </span>
      <span className="block truncate text-xs font-normal text-ink-subtle">{detail}</span>
    </div>
    </div>
  )
}

function WardLabel({ ward, bed }: { ward: string | null; bed: string | null }) {
  return (
    <span className={cn('flex items-center gap-1.5', isCritical(ward) ? 'font-medium text-critical-fg' : 'text-ink')}>
      <WardIcon ward={ward} className="h-4 w-4 shrink-0" />
      <span className="min-w-0">
        {ward ?? '—'} · <span className="whitespace-nowrap">{bed ?? '—'}</span>
      </span>
    </span>
  )
}

/** One bed: who is in it (opens their profile), or whether it is free. */
function BedTile({ bed, occupant, onOpen }: { bed: Bed; occupant: Admission | null; onOpen: (patientId: string) => void }) {
  const free = bed.status === 'Available'
  const body = (
    <>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-ink">{bed.bedNumber}</span>
        {occupant ? <span className="block truncate text-xs text-ink-subtle">{occupant.patientName}</span> : null}
      </span>
      <Badge tone={free ? 'stable' : bed.status === 'Occupied' ? 'info' : 'neutral'} className="text-2xs">
        {bed.status}
      </Badge>
    </>
  )
  const tileClass = 'flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors'
  return (
    <li>
      {occupant ? (
        <button type="button" onClick={() => onOpen(occupant.patientId)} title={`${occupant.patientName} · open profile`} className={cn(tileClass, 'focus-ring border-info-fg/25 bg-info-bg hover:border-primary-600')}>
          {body}
        </button>
      ) : (
        <div className={cn(tileClass, free ? 'border-success-fg/25 bg-success-bg' : 'border-border-soft bg-surface-2')}>{body}</div>
      )}
    </li>
  )
}

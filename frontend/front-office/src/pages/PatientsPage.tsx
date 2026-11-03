import { useLocation, useNavigate } from 'react-router-dom'
import { Copy, UserPlus, Users } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { PatientIllustration } from '../components/ui/illustrations/PatientIllustration'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { Avatar } from '../components/ui/Avatar'
import { EmptyState } from '../components/ui/EmptyState'
import { ResponsiveTable } from '../components/ui/ResponsiveTable'
import type { Column } from '../components/ui/ResponsiveTable'
import { StatFilter } from '../components/ui/StatFilter'
import type { StatFilterItem } from '../components/ui/StatFilter'
import { useStoreValue } from '../hooks/useStore'
import { useNow } from '../hooks/useNow'
import { getPatientRows } from '../domain/patientSelectors'
import type { PatientListRow } from '../domain/patientSelectors'
import { todayKey } from '../domain/time'
import { formatRupees } from '../utils/billing'
import { initialsOf } from '../utils/format'
import { PatientsTabs } from '../components/patient/PatientsTabs'
import { PatientStatusIcons } from '../components/patient/PatientStatusIcons'
import { usePatientCareStatus } from '../hooks/useCareStatus'

type PatientFilter = 'all' | 'today' | 'duplicates'

const FILTERS: PatientFilter[] = ['all', 'today', 'duplicates']

function readFilter(search: string): PatientFilter {
  const value = new URLSearchParams(search).get('filter')
  return FILTERS.includes(value as PatientFilter) ? (value as PatientFilter) : 'all'
}

const EMPTY_TITLE: Record<PatientFilter, string> = {
  all: 'No patients yet',
  today: 'Nobody registered yet today',
  duplicates: 'No possible duplicates',
}

/**
 * Every registered patient, newest first — each figure is also the filter.
 * A row opens the patient's profile, where everything for them is done;
 * finding someone is the search in the app bar, so there is no second box.
 */
export function PatientsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const now = useNow(60000)
  const filter = readFilter(location.search)
  const rows = useStoreValue(getPatientRows)
  const care = usePatientCareStatus()

  const today = todayKey(new Date(now))
  const isToday = (row: PatientListRow) => todayKey(new Date(row.patient.createdAt)) === today
  const lists: Record<PatientFilter, PatientListRow[]> = {
    all: rows,
    today: rows.filter(isToday),
    duplicates: rows.filter((row) => row.duplicate),
  }
  const shown = lists[filter]

  function selectFilter(next: PatientFilter) {
    const query = new URLSearchParams(location.search)
    query.set('filter', next)
    // A filter is a view of this page, not a place — don't fill history.
    navigate({ search: `?${query.toString()}` }, { replace: true })
  }

  const items: StatFilterItem<PatientFilter>[] = [
    { key: 'all', label: 'All patients', value: rows.length, tone: 'info', icon: Users },
    { key: 'today', label: 'Registered today', value: lists.today.length, tone: 'teal', icon: UserPlus },
    { key: 'duplicates', label: 'Possible duplicates', value: lists.duplicates.length, tone: 'warning', icon: Copy },
  ]

  const openPatient = (uhid: string) => navigate(`/patients/${uhid}`)

  const columns: Column<PatientListRow>[] = [
    {
      key: 'patient',
      header: 'Patient',
      mobile: 'title',
      sortValue: (row) => row.patient.name,
      cell: ({ patient }) => (
        <div className="flex min-w-0 items-center gap-2.5">
          {/* In the table only — a phone card keeps the room for the name. */}
          <span className="hidden shrink-0 tbl:inline-flex">
            <Avatar name={patient.name} initials={initialsOf(patient.name)} size="sm" />
          </span>
          <div className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium text-ink tbl:whitespace-nowrap">{patient.name}</span>
              <PatientStatusIcons status={care[patient.patientId]} showDetail />
            </span>
          </div>
        </div>
      ),
    },
    {
      key: 'ageSex',
      header: 'Age / Sex',
      className: 'whitespace-nowrap text-ink-muted',
      sortValue: (row) => row.patient.age ?? -1,
      cell: ({ patient }) => `${patient.age ?? '—'} · ${patient.sex}`,
    },
    { key: 'uhid', header: 'UHID', className: 'whitespace-nowrap tabular-nums text-ink-muted', sortValue: (row) => row.patient.uhid, cell: ({ patient }) => patient.uhid },
    { key: 'mobile', header: 'Mobile', className: 'whitespace-nowrap tabular-nums text-ink-muted', cell: ({ patient }) => patient.mobile },
    {
      key: 'abha',
      header: 'ABHA',
      className: 'text-ink-muted',
      cell: ({ patient }) => (
        <span className="block tbl:max-w-[9rem] tbl:truncate xl:max-w-[12rem]" title={patient.abhaId ?? undefined}>
          {patient.abhaId ?? '—'}
        </span>
      ),
    },
    {
      key: 'now',
      header: 'Now',
      mobile: 'aside',
      cell: (row) => (
        <div className="flex flex-wrap justify-end gap-1.5 tbl:max-w-[13rem] tbl:justify-start">
          {isToday(row) ? <Badge tone="stable">Registered today</Badge> : null}
          {row.due > 0 ? (
            <Badge tone={row.failed ? 'critical' : 'warning'}>
              {row.failed ? 'Payment failed' : 'Payment pending'} · {formatRupees(row.due)}
            </Badge>
          ) : null}
          {row.duplicate ? <Badge tone="warning">Possible duplicate</Badge> : null}
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Patients"
        illustration={<PatientIllustration className="h-8 w-8" />}
        illustrationTone="teal"
        actions={
          <Button onClick={() => navigate('/register/new')}>
            <UserPlus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            {/* "Register" alone fits beside the title on a phone. */}
            <span className="sm:hidden">Register</span>
            <span className="hidden sm:inline">Register Patient</span>
          </Button>
        }
        tabs={<PatientsTabs />}
      />

      <div className="flex flex-col gap-4 sm:gap-5 mt-4 sm:mt-5">
        <StatFilter label="Show patients" items={items} selected={filter} onSelect={selectFilter} columns="sm:grid-cols-3" />

        <Card accentTone="teal">
          {shown.length === 0 ? (
            <EmptyState illustration={<PatientIllustration className="h-12 w-12" />} title={EMPTY_TITLE[filter]} />
          ) : (
            <ResponsiveTable
              rows={shown}
              columns={columns}
              rowKey={(row) => row.patient.patientId}
              onRowClick={(row) => openPatient(row.patient.uhid)}
              rowLabel={(row) => `Open ${row.patient.name}`}
              caption="Patients"
            />
          )}
        </Card>
      </div>
    </div>
  )
}

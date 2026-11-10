import { useState } from 'react'
import { Activity, BedDouble, CalendarPlus, ChartNoAxesCombined, IdCard, IndianRupee, ListChecks, LogOut, ReceiptText, UserCheck, UserPlus } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { Card, CardHeader } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { EmptyState } from '../components/ui/EmptyState'
import { StatCard } from '../components/frontoffice/StatCard'
import { TrendLineChart } from '../components/charts/TrendLineChart'
import { BreakdownBars } from '../components/charts/BreakdownBars'
import { useStoreValue } from '../hooks/useStore'
import { useNow } from '../hooks/useNow'
import { getToday } from '../domain/selectors'
import {
  ACTIVITY_INFO,
  ACTIVITY_TYPES,
  MAX_RANGE_DAYS,
  REPORT_PERIODS,
  activityTrend,
  paymentOverview,
  daysIn,
  eventsInRange,
  getActivityEvents,
  rangeFor,
  summarize,
  trendScaleFor,
} from '../domain/reportSelectors'
import type { ActivityEvent, ActivityType, ReportPeriod, ReportRange } from '../domain/reportSelectors'
import { addDaysToKey } from '../domain/selectors'
import { formatRupees } from '../utils/billing'
import { MONTH, timeLabel } from '../utils/activityFormat'
import { ActivityDetails } from '../components/activity/ActivityDetails'
import { TONE_HEX } from '../utils/toneHex'
import { figureRowClass } from '../utils/figure'
import { ResponsiveTable } from '../components/ui/ResponsiveTable'
import type { Column } from '../components/ui/ResponsiveTable'
import { cn } from '../utils/cn'
import { inputClass } from '../utils/formClasses'

/** The most recent rows the activity table lists (it scrolls inside its card). */
/** The activities the desk performs. Payments are not one of them: Care Entry takes no payment. */
const PAGE_TYPES = ACTIVITY_TYPES.filter((info) => info.type !== 'PAYMENT_COMPLETED')
type DetailType = Exclude<ActivityType, 'PAYMENT_COMPLETED'>

const RECENT_ROWS = 50


function shortDate(key: string): string {
  const [year, month, day] = key.split('-').map(Number)
  return `${day} ${MONTH[month - 1]} ${year}`
}

function rangeLabel(range: ReportRange): string {
  return range.from === range.to ? shortDate(range.from) : `${shortDate(range.from)} – ${shortDate(range.to)}`
}

/**
 * Activity & Analytics — what the front desk did over a period, built from the
 * same records the rest of the portal works on (see domain/reportSelectors).
 * The period sets every figure on the page; the activity filter narrows the
 * trend and the activity list, while the totals and the breakdown keep
 * showing every activity for comparison. The page only displays: it has no
 * action buttons. The summary cards choose which activity's records the
 * Activity Details table lists, on this same page — they never navigate; the
 * work itself is done in the modules that already exist.
 */
export function ActivityAnalyticsPage() {
  const today = useStoreValue(getToday)
  const now = useNow(60000)
  // Payments are summarised in their own overview below; the patient-level
  // records live in Payment Status, so they are not part of this activity list.
  const allEvents = useStoreValue(getActivityEvents).filter((e) => e.activityType !== 'PAYMENT_COMPLETED')

  const [period, setPeriod] = useState<ReportPeriod>('today')
  const [custom, setCustom] = useState<ReportRange>(() => ({ from: addDaysToKey(today, -6), to: today }))
  const [activityType, setActivityType] = useState<ActivityType | 'ALL'>('ALL')
  const [selected, setSelected] = useState<DetailType | 'PAYMENT_STATUS'>('PATIENT_REGISTERED')

  const range = rangeFor(period, today, custom)
  const capped = period === 'custom' && daysIn({ from: custom.from <= custom.to ? custom.from : custom.to, to: range.to }) > MAX_RANGE_DAYS

  const inPeriod = eventsInRange(allEvents, range)
  const summary = summarize(inPeriod)
  const filtered = activityType === 'ALL' ? inPeriod : inPeriod.filter((e) => e.activityType === activityType)
  const scale = trendScaleFor(period, range)
  const trend = activityTrend(filtered, range, scale, now, period === 'week')
  const perUnit = scale === 'hour' ? 'per hour' : 'per day'

  const multiDay = range.from !== range.to
  const rows = filtered.slice(0, RECENT_ROWS)
  const typeLabel = activityType === 'ALL' ? 'All activities' : ACTIVITY_INFO[activityType].label
  const trendColor = activityType === 'ALL' ? 'var(--color-chart-1)' : TONE_HEX[ACTIVITY_INFO[activityType].hue]

  const counts = summary.counts
  const payments = useStoreValue(paymentOverview)
  // Each summary card's own trend over the chosen period — its sparkline.
  const sparkOf = (type: ActivityType) =>
    activityTrend(
      inPeriod.filter((e) => e.activityType === type),
      range,
      scale,
      now,
      period === 'week',
    ).map((point) => point.value)
  const detailEvents = inPeriod.filter((e) => e.activityType === selected)
  const cancelledBookings = inPeriod.filter((e) => e.activityType === 'APPOINTMENT_SCHEDULED' && e.status === 'Cancelled').length

  return (
    <div>
      <PageHeader title="Activity & Analytics" />

      <div className="flex flex-col gap-4 sm:gap-5 mt-4 sm:mt-5">
        {/* Filters */}
        <section aria-label="Filters" className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-1 p-3 shadow-card lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <span className="text-xs font-semibold text-ink-muted">Date Range</span>
            <div className="flex flex-wrap gap-1 rounded-xl border border-[color-mix(in_oklab,var(--color-hue-blue)_18%,var(--color-border-soft))] bg-[color-mix(in_oklab,var(--color-hue-blue)_7%,var(--color-surface-1))] p-1" role="group" aria-label="Period">
              {REPORT_PERIODS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={option.key === period}
                  onClick={() => setPeriod(option.key)}
                  className={cn(
                    'focus-ring min-h-11 rounded-lg px-3.5 text-sm font-medium transition-colors',
                    option.key === period
                      ? 'bg-[image:var(--gradient-primary)] font-semibold text-on-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_4px_12px_-6px_rgba(37,99,235,0.55)]'
                      : 'text-ink-muted hover:bg-surface-1/70 hover:text-ink',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {period === 'custom' ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  value={custom.from}
                  max={today}
                  onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))}
                  className={inputClass}
                  aria-label="From date"
                />
                <span className="text-xs text-ink-muted">to</span>
                <input
                  type="date"
                  value={custom.to}
                  max={today}
                  onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))}
                  className={inputClass}
                  aria-label="To date"
                />
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-ink-muted">{rangeLabel(range)}</span>
            <span className="text-xs font-semibold text-ink-muted">Activity Type</span>
            <select
              value={activityType}
              onChange={(e) => {
                const next = e.target.value as ActivityType | 'ALL'
                setActivityType(next)
                if (next !== 'ALL' && next !== 'PAYMENT_COMPLETED') setSelected(next)
              }}
              className={cn(inputClass, 'w-full min-w-0 sm:w-auto sm:min-w-[13rem]')}
              aria-label="Activity type"
            >
              <option value="ALL">All Activities</option>
              {PAGE_TYPES.map((info) => (
                <option key={info.type} value={info.type}>
                  {info.label}
                </option>
              ))}
            </select>
          </div>
        </section>
        {capped ? (
          <p className="-mt-3 text-xs text-ink-muted">Showing the last {MAX_RANGE_DAYS} days of the chosen range.</p>
        ) : null}

        {/* Operational summary — information only. */}
        <h2 className="-mb-3 text-sm font-semibold text-ink">Operational Summary</h2>
        <section aria-label="Operational Summary" className={figureRowClass('sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7')}>
          <StatCard
            selected={selected === 'PATIENT_REGISTERED'}
            onSelect={() => setSelected('PATIENT_REGISTERED')}
            trend={sparkOf('PATIENT_REGISTERED')} hue="teal" icon={UserPlus} value={counts.PATIENT_REGISTERED} label="Patients Registered" />
          <StatCard
            selected={selected === 'APPOINTMENT_SCHEDULED'}
            onSelect={() => setSelected('APPOINTMENT_SCHEDULED')}
            trend={sparkOf('APPOINTMENT_SCHEDULED')}
            hue="blue"
            icon={CalendarPlus}
            value={counts.APPOINTMENT_SCHEDULED}
            label="Appointments Scheduled"
            hint={cancelledBookings ? `${cancelledBookings} later cancelled` : undefined}
          />
          <StatCard
            selected={selected === 'PATIENT_CHECKED_IN'}
            onSelect={() => setSelected('PATIENT_CHECKED_IN')}
            trend={sparkOf('PATIENT_CHECKED_IN')} hue="orange" icon={UserCheck} value={counts.PATIENT_CHECKED_IN} label="Patients Checked In" />
          <StatCard
            selected={selected === 'GUEST_PASS_ISSUED'}
            onSelect={() => setSelected('GUEST_PASS_ISSUED')}
            trend={sparkOf('GUEST_PASS_ISSUED')} hue="indigo" icon={IdCard} value={counts.GUEST_PASS_ISSUED} label="Guest Passes Issued" />
          <StatCard
            selected={selected === 'PATIENT_ADMITTED'}
            onSelect={() => setSelected('PATIENT_ADMITTED')}
            trend={sparkOf('PATIENT_ADMITTED')} hue="violet" icon={BedDouble} value={counts.PATIENT_ADMITTED} label="Admissions" />
          <StatCard
            selected={selected === 'PATIENT_DISCHARGED'}
            onSelect={() => setSelected('PATIENT_DISCHARGED')}
            trend={sparkOf('PATIENT_DISCHARGED')} hue="pink" icon={LogOut} value={counts.PATIENT_DISCHARGED} label="Discharges" />
          <StatCard
            selected={selected === 'PAYMENT_STATUS'}
            onSelect={() => setSelected('PAYMENT_STATUS')}
            hue="green"
            icon={IndianRupee}
            value={
              <span className="flex flex-col gap-0.5 text-base leading-tight">
                <span>Pending: {payments.pendingBills}</span>
                <span>Paid: {payments.paidBills}</span>
              </span>
            }
            label="Payment Status"
            hint={`${formatRupees(payments.pendingAmount)} pending`}
          />
        </section>

        {/* The records behind the chosen card */}
        {selected === 'PAYMENT_STATUS' ? (
          <Card accentTone="stable">
            <CardHeader icon={IndianRupee} iconTone="stable" title="Payment Status" />
            <div className="flex flex-col gap-3 p-4 sm:p-5">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <StatCard hue="blue" icon={ReceiptText} value={payments.totalBills} label="Total Bills" />
                <StatCard hue="indigo" icon={IndianRupee} value={formatRupees(payments.billedAmount)} label="Total Billed" />
                <StatCard hue="green" icon={IndianRupee} value={formatRupees(payments.receivedAmount)} label="Payment Received" />
                <StatCard hue="orange" icon={IndianRupee} value={formatRupees(payments.pendingAmount)} label="Pending Amount" />
                <StatCard hue="teal" icon={ReceiptText} value={payments.paidBills} label="Paid Bills" />
                <StatCard hue="red" icon={ReceiptText} value={payments.pendingBills} label="Pending Bills" />
              </div>
            </div>
          </Card>
        ) : (
          <ActivityDetails type={selected} events={detailEvents} periodLabel={rangeLabel(range)} withDate={multiDay} />
        )}

        {/* Trend + breakdown */}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card className="min-w-0" accentTone="brand">
            <CardHeader
              icon={ChartNoAxesCombined}
              iconTone="brand"
              title="Activity Trends"
              subtitle={`${typeLabel} · ${perUnit} · ${filtered.length} in total`}
            />
            <div className="px-4 pb-4 pt-3 sm:px-5">
              {filtered.length === 0 ? (
                <NoActivity />
              ) : (
                <TrendLineChart
                  points={trend}
                  color={trendColor}
                  ariaLabel={`${typeLabel} ${perUnit}, ${rangeLabel(range)}`}
                  xTitle={scale === 'hour' ? 'Hour of the day' : period === 'week' ? 'Day' : 'Date'}
                  yTitle={activityType === 'ALL' ? 'Number of activities' : `Number of ${typeLabel.toLowerCase()}`}
                />
              )}
            </div>
          </Card>

          <Card className="min-w-0" accentTone="brand">
            <CardHeader icon={ListChecks} iconTone="brand" title="Activity Breakdown" />
            <div className="px-4 pb-5 pt-4 sm:px-5">
              {summary.total === 0 ? (
                <NoActivity />
              ) : (
                <BreakdownBars
                  highlight={activityType === 'ALL' ? null : activityType}
                  items={PAGE_TYPES.map((info) => ({
                    key: info.type,
                    label: info.label,
                    value: counts[info.type],
                    hue: info.hue,
                  }))}
                />
              )}
            </div>
          </Card>
        </div>

        {/* Recent activity */}
        <Card accentTone="brand">
          <CardHeader
            icon={Activity}
            iconTone="brand"
            title="Recent Activity"
            subtitle={`${typeLabel} · ${rangeLabel(range)}`}
            action={<span className="text-xs tabular-nums text-ink-subtle">{filtered.length}</span>}
          />
          {filtered.length === 0 ? (
            <NoActivity />
          ) : (
            <>
              <ResponsiveTable
                rows={rows}
                rowKey={(event) => event.id}
                caption="Recent activity"
                listLimit={15}
                columns={activityColumns(multiDay)}
              />
              {filtered.length > rows.length ? (
                <p className="border-t border-border-soft px-5 py-3 text-xs text-ink-muted">
                  Showing the latest {rows.length} of {filtered.length}
                </p>
              ) : null}
            </>
          )}
        </Card>
      </div>
    </div>
  )
}

function activityColumns(withDate: boolean): Column<ActivityEvent>[] {
  return [
    { key: 'time', header: 'Time', mobile: 'subtitle', className: 'whitespace-nowrap tabular-nums text-ink-muted', cell: (event) => timeLabel(event.timestamp, withDate) },
    {
      key: 'activity',
      header: 'Activity',
      mobile: 'title',
      cell: (event) => {
        const info = ACTIVITY_INFO[event.activityType]
        return (
          <>
            <span className="flex items-center gap-2 font-medium text-ink">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: TONE_HEX[info.hue] }} aria-hidden="true" />
              {info.event}
              {event.amount !== undefined ? <span className="font-normal text-ink-muted">· {formatRupees(event.amount)}</span> : null}
            </span>
            {event.detail ? <span className="mt-0.5 block truncate pl-4 text-xs font-normal text-ink-subtle">{event.detail}</span> : null}
          </>
        )
      },
    },
    {
      key: 'patient',
      header: 'Patient',
      cell: (event) =>
        event.patientId ? (
          <>
            <span className="block truncate text-ink">{event.patientName ?? event.patientId}</span>
            <span className="block text-xs tabular-nums text-ink-subtle">{event.patientId}</span>
          </>
        ) : (
          <span className="text-ink-subtle">—</span>
        ),
    },
    { key: 'staff', header: 'Staff', className: 'whitespace-nowrap text-ink-muted', cell: (event) => event.staffName },
    { key: 'status', header: 'Status', mobile: 'aside', cell: (event) => <Badge tone={event.status === 'Completed' ? 'stable' : 'neutral'}>{event.status}</Badge> },
  ]
}

function NoActivity() {
  return <EmptyState icon={Activity} title="No activity found" />
}

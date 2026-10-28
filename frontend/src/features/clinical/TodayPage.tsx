import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../../api/client'
import { getStatusBoard } from '../../api/generated/endpoints/scheduling/scheduling'
import type { StatusBoardItem } from '../../api/generated/model'
import { Badge, Button, DataTable, Field, formatTime, minutesBetween, ProblemAlert, Select, Spinner, statusLabel, todayIn, type Column, type Problem } from '../../design-system'
import { allPages, useBookableProviders, useBookingReference } from '../scheduling/reference'

/** Visit steps where the patient is waiting for the next one, so the wait is worth showing. */
const WAITING = new Set(['arrived', 'checked-in', 'roomed'])

/** Checked in and not yet checked out: the rooming screen applies. */
const IN_CLINIC = new Set(['arrived', 'checked-in', 'roomed', 'with-provider'])

export const roomingPath = (encounterId: string) => `/visits/${encounterId}/rooming`

/**
 * The clinical team's day (demo step 7): today's patients at one facility from the status board's
 * staff view (D60), with each visit's step, how long the patient has waited, the room, and the way
 * into rooming once checked in. The board isn't live yet (Thulasi's event stream), so it refreshes
 * on demand.
 */
export function TodayPage() {
  const reference = useBookingReference()
  const [picked, setPicked] = useState('')
  const facility = reference.facilities?.find((f) => f.id === picked) ?? reference.facilities?.[0]
  const providers = useBookableProviders(facility?.id ?? '')
  const [providerId, setProviderId] = useState('')
  const [version, setVersion] = useState(0)
  const [result, setResult] = useState<{ key: string; items: StatusBoardItem[]; at: Date; problem: Problem | null } | null>(null)

  const day = facility ? todayIn(facility.timeZone) : ''
  const key = `${facility?.id}|${day}|${providerId}|${version}`
  useEffect(() => {
    if (!facility || !day) return
    let current = true
    allPages(async (cursor) => {
      const res = await getStatusBoard({ facilityId: facility.id, date: day, view: 'staff', ...(providerId ? { providerId } : {}), limit: 100, ...(cursor ? { cursor } : {}) })
      return res.status === 200 ? res.data : null
    })
      .then((items) => {
        if (current) setResult({ key, items, at: new Date(), problem: null })
      })
      .catch((error: unknown) => {
        if (!current) return
        if (error instanceof ApiError) setResult({ key, items: [], at: new Date(), problem: error.problem })
        else throw error
      })
    return () => {
      current = false
    }
  }, [key, facility, day, providerId])

  const shown = result?.key === key ? result : null
  const timeZone = facility?.timeZone ?? null

  const columns: Column<StatusBoardItem>[] = [
    { key: 'time', header: 'Time', render: (r) => formatTime(r.startAt, timeZone, { withZone: false }) },
    {
      key: 'patient',
      header: 'Patient',
      render: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          {r.patient?.displayName ?? r.initials}
          {r.patient?.restricted ? <Badge tone="warning">Restricted</Badge> : null}
        </span>
      ),
    },
    { key: 'provider', header: 'Provider', render: (r) => r.provider?.displayName ?? '—' },
    { key: 'type', header: 'Visit', render: (r) => r.appointmentType?.name ?? '—' },
    { key: 'reason', header: 'Reason', render: (r) => r.reasonForVisit ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span className="flex flex-col">
          <span>{statusLabel(r.status, r.visitStatus)}</span>
          {r.visitStatus && WAITING.has(r.visitStatus) && r.visitStatusAt && shown ? (
            <span className="text-xs text-ink-muted">{waitText(minutesBetween(r.visitStatusAt, shown.at))}</span>
          ) : null}
        </span>
      ),
    },
    { key: 'room', header: 'Room', render: (r) => r.roomName ?? '—' },
    {
      key: 'action',
      header: 'Action',
      render: (r) =>
        r.encounterId && r.visitStatus && IN_CLINIC.has(r.visitStatus) ? (
          <Link
            to={roomingPath(r.encounterId)}
            className="font-medium text-primary-700 underline-offset-2 hover:underline"
            aria-label={`${r.visitStatus === 'checked-in' || r.visitStatus === 'arrived' ? 'Room' : 'Open rooming for'} ${r.patient?.displayName ?? r.initials}`}
          >
            {r.visitStatus === 'checked-in' || r.visitStatus === 'arrived' ? 'Room' : 'Open'}
          </Link>
        ) : null,
    },
  ]

  return (
    <section aria-labelledby="today-title" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="today-title" className="text-2xl font-semibold text-ink">
          Today
        </h1>
        <Button variant="outline" size="sm" icon={<RefreshCw aria-hidden="true" size={14} />} onClick={() => setVersion((v) => v + 1)} disabled={!facility}>
          Refresh
        </Button>
      </div>
      {reference.problem ? <ProblemAlert problem={reference.problem} /> : null}
      {!reference.facilities ? (
        <Spinner label="Loading facilities" />
      ) : reference.facilities.length === 0 ? (
        <p className="text-ink-muted">You aren’t assigned to any facility.</p>
      ) : (
        <>
          <div className="grid gap-4 rounded-xl border border-border bg-surface-1 p-5 md:grid-cols-2">
            <Field label="Facility">
              {(p) => (
                <Select
                  {...p}
                  value={facility?.id ?? ''}
                  onChange={(e) => {
                    setPicked(e.target.value)
                    setProviderId('')
                  }}
                >
                  {reference.facilities!.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Provider">
              {(p) => (
                <Select {...p} value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                  <option value="">All providers</option>
                  {(providers ?? []).map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.displayName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {!shown ? (
            <Spinner label="Loading today’s patients" />
          ) : shown.problem ? (
            <ProblemAlert problem={shown.problem} />
          ) : (
            <DataTable
              caption={`${facility?.name ?? ''}, today: ${shown.items.length} ${shown.items.length === 1 ? 'patient' : 'patients'}`}
              columns={columns}
              rows={shown.items}
              rowKey={(r) => r.appointmentId}
              emptyTitle="No patients today"
            />
          )}
        </>
      )}
    </section>
  )
}

function waitText(minutes: number): string {
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `waiting ${minutes} min`
  return `waiting ${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

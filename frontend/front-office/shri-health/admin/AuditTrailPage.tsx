// SHRI_HEALTH: the audit trail, read only, newest first (listAuditEvents; audit-events:read; #402).
// Break-glass access can be shown on its own. Patients are named through POST /patients/summaries
// (D54), which audits each one as a chart access.
import { ScrollText } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { listAuditEvents } from '../../../src/api/generated/endpoints/platform/platform'
import { getPatientSummaries } from '../../../src/api/generated/endpoints/patients/patients'
import { AuditCategory, type AuditEvent } from '../../../src/api/generated/model'
import { Alert } from '../../src/components/ui/Alert'
import { Badge } from '../../src/components/ui/Badge'
import { Button } from '../../src/components/ui/Button'
import { Card, CardBody, CardHeader } from '../../src/components/ui/Card'
import { ResponsiveTable, type Column } from '../../src/components/ui/ResponsiveTable'
import { dayBefore, readFailure, when, words } from './format'

type Filters = { dateFrom: string; dateTo: string; category: AuditCategory | ''; breakGlass: boolean }

const OUTCOME_TONE = { success: 'stable', failure: 'critical', denied: 'warning' } as const

function columns(names: Record<string, string>): Column<AuditEvent>[] {
  return [
    { key: 'when', header: 'When', cell: (e) => <span className="tabular-nums">{when(e.recordedAt)}</span> },
    { key: 'actor', header: 'Who', cell: (e) => e.actor.displayName },
    {
      key: 'action',
      header: 'Action',
      cell: (e) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {words(e.action)}
          {e.breakGlassGrantId || e.action === 'break-glass' ? <Badge tone="critical">Break-glass</Badge> : null}
        </span>
      ),
    },
    { key: 'category', header: 'Category', cell: (e) => words(e.category) },
    { key: 'outcome', header: 'Outcome', cell: (e) => <Badge tone={OUTCOME_TONE[e.outcome]}>{words(e.outcome)}</Badge> },
    { key: 'patient', header: 'Patient', cell: (e) => (e.patientId ? (names[e.patientId] ?? 'Patient') : '—') },
    { key: 'record', header: 'Record', cell: (e) => (e.entityType ? words(e.entityType) : '—') },
    { key: 'reason', header: 'Reason', cell: (e) => e.reason ?? '—' },
  ]
}

export function AuditTrailPage() {
  const [filters, setFilters] = useState<Filters>({ dateFrom: dayBefore(6), dateTo: dayBefore(0), category: '', breakGlass: false })
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [next, setNext] = useState<string | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [names, setNames] = useState<Record<string, string>>({})

  const read = useCallback(
    async (cursor?: string) => {
      setBusy(true)
      setError(null)
      try {
        const res = await listAuditEvents({
          dateFrom: filters.dateFrom,
          dateTo: filters.dateTo,
          limit: 50,
          ...(filters.category ? { category: filters.category } : {}),
          ...(filters.breakGlass ? { breakGlass: true } : {}),
          ...(cursor ? { cursor } : {}),
        })
        if (res.status !== 200) throw new Error('unexpected')
        setEvents((prev) => (cursor && prev ? [...prev, ...res.data.items] : res.data.items))
        setNext(res.data.nextCursor ?? undefined)
        const unknown = [...new Set(res.data.items.map((e) => e.patientId).filter((id): id is string => Boolean(id)))]
        if (unknown.length) {
          const found = await getPatientSummaries({ patientIds: unknown.slice(0, 50) }).catch(() => null)
          if (found?.status === 200) {
            setNames((prev) => ({ ...prev, ...Object.fromEntries(found.data.items.map((p) => [p.id, [p.name.given?.join(' '), p.name.family].filter(Boolean).join(' ')])) }))
          }
        }
      } catch (err) {
        setError(readFailure(err, 'the audit trail'))
      } finally {
        setBusy(false)
      }
    },
    [filters],
  )

  useEffect(() => {
    void read()
  }, [read])

  return (
    <Card>
      <CardHeader icon={ScrollText} title="Audit trail" subtitle="Who did what, and when. Newest first; nothing here can be changed." />
      <CardBody className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            const data = new FormData(e.currentTarget)
            setFilters({
              dateFrom: String(data.get('dateFrom') || filters.dateFrom),
              dateTo: String(data.get('dateTo') || filters.dateTo),
              category: (String(data.get('category') ?? '') as AuditCategory | ''),
              breakGlass: data.get('breakGlass') === 'on',
            })
          }}
        >
          <label className="flex flex-col gap-1 text-sm text-ink-muted">
            From
            <input name="dateFrom" type="date" defaultValue={filters.dateFrom} className="min-h-11 rounded-lg border border-border bg-surface-1 px-3 text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink-muted">
            To
            <input name="dateTo" type="date" defaultValue={filters.dateTo} className="min-h-11 rounded-lg border border-border bg-surface-1 px-3 text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink-muted">
            Category
            <select name="category" defaultValue={filters.category} className="min-h-11 rounded-lg border border-border bg-surface-1 px-3 text-ink">
              <option value="">All</option>
              {Object.values(AuditCategory).map((c) => (
                <option key={c} value={c}>
                  {words(c)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
            <input name="breakGlass" type="checkbox" defaultChecked={filters.breakGlass} className="h-4 w-4 accent-primary-600" />
            Break-glass only
          </label>
          <Button type="submit" variant="secondary" loading={busy}>
            Show
          </Button>
        </form>
        {error ? <Alert tone="critical" title={error} /> : null}
        {events === null ? (
          <p role="status" className="text-sm text-ink-muted">
            Reading the audit trail…
          </p>
        ) : events.length === 0 ? (
          <p className="text-sm text-ink-muted">No events in these dates.</p>
        ) : (
          <ResponsiveTable rows={events} columns={columns(names)} rowKey={(e) => e.id} caption="Audit events" showFooter />
        )}
        {next ? (
          <Button variant="outline" loading={busy} onClick={() => void read(next)}>
            Show more
          </Button>
        ) : null}
      </CardBody>
    </Card>
  )
}

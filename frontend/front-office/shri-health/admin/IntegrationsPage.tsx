// SHRI_HEALTH: partner messages (the outbox and what partners sent), read only, newest first
// (listIntegrationMessages; integration-messages:read; #402). The simulated pharmacy and payer
// on the demo (D97, D99).
import { Waypoints } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { listIntegrationMessages } from '../../../src/api/generated/endpoints/platform/platform'
import { IntegrationMessageStatus, type IntegrationMessage } from '../../../src/api/generated/model'
import { Alert } from '../../src/components/ui/Alert'
import { Badge } from '../../src/components/ui/Badge'
import { Button } from '../../src/components/ui/Button'
import { Card, CardBody, CardHeader } from '../../src/components/ui/Card'
import { ResponsiveTable, type Column } from '../../src/components/ui/ResponsiveTable'
import { readFailure, when, words } from './format'

const PARTNER: Record<string, string> = { erx: 'Pharmacy (e-prescribing)', lab: 'Lab', clearinghouse: 'Clearinghouse', fax: 'Fax', notification: 'Notifications' }
const STATUS_TONE: Record<string, 'stable' | 'warning' | 'critical' | 'info'> = {
  queued: 'info',
  sending: 'info',
  sent: 'info',
  acknowledged: 'stable',
  received: 'stable',
  processed: 'stable',
  failed: 'warning',
  'dead-letter': 'critical',
}

const COLUMNS: Column<IntegrationMessage>[] = [
  { key: 'created', header: 'Created', cell: (m) => <span className="tabular-nums">{when(m.createdAt)}</span> },
  { key: 'partner', header: 'Partner', cell: (m) => PARTNER[m.partner] ?? words(m.partner) },
  { key: 'direction', header: 'Direction', cell: (m) => (m.direction === 'outbound' ? 'Sent' : 'Received') },
  { key: 'type', header: 'Message', cell: (m) => m.messageType },
  { key: 'status', header: 'Status', cell: (m) => <Badge tone={STATUS_TONE[m.status] ?? 'neutral'}>{words(m.status)}</Badge> },
  { key: 'attempts', header: 'Attempts', numeric: true, cell: (m) => m.attempts },
  { key: 'completed', header: 'Completed', cell: (m) => when(m.completedAt) },
  { key: 'error', header: 'Error', cell: (m) => m.errorCode ?? '—' },
]

export function IntegrationsPage() {
  const [status, setStatus] = useState<IntegrationMessageStatus | ''>('')
  const [messages, setMessages] = useState<IntegrationMessage[] | null>(null)
  const [next, setNext] = useState<string | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const read = useCallback(
    async (cursor?: string) => {
      setBusy(true)
      setError(null)
      try {
        const res = await listIntegrationMessages({ limit: 50, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) })
        if (res.status !== 200) throw new Error('unexpected')
        setMessages((prev) => (cursor && prev ? [...prev, ...res.data.items] : res.data.items))
        setNext(res.data.nextCursor ?? undefined)
      } catch (err) {
        setError(readFailure(err, 'the partner messages'))
      } finally {
        setBusy(false)
      }
    },
    [status],
  )

  useEffect(() => {
    void read()
  }, [read])

  return (
    <Card>
      <CardHeader icon={Waypoints} title="Partner messages" subtitle="Messages to and from the pharmacy, lab and other partners, newest first." />
      <CardBody className="space-y-4">
        <label className="flex max-w-xs flex-col gap-1 text-sm text-ink-muted">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as IntegrationMessageStatus | '')} className="min-h-11 rounded-lg border border-border bg-surface-1 px-3 text-ink">
            <option value="">All</option>
            {Object.values(IntegrationMessageStatus).map((s) => (
              <option key={s} value={s}>
                {words(s)}
              </option>
            ))}
          </select>
        </label>
        {error ? <Alert tone="critical" title={error} /> : null}
        {messages === null ? (
          <p role="status" className="text-sm text-ink-muted">
            Reading the partner messages…
          </p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-ink-muted">No partner messages.</p>
        ) : (
          <ResponsiveTable rows={messages} columns={COLUMNS} rowKey={(m) => m.id} caption="Partner messages" showFooter />
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

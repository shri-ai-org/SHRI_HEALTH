import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ApiError } from '../../../api/client'
import { listCoverages } from '../../../api/generated/endpoints/patients/patients'
import type { Coverage, CoverageList } from '../../../api/generated/model'
import { Badge, Button, DataTable, formatDate, ProblemAlert, todayIn, type Column, type Problem } from '../../../design-system'
import { AddCoverageDialog } from './AddCoverageDialog'
import { EnteredInErrorDialog } from './EnteredInErrorDialog'
import { priorityLabel, RELATIONSHIP } from './labels'

const PAGE_SIZE = 100

/** The browser's date; the facility's own time zone comes with the facility in C3. */
const today = () => todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone)

function statusBadge(c: Coverage, on: string) {
  if (c.status === 'entered-in-error') return <Badge tone="neutral">Entered in error</Badge>
  if (c.status === 'cancelled') return <Badge tone="neutral">Cancelled</Badge>
  if (c.status === 'draft') return <Badge tone="info">Draft</Badge>
  if (c.endDate && c.endDate < on) return <Badge tone="neutral">Ended</Badge>
  if (c.startDate && c.startDate > on) return <Badge tone="info">Not started</Badge>
  return <Badge tone="success">Active</Badge>
}

/** Every page of the patient's coverages: entered-in-error rows add up over the years. */
async function listAllCoverages(patientId: string): Promise<Coverage[]> {
  const items: Coverage[] = []
  let cursor: string | undefined
  do {
    const res = await listCoverages(patientId, { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) })
    if (res.status !== 200) break
    const page: CoverageList = res.data
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return items
}

/**
 * The patient's insurance (inventory #37–39, #232). Add a coverage, or mark one recorded by mistake
 * as entered in error (D45); nothing is deleted (D14). A coverage that ended keeps its row.
 */
export function InsurancePanel({ patientId }: { patientId: string }) {
  const [items, setItems] = useState<Coverage[] | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [adding, setAdding] = useState(false)
  const [marking, setMarking] = useState<Coverage | null>(null)

  // Bumped after an add or a correction, to read the list again.
  const [version, setVersion] = useState(0)
  const reload = () => setVersion((v) => v + 1)

  useEffect(() => {
    let current = true
    listAllCoverages(patientId)
      .then((all) => {
        if (!current) return
        setItems(all)
        setProblem(null)
      })
      .catch((error: unknown) => {
        if (!current) return
        if (error instanceof ApiError) setProblem(error.problem)
        else throw error
      })
    return () => {
      current = false
    }
  }, [patientId, version])

  const on = today()
  // `order` is unique among active coverages only.
  const active = (items ?? []).filter((c) => c.status === 'active' && !(c.endDate && c.endDate < on))
  const nextOrder = Math.min(9, Math.max(0, ...active.map((c) => c.order)) + 1)

  const columns: Column<Coverage>[] = [
    { key: 'order', header: 'Priority', render: (c) => priorityLabel(c.order) },
    { key: 'payer', header: 'Insurance', render: (c) => <span className="font-medium">{c.payerName ?? '—'}</span> },
    { key: 'member', header: 'Member ID', render: (c) => <span className="tabular-nums">{c.memberId}</span> },
    { key: 'group', header: 'Group', render: (c) => c.groupNumber ?? '—' },
    { key: 'relationship', header: 'Relationship', render: (c) => RELATIONSHIP[c.relationshipToSubscriber] },
    {
      key: 'dates',
      header: 'Dates',
      render: (c) => (c.startDate || c.endDate ? `${c.startDate ? formatDate(c.startDate) : '…'} – ${c.endDate ? formatDate(c.endDate) : 'no end date'}` : '—'),
    },
    { key: 'status', header: 'Status', render: (c) => statusBadge(c, on) },
    {
      key: 'actions',
      header: 'Actions',
      render: (c) =>
        c.status === 'entered-in-error' ? null : (
          <Button variant="ghost" size="sm" onClick={() => setMarking(c)} aria-label={`Mark ${c.payerName ?? 'this coverage'} entered in error`}>
            Mark as error
          </Button>
        ),
    },
  ]

  return (
    <section aria-labelledby="insurance-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="insurance-title" className="text-lg font-semibold text-ink">
          Insurance
        </h2>
        <Button variant="outline" icon={<Plus aria-hidden="true" size={16} />} onClick={() => setAdding(true)}>
          Add insurance
        </Button>
      </div>
      {problem ? <ProblemAlert problem={problem} /> : null}
      {items ? (
        <DataTable
          caption="Insurance coverages"
          columns={columns}
          rows={items}
          rowKey={(c) => c.id}
          emptyTitle="No insurance on file"
          emptyDescription="Add the patient's insurance, or leave it empty for self-pay."
        />
      ) : null}
      {adding ? (
        <AddCoverageDialog
          patientId={patientId}
          nextOrder={nextOrder}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            reload()
          }}
        />
      ) : null}
      {marking ? (
        <EnteredInErrorDialog
          patientId={patientId}
          coverage={marking}
          onClose={() => setMarking(null)}
          onStale={reload}
          onMarked={() => {
            setMarking(null)
            reload()
          }}
        />
      ) : null}
    </section>
  )
}

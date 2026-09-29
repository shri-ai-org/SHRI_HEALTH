/**
 * S-09-03 · Orders — `/encounter/:id/orders` (`src/screens/m09/S0903.tsx`):
 * "Which orders are actually happening."
 *
 * AI-308 closes the loop: it chases an order that has not moved. The fallback
 * is "a manual order status list", which is exactly what this screen is
 * underneath — the chasing is the addition, not the list, so with the AI off
 * the list stays and the chasing goes. It opens on what is still open;
 * resulted and earlier orders are one tap away; voided ones stay visible,
 * folded, with the reason recorded against them.
 *
 * Where the old list fell short: a void records the chosen reason and the
 * words added to it (the old one kept one or the other), is on the audit trail
 * and is sent to the performing department, as its copy says; the reason no
 * longer starts as a transfer reason; a resulted order opens its own result
 * where there is one; the rows' actions are real buttons; and the order is the
 * one the header names.
 */

import { ArrowRight, ClipboardList, Info, Plus } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { RESULTS, ordersFor, type Encounter, type OrderRow } from '@/data/clinical'
import { NOW, formatDate, formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { useClinical, type OrderPriority } from '@/store/clinical'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { encounterLabel, maybeEncounter } from '../logic/encounter'
import { CANCEL_REASONS, useVoidOrder } from '../logic/orders'
import { useScope } from '../logic/scope'
import { NoSuchEncounter } from '../notes/ConsultationPage'
import { useAiActive } from '../state/ai'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Disclosure, Why } from '../ui/Disclosure'
import { EmptyState } from '../ui/EmptyState'
import { Select } from '../ui/forms'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import { RankedSort } from '../ui/RankedSort'
import { Segmented } from '../ui/Segmented'
import { VoiceField } from '../ui/VoiceField'

type Scope = 'open' | 'resulted' | 'earlier'
const SCOPES: readonly Scope[] = ['open', 'resulted', 'earlier']
const START_OF_TODAY = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate())

type Row = OrderRow & { priority?: OrderPriority; voidReason?: string }

export function OrdersPage() {
  const { id } = useParams()
  const enc = maybeEncounter(id)
  if (!enc) return <NoSuchEncounter id={id} screenId="S-09-03" />
  return <Orders key={enc.id} enc={enc} />
}

function Orders({ enc }: { enc: Encounter }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const aiActive = useAiActive()
  const placed = useClinical((s) => s.placedOrders)
  const cancelled = useClinical((s) => s.cancelledOrders)
  const voidOrder = useVoidOrder()

  const [aiSort, setAiSort] = useState(true)
  const [cancelling, setCancelling] = useState<Row | null>(null)
  const [reason, setReason] = useState(CANCEL_REASONS[0])
  const [reasonText, setReasonText] = useState('')
  const [scope, setScope] = useScope(SCOPES, 'open')

  const p = patient(enc.patientId)
  const basket = `/encounter/${enc.id}/orders/new`

  /** Orders placed from the basket join the list — this encounter's, under their own ids and priorities. */
  const session: Row[] = placed
    .filter((o) => (o.encounterId ? o.encounterId === enc.id : o.patientId === p.id))
    .map((o) => ({
      id: o.id,
      patientId: p.id,
      item: o.item,
      category: 'Lab' as const,
      placedAt: new Date(o.at),
      placedBy: o.by,
      status: 'Ordered' as const,
      priority: o.priority,
    }))

  const all: Row[] = [...session, ...ordersFor(p.id)].map((o) =>
    cancelled[o.id] ? { ...o, status: 'Cancelled' as const, voidReason: cancelled[o.id].reason } : o,
  )
  // Chasing first only while AI-308 is live to chase; otherwise, and on the other choice, the newest first.
  const byAi = aiActive && aiSort
  const sort = (rows: Row[]) => [...rows].sort((a, b) => (byAi ? (b.chase ? 1 : 0) - (a.chase ? 1 : 0) : 0) || b.placedAt.getTime() - a.placedAt.getTime())

  const open = sort(all.filter((o) => o.status !== 'Resulted' && o.status !== 'Cancelled'))
  const resulted = sort(all.filter((o) => o.status === 'Resulted'))
  const earlier = sort(all.filter((o) => o.placedAt.getTime() < START_OF_TODAY.getTime()))
  const voided = sort(all.filter((o) => o.status === 'Cancelled'))
  const chasing = aiActive ? open.filter((o) => o.chase) : []
  const rows = scope === 'open' ? open : scope === 'resulted' ? resulted : earlier

  /** A resulted order opens its own result where the record has it, the inbox otherwise. */
  const resultFor = (o: Row) => RESULTS.find((r) => r.patientId === o.patientId && r.test === o.item)

  function confirmVoid() {
    if (!cancelling) return
    // The reason chosen, and whatever was added to it — both are the record.
    const recorded = reasonText.trim() ? `${reason} — ${reasonText.trim()}` : reason
    voidOrder({ orderId: cancelling.id, item: cancelling.item, patientId: p.id, reason: recorded, where: encounterLabel(enc), returnTo: `/encounter/${enc.id}/orders` })
    setCancelling(null)
    setReasonText('')
  }

  const row = (o: Row, i: number) => {
    const result = o.status === 'Resulted' ? resultFor(o) : undefined
    return (
      <li key={o.id} className={cn('flex flex-wrap items-center gap-x-[12px] gap-y-[6px] px-[10px] py-[10px]', i > 0 && 'border-t border-sh-line')}>
        <span className="inline-flex h-[32px] min-w-[64px] shrink-0 items-center justify-center rounded-[10px] bg-sh-inner px-[10px] text-[13px] font-bold tabular-nums text-sh-text-2">
          {o.placedAt.getTime() < START_OF_TODAY.getTime() ? formatDate(o.placedAt).replace(/-\d{4}$/, '') : formatTime(o.placedAt)}
        </span>
        <span className="min-w-0 flex-1 basis-[240px]">
          <span className="flex flex-wrap items-center gap-[8px]">
            <span className="text-[15px] font-semibold text-sh-text">{o.item}</span>
            {o.priority && o.priority !== 'Routine' && (
              <PillTag tone={o.priority === 'Stat' ? 'crit' : 'warn'} size="xs" className="font-semibold">
                {o.priority}
              </PillTag>
            )}
          </span>
          <span className="flex flex-wrap gap-x-[8px] text-[12px] text-sh-text-3">
            <span className={cn(o.status === 'Overdue' && 'font-semibold text-sh-warn-fg', o.status === 'Resulted' && 'text-sh-norm-fg')}>
              {o.status === 'Resulted' ? 'Resulted · loop closed' : o.status === 'Cancelled' ? 'Voided' : o.status}
            </span>
            {aiActive && o.chase && o.status !== 'Cancelled' && <span className="text-sh-warn-fg">· chasing · {o.chase}</span>}
            <span>· {o.placedBy}</span>
            {o.voidReason && <span>· {o.voidReason}</span>}
          </span>
        </span>
        <span className="shrink-0">
          {o.status === 'Resulted' ? (
            <Pill variant="control" size="md" aria-label={`Result — ${o.item}`} onClick={() => navigate(result ? `/results/${result.id}` : '/results/inbox')}>
              Result
              <Icon icon={ArrowRight} size={13} />
            </Pill>
          ) : o.status === 'Cancelled' ? (
            <span className="text-[12px] text-sh-text-3">voided</span>
          ) : (
            <Pill
              variant="ghost"
              size="md"
              aria-label={`Cancel ${o.item}`}
              onClick={() => {
                // Each void is its own decision: the reason starts from the first, not from the last one chosen.
                setReason(CANCEL_REASONS[0])
                setCancelling(o)
              }}
            >
              Cancel
            </Pill>
          )}
        </span>
      </li>
    )
  }

  const emptyWhy =
    scope === 'open'
      ? 'Nothing is open on this encounter. Everything placed has resulted or been voided.'
      : scope === 'resulted'
        ? 'No order on this encounter has resulted yet.'
        : 'No orders were placed on this encounter before today.'

  return (
    <>
      <ScreenFrame
        screenId="S-09-03"
        patient={p}
        heading="Orders"
        sub={`${open.length} open${chasing.length > 0 ? ` · ${chasing.length} being chased` : ''}${resulted.length > 0 ? ` · ${resulted.length} resulted` : ''}`}
        actions={
          may(basket) && (
            <Pill variant="primary" size="xl" icon={Plus} iconSize={17} onClick={() => navigate(basket)}>
              New order
            </Pill>
          )
        }
      >
        <div className="flex max-w-[896px] flex-col gap-[16px]">
          <div className="flex flex-wrap items-center justify-between gap-[12px]">
            <Segmented
              label="Which orders"
              value={scope}
              onChange={setScope}
              options={[
                { key: 'open', label: 'Open', count: open.length },
                { key: 'resulted', label: 'Resulted', count: resulted.length },
                { key: 'earlier', label: 'Earlier', count: earlier.length },
              ]}
            />
            <RankedSort aiSort={aiSort} onChange={setAiSort} aiLabel="Needs chasing first" deterministicLabel="Most recent first" capabilityId="AI-308" label="Sort the orders" />
          </div>

          <Card className="p-[8px]">
            {rows.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                why={emptyWhy}
                action={
                  scope === 'open' &&
                  may(basket) && (
                    <Pill variant="primary" size="md" onClick={() => navigate(basket)}>
                      Open the order basket
                    </Pill>
                  )
                }
              />
            ) : (
              <>
                <ul aria-label={`Orders on ${enc.encounterNo}`} className="flex flex-col">
                  {rows.map(row)}
                </ul>
                <p className="border-t border-sh-line px-[10px] pb-[4px] pt-[10px] text-[12px] tabular-nums text-sh-text-3">
                  {rows.length} {rows.length === 1 ? 'order' : 'orders'}
                </p>
              </>
            )}
          </Card>

          {scope === 'open' && voided.length > 0 && (
            <Disclosure label="voided" count={voided.length}>
              <Card className="p-[8px]">
                <ul aria-label="Voided orders on this encounter" className="flex flex-col">
                  {voided.map(row)}
                </ul>
              </Card>
            </Disclosure>
          )}

          <Why label="Why some orders are chased">
            <p>
              An order that has not moved inside its expected window is chased, with the blocking step named. Without it this screen is still a status list — the chasing is
              what stops an order quietly going nowhere. AI-308 · the deterministic sort is one click away.
            </p>
          </Why>
        </div>
      </ScreenFrame>

      <ConfirmDialog
        open={cancelling !== null}
        title={`Cancel ${cancelling?.item ?? ''}?`}
        consequence="The order is voided, not deleted. It stays visible with your reason recorded against it, and the performing department is notified."
        confirmLabel="Void this order"
        tone="destructive"
        onConfirm={confirmVoid}
        onCancel={() => {
          setCancelling(null)
          setReasonText('')
        }}
      >
        <div className="flex flex-col gap-[12px]">
          <Select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Cancellation reason">
            {CANCEL_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <VoiceField id="cancel-order-note" label="Anything to add" rows={2} value={reasonText} onChange={setReasonText} placeholder="Anything to add…" />
          <p className="flex items-start gap-[8px] text-[12px] text-sh-text-3">
            <Icon icon={Info} size={13} className="mt-[2px] shrink-0" />A reason is mandatory on cancel, and the record keeps both the order and the void.
          </p>
        </div>
      </ConfirmDialog>
    </>
  )
}

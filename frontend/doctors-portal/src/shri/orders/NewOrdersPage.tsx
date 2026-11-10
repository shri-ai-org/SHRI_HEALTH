/**
 * S-09-01 · New orders — `/encounter/:id/orders/new` (`src/screens/m09/
 * S0901.tsx`): "One basket for everything a clinician can order."
 *
 * AI-301 proposes orders from context (AIP-03, G2) and AI-304 flags the
 * duplicate before it is placed rather than after — "retrospective stewardship
 * review" is the fallback, and catching it at the basket is the point. The
 * duplicate warning is said once, on the line it belongs to; the LOW-band
 * suggestion is folded so it cannot be accepted by reflex.
 *
 * Where the old basket fell short, this one keeps its rules: the basket is
 * kept with the encounter; each order is placed under its own id, with the
 * priority chosen for it and on the audit trail; AI-304's flag is a G2
 * decision — Remove it, or Order anyway with one of the fixed reasons — that
 * Place waits for; AI-301's suggestions are offered only on the record they
 * were drawn from; and a set chosen on S-09-02 arrives applied.
 */

import { ClipboardList, Layers, Plus, Send, Trash2, ArrowLeft } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { ordersFor, type Encounter } from '@/data/clinical'
import { NOW, formatDateTime, formatTime } from '@/data/format'
import { TESTS, patient } from '@/data/kit'
import { useAI, useOutstanding } from '@/store/ai'
import { useAudit } from '@/store/audit'
import { useClinical, type BasketLine, type OrderPriority } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { encounterLabel, maybeEncounter } from '../logic/encounter'
import { duplicateCheck, suggestionsFor } from '../logic/orders'
import { isoDay, libraryOn } from '../logic/ordersets'
import { NoSuchEncounter } from '../notes/ConsultationPage'
import { useAiActive } from '../state/ai'
import { RejectDialog, SuggestionCard } from '../ui/ai'
import { Disclosure } from '../ui/Disclosure'
import { EmptyState } from '../ui/EmptyState'
import { Select, TextInput } from '../ui/forms'
import { Card, Diamond, Icon, Pill } from '../ui/primitives'
import { ValidationSummary } from '../ui/states'

const NO_LINES: BasketLine[] = []
const PRIORITIES: OrderPriority[] = ['Routine', 'Urgent', 'Stat']

export function NewOrdersPage() {
  const { id } = useParams()
  const enc = maybeEncounter(id)
  if (!enc) return <NoSuchEncounter id={id} screenId="S-09-01" />
  return <NewOrders key={enc.id} enc={enc} />
}

function NewOrders({ enc }: { enc: Encounter }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const aiActive = useAiActive()
  const recordDisposition = useAI((s) => s.record)
  const dispositions = useAI((s) => s.dispositions)
  const [params, setParams] = useSearchParams()

  const lines = useClinical((s) => s.orderBaskets[enc.id]?.lines) ?? NO_LINES
  const placed = useClinical((s) => s.placedOrders)
  const cancelled = useClinical((s) => s.cancelledOrders)
  const createdSets = useClinical((s) => s.createdSets)
  const promotedSets = useClinical((s) => s.promotedSets)
  const basketAdd = useClinical((s) => s.basketAdd)
  const basketUpdate = useClinical((s) => s.basketUpdate)
  const basketRemove = useClinical((s) => s.basketRemove)
  const basketClear = useClinical((s) => s.basketClear)
  const placeOrders = useClinical((s) => s.placeOrders)

  const [search, setSearch] = useState('')
  const [rejecting, setRejecting] = useState<BasketLine | null>(null)
  const [showValidation, setShowValidation] = useState(false)
  const arrived = useRef(false)

  const p = patient(enc.patientId)
  const library = libraryOn(isoDay(NOW), createdSets, promotedSets)
  const suggestions = aiActive ? suggestionsFor(p.id) : []
  const matches = search.trim() ? TESTS.filter((t) => t.toLowerCase().includes(search.trim().toLowerCase())) : TESTS.slice(0, 6)
  const active =
    ordersFor(p.id).filter((o) => o.status !== 'Cancelled' && o.status !== 'Resulted').length +
    placed.filter((o) => o.encounterId === enc.id && !cancelled[o.id]).length

  const touchpoint = (l: BasketLine) => `${enc.id}:dup:${l.id}`
  // G2 — each duplicate flag needs a decision before Place, while the AI is live to show it.
  const outstanding = useOutstanding(aiActive ? lines.filter((l) => l.duplicateOf).map(touchpoint) : [])
  const canPlace = lines.length > 0 && outstanding === 0

  function add(item: string) {
    if (lines.some((b) => b.item === item)) return
    basketAdd(enc.id, [{ item, priority: 'Routine', duplicateOf: aiActive ? duplicateCheck(item, p.id) : undefined }])
    setSearch('')
  }

  function applySet(setId: string) {
    const set = library.find((s) => s.id === setId)
    if (!set) return
    const current = useClinical.getState().orderBaskets[enc.id]?.lines ?? []
    const fresh = set.items.filter((i) => !current.some((b) => b.item === i))
    basketAdd(
      enc.id,
      fresh.map((item) => ({ item, priority: 'Routine' as const, duplicateOf: aiActive ? duplicateCheck(item, p.id) : undefined })),
    )
    toast({ tone: 'info', title: `${set.name} applied`, detail: `${fresh.length} ${fresh.length === 1 ? 'order' : 'orders'} added to the basket.` })
  }

  // A set chosen on S-09-02 arrives applied — once, and the address forgets it, so a reload does not apply it twice.
  useEffect(() => {
    const setId = params.get('set')
    if (!setId || arrived.current) return
    arrived.current = true
    applySet(setId)
    const next = new URLSearchParams(params)
    next.delete('set')
    setParams(next, { replace: true })
    // The address is read once, on arrival.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function removeAsSuggested(l: BasketLine) {
    recordDisposition({ touchpointId: touchpoint(l), disposition: 'Accepted', by: me.name, modelVersion: 'low-value v1.5.0', confidence: 'MED' })
    basketRemove(enc.id, l.id)
  }

  function place() {
    if (!canPlace) {
      setShowValidation(true)
      return
    }
    const n = lines.length
    placeOrders(
      lines.map((l) => ({ id: `O-${enc.id}-${l.id}`, item: l.item, priority: l.priority, encounterId: enc.id })),
      p.id,
      me.name,
      NOW.toISOString(),
    )
    audit({
      event: 'ORDER.PLACED',
      actor: me.name,
      actorId: me.id,
      subject: p.id,
      detail: `${lines.map((l) => `${l.item}${l.priority === 'Routine' ? '' : ` (${l.priority})`}`).join(', ')} · ${encounterLabel(enc)}`,
    })
    toast({ tone: 'success', title: `${n} ${n === 1 ? 'order' : 'orders'} placed`, detail: 'They appear on the active orders screen and in the performing department queue.' })
    basketClear(enc.id)
    setShowValidation(false)
    const list = `/encounter/${enc.id}/orders`
    if (may(list)) navigate(list)
  }

  const confident = suggestions.map((s, i) => ({ ...s, i })).filter((s) => s.band !== 'LOW')
  const low = suggestions.map((s, i) => ({ ...s, i })).filter((s) => s.band === 'LOW')
  const suggestion = (s: (typeof confident)[number]) => (
    <SuggestionCard
      key={s.item}
      touchpointId={`${enc.id}:order-sug-${s.i}`}
      capabilityId="AI-301"
      title={s.item}
      evidence={s.evidence}
      band={s.band}
      score={s.confidence}
      gate="G2"
      onAccept={() => add(s.item)}
      explain={{
        touchpointId: `${enc.id}:order-sug-${s.i}`,
        capabilityId: 'AI-301',
        claim: `${s.item} is suggested from the current clinical picture.`,
        confidence: s.confidence,
        band: s.band,
        computedAt: formatTime(NOW),
        inputs: [
          { label: 'Recent results', source: 'Results, last 72 hours' },
          { label: 'Charted vitals', source: 'Flowsheet, most recent set' },
          { label: 'Active problem list', source: `Problems for ${p.id}` },
        ],
        evidence: [s.evidence],
        model: 'order-sug v3.0.2',
        limits: [
          'Suggests from the structured record; it does not examine the patient.',
          'Manual order search is always available.',
          'It does not know your local turnaround times, so urgency is yours to set.',
        ],
      }}
    />
  )

  const flagged = lines.filter((l) => l.duplicateOf && aiActive).length

  return (
    <>
      <ScreenFrame
        screenId="S-09-01"
        patient={p}
        heading="New orders"
        sub={`${active} open on this encounter${suggestions.length > 0 ? ` · ${suggestions.length} suggestions` : ''}`}
        rail={
          suggestions.length > 0 ? (
            <div className="flex flex-col gap-[12px]">
              {confident.map(suggestion)}
              {low.length > 0 && (
                <Disclosure label="low-confidence suggestion" count={low.length}>
                  <div className="flex flex-col gap-[12px]">{low.map(suggestion)}</div>
                </Disclosure>
              )}
            </div>
          ) : undefined
        }
        railTitle="Suggestions"
        railBadge={suggestions.length || undefined}
        actionBar={
          <>
            {may(`/encounter/${enc.id}/orders`) && (
              <Pill variant="control" size="lg" icon={ArrowLeft} onClick={() => navigate(`/encounter/${enc.id}/orders`)}>
                Active orders
              </Pill>
            )}
            <span className="text-[13px] tabular-nums text-sh-text-2">
              {lines.length} {lines.length === 1 ? 'order' : 'orders'}
              {flagged > 0 && ` · ${flagged} flagged as duplicate`}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-[12px]">
              {outstanding > 0 && (
                <span className="text-[13px] font-medium text-sh-warn-fg">
                  {outstanding} duplicate {outstanding === 1 ? 'flag needs' : 'flags need'} a decision
                </span>
              )}
              <Pill
                variant="primary"
                size="lg"
                icon={Send}
                aria-disabled={!canPlace}
                title={canPlace ? undefined : lines.length === 0 ? 'The basket is empty' : 'Every duplicate flag needs Remove it or Order anyway'}
                className={cn(!canPlace && 'opacity-40')}
                onClick={place}
              >
                {lines.length > 0 ? `Place ${lines.length} ${lines.length === 1 ? 'order' : 'orders'}` : 'Place orders'}
              </Pill>
            </div>
          </>
        }
      >
        {showValidation && !canPlace && (
          <ValidationSummary
            problems={[
              ...(lines.length === 0 ? [{ field: 'Basket', message: 'Nothing to place yet — search, apply an order set, or accept a suggestion' }] : []),
              ...(outstanding > 0 ? [{ field: 'AI-304', message: `${outstanding} duplicate ${outstanding === 1 ? 'flag needs' : 'flags need'} a decision` }] : []),
            ]}
          />
        )}

        <div className="grid grid-cols-1 gap-[16px] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] xl:items-start">
          {/* Z5a — the catalogue and the order sets. */}
          <Card titleSize="sm" title="What to order">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                // Enter adds the top match to the basket. It never places the basket.
                if (e.key === 'Enter' && matches[0]) {
                  e.preventDefault()
                  add(matches[0])
                }
              }}
              aria-label="Search tests, imaging and procedures"
              placeholder="Search tests, imaging and procedures…"
              autoComplete="off"
            />
            <ul className="mt-[10px] flex flex-col gap-[2px]" aria-label="Catalogue matches">
              {matches.length === 0 && <li className="px-[12px] py-[10px] text-[13px] text-sh-text-3">Nothing in the catalogue matches “{search.trim()}”.</li>}
              {matches.map((t) => {
                const inBasket = lines.some((b) => b.item === t)
                const dup = aiActive && duplicateCheck(t, p.id)
                return (
                  <li key={t}>
                    <button
                      type="button"
                      onClick={() => add(t)}
                      disabled={inBasket}
                      className="flex min-h-[44px] w-full items-center gap-[10px] rounded-[12px] px-[12px] py-[8px] text-left transition-colors duration-150 hover:bg-sh-hover disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <Icon icon={Plus} size={14} className="shrink-0 text-sh-text-3" />
                      <span className="min-w-0 flex-1 truncate text-[14px] text-sh-text">{t}</span>
                      {inBasket ? <span className="shrink-0 text-[12px] text-sh-text-3">in the basket</span> : dup && <span className="shrink-0 text-[12px] text-sh-text-3">ordered today</span>}
                    </button>
                  </li>
                )
              })}
            </ul>

            <h3 className="mt-[16px] text-[13px] font-semibold text-sh-text-2">Order sets</h3>
            <ul className="mt-[6px] flex flex-col gap-[2px]" aria-label="Order sets">
              {library.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => applySet(s.id)}
                    className="flex min-h-[44px] w-full items-center gap-[10px] rounded-[12px] px-[12px] py-[8px] text-left transition-colors duration-150 hover:bg-sh-hover"
                  >
                    <Icon icon={Layers} size={14} className="shrink-0 text-sh-text-3" />
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-sh-text">{s.name}</span>
                    <span className="shrink-0 text-[12px] tabular-nums text-sh-text-3">{s.items.length} items</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {/* Z5b — the basket. */}
          <Card titleSize="sm" title="Basket" right={<span className="text-[12px] text-sh-text-3">Enter adds · never places</span>}>
            {lines.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                why={
                  suggestions.length > 0
                    ? 'The basket is empty. Search on the left, apply an order set, or accept one of the suggestions in the rail.'
                    : 'The basket is empty. Search on the left, or apply an order set.'
                }
              />
            ) : (
              <ul className="flex flex-col">
                {lines.map((l, i) => {
                  const decision = dispositions[touchpoint(l)]
                  const flag = aiActive && l.duplicateOf
                  return (
                    <li key={l.id} className={cn('py-[10px]', i > 0 && 'border-t border-sh-line', i === 0 && 'pt-0')}>
                      <div className="flex flex-wrap items-center justify-between gap-[8px]">
                        <p className="min-w-0 text-[14px] font-medium text-sh-text">{l.item}</p>
                        <div className="flex items-center gap-[6px]">
                          <Select
                            value={l.priority}
                            aria-label={`Priority for ${l.item}`}
                            onChange={(e) => basketUpdate(enc.id, l.id, { priority: e.target.value as OrderPriority })}
                            className="h-[44px] w-auto"
                          >
                            {PRIORITIES.map((pr) => (
                              <option key={pr}>{pr}</option>
                            ))}
                          </Select>
                          <Pill variant="ghost" size="md" icon={Trash2} aria-label={`Remove ${l.item}`} onClick={() => basketRemove(enc.id, l.id)}>
                            Remove
                          </Pill>
                        </div>
                      </div>
                      {flag && l.duplicateOf && (!decision || decision.disposition === 'Deferred') && (
                        <div className="mt-[10px] rounded-[14px] bg-sh-warn-bg px-[12px] py-[10px]">
                          <p className="flex items-center gap-[8px] text-[13px] font-semibold text-sh-warn-fg">
                            <Diamond />
                            AI-304 · possible duplicate
                          </p>
                          <p className="mt-[4px] text-[13px]/[1.5] text-sh-text-2">{l.duplicateOf.reason}</p>
                          <p className="mt-[4px] text-[12px] tabular-nums text-sh-text-2">
                            Prior order {l.duplicateOf.id} · {formatDateTime(new Date(l.duplicateOf.placedAt))} · a suggestion at G2, not a block
                          </p>
                          <div className="mt-[8px] flex flex-wrap gap-[8px]">
                            <Pill variant="card" size="md" onClick={() => removeAsSuggested(l)}>
                              Remove it
                            </Pill>
                            <Pill variant="ghost" size="md" onClick={() => setRejecting(l)}>
                              Order anyway
                            </Pill>
                          </div>
                        </div>
                      )}
                      {flag && decision?.disposition === 'Rejected' && (
                        <p className="mt-[6px] flex flex-wrap items-center gap-[8px] text-[12px] text-sh-text-3">
                          <Diamond />
                          Ordered anyway · {decision.reason} · AI-304
                          <button
                            type="button"
                            onClick={() => useAI.getState().clearDisposition(touchpoint(l))}
                            className="inline-flex min-h-[32px] items-center font-medium text-sh-text-2 underline decoration-dotted underline-offset-2 hover:text-sh-text"
                          >
                            Undo
                          </button>
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </div>
      </ScreenFrame>

      {/* Ordering past AI-304 is a rejection of its suggestion — with one of the fixed five, which is how a wrong rule gets found. */}
      <RejectDialog
        open={rejecting !== null}
        capabilityName="Duplicate and low-value test check"
        onCancel={() => setRejecting(null)}
        onConfirm={(reason, text) => {
          if (!rejecting) return
          recordDisposition({ touchpointId: touchpoint(rejecting), disposition: 'Rejected', by: me.name, modelVersion: 'low-value v1.5.0', confidence: 'MED', reason, reasonText: text })
          setRejecting(null)
          toast({ tone: 'info', title: 'Rejection recorded', detail: `${reason} · fed back to model governance` })
        }}
      />
    </>
  )
}

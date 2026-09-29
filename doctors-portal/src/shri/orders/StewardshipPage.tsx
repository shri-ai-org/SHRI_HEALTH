/**
 * S-09-08 · Test stewardship — `/orders/stewardship` (`src/screens/m09/
 * S0908.tsx`): "Which tests are being ordered that need not be."
 *
 * An approval queue with a recommended disposition per item (ARC-08), the
 * recommendation AI-304's at G2. Disagreeing needs a reason from the fixed
 * five — the mechanism by which a wrong rule gets found — so the screen says
 * so rather than treating rejection as noise. It opens on what still awaits a
 * decision; what has been reviewed is one tap away.
 *
 * Where the old queue fell short: agreeing that a repeat is unnecessary did
 * nothing to the order, while "Cost avoided" counted it avoided. As on S-09-06
 * — acknowledging is not acting — the decision is recorded, the order is
 * voided as its own act, and the cost counts as avoided only once it is. A
 * deferred flag stays awaiting; the order is the one the header names; and
 * with the AI off there are no flags, and the screen says what stands in.
 */

import { CornerDownRight, IndianRupee, OctagonX } from 'lucide-react'
import { useState } from 'react'

import { ORDERS, ENCOUNTERS, type OrderRow } from '@/data/clinical'
import { NOW, formatDateTime, formatRupees, formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { useAI } from '@/store/ai'
import { useClinical } from '@/store/clinical'

import { ScreenFrame } from '../app/ScreenFrame'
import { encounterLabel } from '../logic/encounter'
import { useVoidOrder } from '../logic/orders'
import { useScope } from '../logic/scope'
import { useAiActive } from '../state/ai'
import { AIActionBar } from '../ui/ai'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Why } from '../ui/Disclosure'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import { RankedSort } from '../ui/RankedSort'
import { Segmented } from '../ui/Segmented'

/** What a repeat costs, from the §8.4 tariff card. */
const UNIT_COST: Record<string, number> = { CRP: 480, CBC: 350, 'Serum creatinine': 320, 'Blood culture': 1200 }
const cost = (o: OrderRow) => UNIT_COST[o.item] ?? 400

type Scope = 'awaiting' | 'reviewed'
const SCOPES: readonly Scope[] = ['awaiting', 'reviewed']

export function StewardshipPage() {
  const aiActive = useAiActive()
  const dispositions = useAI((s) => s.dispositions)
  const cancelled = useClinical((s) => s.cancelledOrders)
  const voidOrder = useVoidOrder()
  const [scope, setScope] = useScope(SCOPES, 'awaiting')
  /** AIP-07's guardrail: a ranked list always keeps the deterministic order one choice away. */
  const [aiSort, setAiSort] = useState(true)
  const [voiding, setVoiding] = useState<OrderRow | null>(null)

  const touchpoint = (o: OrderRow) => `stewardship:${o.id}`
  const decision = (o: OrderRow) => {
    const d = dispositions[touchpoint(o)]
    // A deferral records that the flag was looked at and not decided — it stays awaiting.
    return d && d.disposition !== 'Deferred' ? d : undefined
  }
  const byAi = aiActive && aiSort
  const flagged = ORDERS.filter((o) => o.duplicateReason).sort((a, b) => (byAi ? (b.confidence ?? 0) - (a.confidence ?? 0) : 0) || b.placedAt.getTime() - a.placedAt.getTime())
  const reviewed = flagged.filter((o) => decision(o))
  const awaiting = flagged.filter((o) => !decision(o))
  const rows = scope === 'awaiting' ? awaiting : reviewed
  const accepted = (o: OrderRow) => {
    const d = decision(o)
    return d !== undefined && d.disposition !== 'Rejected'
  }
  /** Avoided means voided: an accepted flag on an order that still goes ahead avoided nothing. */
  const avoided = reviewed.filter((o) => accepted(o) && cancelled[o.id]).reduce((sum, o) => sum + cost(o), 0)

  function confirmVoid() {
    if (!voiding) return
    const enc = ENCOUNTERS.find((e) => e.patientId === voiding.patientId)
    voidOrder({
      orderId: voiding.id,
      item: voiding.item,
      patientId: voiding.patientId,
      reason: `Duplicate of another order — AI-304 flag accepted${voiding.duplicateOf ? `, prior order ${voiding.duplicateOf}` : ''}`,
      where: enc ? encounterLabel(enc) : 'test stewardship',
      returnTo: enc ? `/encounter/${enc.id}/orders` : '/orders/stewardship',
    })
    setVoiding(null)
  }

  return (
    <>
      <ScreenFrame
        screenId="S-09-08"
        heading="Test stewardship"
        sub={aiActive ? `${awaiting.length} awaiting your decision · ${flagged.length} flagged in the last 7 days` : 'AI-304 is off — nothing is flagged'}
        empty={
          <Card className="items-center px-[24px] py-[40px] text-center">
            <p className="text-[17px] font-medium text-sh-text">Nothing has been flagged as low-value this week.</p>
            <p className="mx-auto mt-[8px] max-w-[440px] text-[14px] text-sh-text-2">
              A repeat test ordered inside its useful interval, or a test with no plausible bearing on the current problem, would appear here for review.
            </p>
          </Card>
        }
        rail={
          aiActive && (
            <Card titleSize="sm" title="This session">
              <dl className="flex flex-col">
                <div className="flex justify-between gap-[8px] pb-[9px]">
                  <dt className="text-[13px] text-sh-text-2">Reviewed</dt>
                  <dd className="text-[13px] font-medium tabular-nums text-sh-text">
                    {reviewed.length} of {flagged.length}
                  </dd>
                </div>
                <div className="flex justify-between gap-[8px] border-t border-sh-line pt-[9px]">
                  <dt className="text-[13px] text-sh-text-2">Cost avoided</dt>
                  <dd className="text-[13px] font-medium tabular-nums text-sh-text">{formatRupees(avoided)}</dd>
                </div>
              </dl>
              <p className="mt-[8px] text-[12px] text-sh-text-3">Counted once the order is voided, not when the flag is accepted.</p>
            </Card>
          )
        }
        railTitle="Stewardship"
      >
        <div className="flex max-w-[896px] flex-col gap-[16px]">
          {aiActive ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-[12px]">
                <Segmented
                  label="Which flags"
                  value={scope}
                  onChange={setScope}
                  options={[
                    { key: 'awaiting', label: 'Awaiting', count: awaiting.length },
                    { key: 'reviewed', label: 'Reviewed', count: reviewed.length },
                  ]}
                />
                <RankedSort aiSort={aiSort} onChange={setAiSort} aiLabel="Strongest signal" deterministicLabel="Most recent first" capabilityId="AI-304" label="Sort the flags" />
              </div>

              {rows.length === 0 ? (
                <Card>
                  <p className="py-[16px] text-center text-[14px] text-sh-text-2">
                    {scope === 'awaiting'
                      ? 'Every flagged test has a decision recorded against it. The reviewed ones are one tap away.'
                      : 'Nothing has been dispositioned yet this session.'}
                  </p>
                </Card>
              ) : (
                <div className="flex flex-col gap-[12px]">
                  {rows.map((o) => {
                    const p = patient(o.patientId)
                    const voided = cancelled[o.id]
                    return (
                      <Card key={o.id} as="article" aria-label={`${o.item} for ${p.name}`}>
                        <div className="flex flex-wrap items-start justify-between gap-[8px]">
                          <div className="min-w-0">
                            <h3 className="text-[15px] font-semibold text-sh-text">
                              {o.item} · {p.name}
                            </h3>
                            <p className="text-[12px] tabular-nums text-sh-text-3">
                              {p.bed ?? 'outpatient'} · order {o.id} · placed {formatDateTime(o.placedAt)} by {o.placedBy}
                            </p>
                          </div>
                          <PillTag tone="neu" size="sm" icon={IndianRupee}>
                            {formatRupees(cost(o))} if avoided
                          </PillTag>
                        </div>

                        <p className="mt-[12px] rounded-[14px] bg-sh-inner px-[14px] py-[10px] text-[14px]/[1.55] text-sh-text-2">{o.duplicateReason}</p>

                        {o.duplicateOf && (
                          <p className="mt-[8px] flex items-center gap-[8px] text-[12px] tabular-nums text-sh-text-3">
                            <Icon icon={CornerDownRight} size={13} />
                            Prior order {o.duplicateOf}
                          </p>
                        )}

                        <AIActionBar
                          className="mt-[12px]"
                          touchpointId={touchpoint(o)}
                          capabilityId="AI-304"
                          gate="G2"
                          band={o.band ?? 'MED'}
                          score={o.confidence}
                          explain={{
                            touchpointId: touchpoint(o),
                            capabilityId: 'AI-304',
                            claim: `${o.item} for ${p.name} looks like a repeat inside its useful interval.`,
                            confidence: o.confidence ?? 0.7,
                            band: o.band ?? 'MED',
                            computedAt: formatTime(NOW),
                            inputs: [
                              { label: `Prior ${o.item}`, source: `Order ${o.duplicateOf ?? '—'}` },
                              { label: 'Result trajectory', source: 'Results, last 72 hours' },
                              { label: 'Departmental repeat interval', source: 'Stewardship rule set' },
                            ],
                            evidence: [o.duplicateReason ?? ''],
                            model: 'low-value v1.5.0',
                            limits: [
                              'Compares against a departmental repeat interval, which is an average rather than a rule.',
                              'It does not know the clinical question you are asking of the repeat.',
                              'The retrospective stewardship round remains the fallback.',
                            ],
                          }}
                        />

                        {/* Agreeing is a decision; voiding the order is the act — each on its own, as acknowledging and acting are. */}
                        {accepted(o) &&
                          (voided ? (
                            <p className="mt-[10px] text-[12px] text-sh-text-3">Voided · {voided.reason}</p>
                          ) : (
                            <div className="mt-[10px] flex flex-wrap items-center gap-[10px] rounded-[14px] bg-sh-inner px-[14px] py-[8px]">
                              <span className="min-w-0 flex-1 text-[13px] text-sh-text-2">The order is still open. Accepting the flag does not stop it.</span>
                              <Pill variant="crit" size="md" icon={OctagonX} onClick={() => setVoiding(o)}>
                                Void this order
                              </Pill>
                            </div>
                          ))}
                      </Card>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            <Card>
              <p className="py-[16px] text-center text-[14px] text-sh-text-2">
                AI-304 is off, so no test is flagged. The retrospective stewardship round remains the fallback.
              </p>
            </Card>
          )}

          <Why label="Why rejecting matters more than accepting">
            <p>
              Rejecting a flag requires a reason from the fixed five. Those reasons are the only signal that tells stewardship the rule is wrong rather than the clinician. An
              accept teaches nothing.
            </p>
            <p>
              A flagged test may be exactly right. This is a queue of suggestions, not a queue of errors — it exists so the decision is recorded either way, and so a rule that
              keeps being overruled gets noticed.
            </p>
            <p className="text-sh-text-3">AI-304 · G2, strongest signal first. The retrospective stewardship round remains the fallback.</p>
          </Why>
        </div>
      </ScreenFrame>

      <ConfirmDialog
        open={voiding !== null}
        title={`Cancel ${voiding?.item ?? ''}?`}
        consequence="The order is voided, not deleted. It stays visible with your reason recorded against it, and the performing department is notified."
        confirmLabel="Void this order"
        tone="destructive"
        onConfirm={confirmVoid}
        onCancel={() => setVoiding(null)}
      >
        <p className="text-[13px] text-sh-text-2">Reason recorded: Duplicate of another order — AI-304 flag accepted.</p>
      </ConfirmDialog>
    </>
  )
}

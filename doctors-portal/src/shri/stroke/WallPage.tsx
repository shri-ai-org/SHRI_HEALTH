/**
 * S-18-01 · Stroke network wall — `/stroke/wall` (`src/screens/m18/
 * S1801.tsx`): "The network, live, on a wall and on a phone."
 *
 * ARC-12 strips the shell — Z5 only, no rail, no bar, no bubble; read at 3–4
 * metres and run unattended for a shift — and the same page must work at
 * 02:00 on a phone, where the case rail is the whole screen and a tap expands
 * a case in place (S-18-02, `CaseView`). STALE dims the wall and states its
 * last-good time in large type; OFFLINE declares the partition and never
 * drops a case; with the AI off the clocks, targets and resources are
 * unaffected — only AI-404's finding line hides.
 *
 * Removed, as a forecast (decision 8): AI-616's ambulance ETA ("ETA 9 min") —
 * the ambulance, where it is and where it is going stay. Where the old wall
 * fell short: every active case wore the index case's rings and next action
 * (another case now says none are recorded); a case from the secondary site
 * (ITP) was labelled "hub" (the chip is the origin site's role now); and "exit
 * wall" went to My Day
 * even for a persona without it (it goes to the telestroke queue for them).
 */

import { Ambulance, Ban, Brain, Check, CircleDot, Phone, Scan, WifiOff } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { ACTIVE_CASE, INBOUND_AMBULANCES, NETWORK_SITES, NETWORK_TODAY, STROKE_CASES } from '@/data/stroke'
import { triageHeadline } from '@/data/strokeai'

import { cn } from '../lib/cn'
import { atRisk, useCaseClock, useLiveIntervals } from '../logic/caseClock'
import { WALL_RINGS, isIndexCase, ringLabel } from '../logic/strokeCase'
import { useAiActive, useForcedState } from '../state/ai'
import { devOpens } from '../state/store'
import { ClockRing } from '../ui/ClockRing'
import { Disclosure } from '../ui/Disclosure'
import { Card, CountBubble, Diamond, Icon, PillTag } from '../ui/primitives'
import { WallFrame } from '../ui/WallFrame'

import { CaseView } from './CaseView'
import { NoStream } from './StrokeBits'
import { useStrokeLocal } from './strokeLocal'

const CT_TONE = { free: 'norm', 'in use': 'warn', none: 'neu' } as const

/** The ambulance's recorded position — the note's first sentence; its second qualifies the removed ETA. */
const whereNow = (note: string) => note.split('. ')[0].replace(/\.$/, '')

export function WallPage() {
  const navigate = useNavigate()
  const caseNow = useCaseClock()
  const aiActive = useAiActive()
  const forced = useForcedState()
  const intervals = useLiveIntervals()
  const deactivations = useStrokeLocal((s) => s.deactivations)
  // DEV `?open=case` lands with the index case expanded (S-18-02), for the walk and the contrast audit.
  const [expanded, setExpanded] = useState<string | null>(() => (devOpens('case') ? ACTIVE_CASE.id : null))

  // A case de-activated on its clock (S-18-06) leaves the active wall and keeps its record and reason.
  const active = STROKE_CASES.filter((c) => c.status === 'active' && !deactivations[c.id])
  const deactivated = STROKE_CASES.filter((c) => c.status === 'de-activated' || deactivations[c.id])
  const deactivationLine = (c: (typeof STROKE_CASES)[number]) => {
    const d = deactivations[c.id]
    return d ? `${d.reason}. De-activated ${formatTime(d.at)}.` : c.deactivationReason
  }
  const next = intervals.find(atRisk) ?? intervals.find((i) => i.state === 'RUNNING')

  return (
    <main data-screen-id="S-18-01">
      <WallFrame
        title="Stroke network"
        asOf={`${formatTime(caseNow)}:${String(caseNow.getSeconds()).padStart(2, '0')} IST`}
        stale={forced === 'STALE'}
        onExit={() => navigate('/')}
      >
        {/* OFFLINE declares the partition and names the unreachable sites. It never silently drops a case. */}
        {forced === 'OFFLINE' && (
          <div role="status" className="mb-[20px] rounded-sh-card bg-sh-crit-bg px-[20px] py-[16px]">
            <p className="flex items-center gap-[8px] text-[18px] font-bold text-sh-crit-fg md:text-[24px]">
              <Icon icon={WifiOff} size={22} />
              Network partition
            </p>
            <p className="mt-[4px] text-[15px] text-sh-text-2 md:text-[18px]">
              IPL and IUD are unreachable. Their cases are shown with their last-known state and are NOT removed from the wall — a case that disappears is a case nobody is watching.
            </p>
          </div>
        )}

        <div className="grid gap-[16px] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          {/* The case rail — on a phone, this is the whole screen. */}
          <section aria-label="Active cases">
            <h2 className="mb-[10px] flex items-center gap-[10px] text-[14px] font-bold uppercase tracking-[0.08em] text-sh-text-2 md:text-[16px]">
              Active cases
              <CountBubble className={active.length > 0 ? 'bg-sh-pend-bg text-sh-pend-fg' : 'bg-sh-inner'}>{active.length}</CountBubble>
            </h2>
            <div className="flex flex-col gap-[12px]">
              {active.map((c) => {
                const p = patient(c.patientId)
                const own = isIndexCase(c)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setExpanded(c.id)}
                    aria-label={`${c.caseNo}, ${p.age}/${p.sex}, ${c.originFacility}${c.originFacility !== c.destinationFacility ? ` to ${c.destinationFacility}` : ''} — expand`}
                    className="block min-h-[44px] w-full rounded-sh-card bg-sh-card p-[16px] text-left transition-colors duration-150 hover:bg-sh-hover md:p-[20px]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-[8px]">
                      <div className="min-w-0">
                        <p className="text-[15px] font-bold tabular-nums tracking-[0.02em] md:text-[18px]">{c.caseNo}</p>
                        {/* "Card faces carry no clinical detail beyond age/sex and the active interval." */}
                        <p className="mt-[2px] text-[15px] tabular-nums text-sh-text-2 md:text-[20px]">
                          {p.age}/{p.sex} · {c.originFacility} {c.originFacility !== c.destinationFacility && `→ ${c.destinationFacility}`}
                        </p>
                      </div>
                      <PillTag tone="pend" size="sm" icon={Brain}>
                        {NETWORK_SITES.find((s) => s.code === c.originFacility)?.role ?? 'hub'}
                      </PillTag>
                    </div>

                    {/* Per-interval clock rings — the frame's centrepiece. One short name under each; the ring prints its own state. */}
                    {own ? (
                      <div className="mt-[16px] flex flex-wrap gap-[16px] md:gap-[24px]">
                        {intervals
                          .filter((i) => WALL_RINGS.includes(i.key))
                          .map((i) => (
                            <div key={i.key} className="flex w-[72px] flex-col items-center">
                              <ClockRing label={i.label} elapsedMin={i.elapsed} targetMin={i.targetMin} state={i.state} size={72} />
                              <span className="mt-[2px] text-[12px] font-semibold tabular-nums tracking-[0.04em] text-sh-text-2">{ringLabel(i.key)}</span>
                            </div>
                          ))}
                      </div>
                    ) : (
                      <NoStream caseNo={c.caseNo} what="intervals" className="mt-[12px] text-[14px] text-sh-text-2 md:text-[16px]" />
                    )}

                    {/* AI-404's finding hides with the AI off; the clocks do not. */}
                    {aiActive && (
                      <p className="mt-[12px] flex flex-wrap items-center gap-[8px] text-[15px] font-semibold text-sh-pend-fg md:text-[18px]">
                        <Diamond />
                        {triageHeadline(c)}
                      </p>
                    )}

                    <p className="mt-[8px] flex flex-wrap items-center gap-[8px] text-[15px] md:text-[18px]">
                      <span className="text-sh-text-2">next:</span>
                      <span className="font-semibold">{(own && next?.nextAction) || '—'}</span>
                      <span className="text-sh-text-2">· {(own && next?.owner) || '—'}</span>
                    </p>
                  </button>
                )
              })}

              {active.length === 0 && (
                /* The quiet state is still informative. */
                <Card className="p-[24px] text-center">
                  <p className="text-[18px] font-semibold">No active stroke cases</p>
                  <p className="mt-[8px] tabular-nums text-sh-text-2">
                    {NETWORK_TODAY.activations} activations today · DTN median {NETWORK_TODAY.dtnMedianMin} min · {NETWORK_TODAY.mimics} mimic de-activated
                  </p>
                </Card>
              )}

              {/* A de-activated case keeps its record; the wall keeps it one tap away. */}
              {deactivated.length > 0 && (
                <Disclosure label="de-activated" count={deactivated.length}>
                  <ul className="flex flex-col gap-[8px]">
                    {deactivated.map((c) => (
                      <li key={c.id} className="rounded-sh-inner bg-sh-inner p-[16px]">
                        <p className="text-[15px] font-bold tabular-nums md:text-[16px]">{c.caseNo}</p>
                        <p className="mt-[2px] text-[14px] text-sh-text-2 md:text-[16px]">
                          {c.originFacility} · {deactivationLine(c)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
            </div>
          </section>

          {/* The network map and the resource strip — secondary on a phone. */}
          <div className="flex flex-col gap-[16px]">
            <Card title="Network" right={<CountBubble className="bg-sh-inner">{`${NETWORK_SITES.length} sites`}</CountBubble>}>
              <ul className="flex flex-col gap-[8px]">
                {NETWORK_SITES.map((s) => {
                  const live = active.some((c) => c.originFacility === s.code)
                  return (
                    <li key={s.code} className={cn('flex min-h-[44px] flex-wrap items-center justify-between gap-[8px] rounded-sh-inner px-[12px] py-[10px]', live ? 'bg-sh-pend-bg' : 'bg-sh-inner')}>
                      <span className="min-w-0">
                        <span className="block font-bold tabular-nums md:text-[18px]">
                          {s.code}
                          {live && <span className="ml-[8px] text-[13px] font-semibold text-sh-pend-fg">← active</span>}
                        </span>
                        <span className="block text-[13px] text-sh-text-2 md:text-[15px]">
                          {s.role} · {s.neurologist}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-[4px]">
                        <PillTag tone={CT_TONE[s.ctStatus]} size="sm" icon={s.ctStatus === 'none' ? Ban : Scan}>
                          CT {s.ctStatus}
                        </PillTag>
                        <span className="text-[13px] tabular-nums text-sh-text-2">
                          beds {s.strokeBeds.free}/{s.strokeBeds.total}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </Card>

            {/* Only what the Network card does not already say: the cath lab, who is on call, and anything on the road. */}
            <Card title="Resources">
              <dl className="flex flex-col gap-[4px] px-[4px]">
                <div className="flex min-h-[36px] items-center justify-between gap-[12px]">
                  <dt className="text-[15px] text-sh-text-2 md:text-[18px]">CATH-1</dt>
                  <dd>
                    <PillTag tone="norm" size="sm" icon={Check}>
                      free
                    </PillTag>
                  </dd>
                </div>
                <div className="flex min-h-[36px] items-center justify-between gap-[12px]">
                  <dt className="text-[15px] text-sh-text-2 md:text-[18px]">On call</dt>
                  <dd>
                    <PillTag tone="neu" size="sm" icon={Phone}>
                      Dr. R. Desai (phone)
                    </PillTag>
                  </dd>
                </div>
              </dl>
              {INBOUND_AMBULANCES.map((a) => (
                <div key={a.id} className="mt-[8px] rounded-sh-inner bg-sh-warn-bg px-[12px] py-[10px]">
                  <p className="flex flex-wrap items-center gap-[8px] font-semibold text-sh-warn-fg md:text-[18px]">
                    <Icon icon={Ambulance} size={16} />
                    {a.id} · {a.from} → {a.to}
                  </p>
                  <p className="mt-[2px] text-[13px] text-sh-text-2">
                    {whereNow(a.note)} · STROKE/26-27/{a.caseId}
                  </p>
                </div>
              ))}
            </Card>

            <Card title="Today">
              <p className="tabular-nums md:text-[18px]">
                {NETWORK_TODAY.activations} activations · DTN median {NETWORK_TODAY.dtnMedianMin} min · {NETWORK_TODAY.transfers} transfer · {NETWORK_TODAY.mimics} mimic
              </p>
              {!aiActive && (
                <p className="mt-[8px] flex items-center gap-[8px] text-[13px] text-sh-text-2">
                  <Icon icon={CircleDot} size={13} />
                  AI findings hidden · clocks and resources unaffected
                </p>
              )}
            </Card>
          </div>
        </div>
      </WallFrame>

      {/* S-18-02 expands in place, without leaving the wall. */}
      <CaseView caseId={expanded} onClose={() => setExpanded(null)} />
    </main>
  )
}

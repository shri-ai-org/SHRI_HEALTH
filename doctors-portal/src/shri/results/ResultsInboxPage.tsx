/**
 * S-09-04 · Results — `/results/inbox` (`src/screens/m09/S0904.tsx`):
 * "Results ranked by how much they should worry you." Deck beat #13:
 * "Results come ranked, and the critical one escalates."
 *
 * Calm is a property of the layout, not of the safety path: the critical
 * banner still interrupts, the acknowledgement is still a named act, and its
 * dialog (S-09-06) still cannot be dismissed without a disposition. Every
 * patient's results are here, filtered by review state and by patient, read as
 * a list or grouped by patient, with a summary column of how much is critical,
 * outside range and still unreviewed.
 *
 * The two capabilities do different jobs and look different: AI-212 RANKS (G1
 * — ignorable, the chronological order one choice away, and with the AI off
 * the only order); AI-213 ESCALATES (G2, rule-based thresholds that are never
 * fully off, interrupting a NAMED clinician rather than a pool).
 */

import { ChevronRight, CircleHelp, Clock, List, TriangleAlert, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { RESULTS, type ResultRow } from '@/data/clinical'
import { NOW, formatDate, formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { useClinical } from '@/store/clinical'

import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { recordPath } from '../logic/record'
import { ClinicalFlag } from '../record/bits'
import { useAiActive } from '../state/ai'
import { devOpens } from '../state/store'
import { Alert } from '../ui/Alert'
import { EmptyState } from '../ui/EmptyState'
import { Select } from '../ui/forms'
import { Card, CountBubble, Icon, Pill, PillTag } from '../ui/primitives'
import { RankedSort } from '../ui/RankedSort'
import { Segmented } from '../ui/Segmented'
import { StatTile } from '../ui/StatTile'

import { CriticalAck } from './CriticalAck'

type Filter = 'to-review' | 'reviewed' | 'all'
type View = 'list' | 'patients'

/** Today reads as a time; anything earlier carries its date, so 18-Sep never reads as this morning. */
const when = (d: Date) => (d.toDateString() === NOW.toDateString() ? formatTime(d) : formatDate(d).slice(0, 6))

export function ResultsInboxPage() {
  const navigate = useNavigate()
  const aiActive = useAiActive()
  const acknowledgements = useClinical((s) => s.acknowledgements)
  const reassigned = useClinical((s) => s.reassignedResults)
  const [aiSort, setAiSort] = useState(true)
  // DEV `?open=critical` lands on S-09-06 over the first critical result still owed, for a headless audit.
  const [critical, setCritical] = useState<ResultRow | null>(() =>
    devOpens('critical') ? (RESULTS.find((r) => r.critical && !r.acknowledged && !useClinical.getState().acknowledgements[r.id]) ?? null) : null,
  )
  const [filter, setFilter] = useState<Filter>('to-review')
  const [who, setWho] = useState('all')
  const [view, setView] = useState<View>('list')

  const acked = (r: ResultRow) => r.acknowledged || acknowledgements[r.id] !== undefined
  const forWho = who === 'all' ? RESULTS : RESULTS.filter((r) => r.patientId === who)
  const toReview = forWho.filter((r) => !acked(r))
  const reviewed = forWho.filter((r) => acked(r))
  const rows = filter === 'all' ? forWho : filter === 'reviewed' ? reviewed : toReview
  /** AI-212's ranking: critical first, then the newest. The deterministic order is strictly by report time — and the only one while the AI is off. */
  const byAi = aiActive && aiSort
  const ordered = [...rows].sort((a, b) => (byAi ? Number(b.critical) - Number(a.critical) : 0) || b.reportedAt.getTime() - a.reportedAt.getTime())

  const criticalUnacked = RESULTS.filter((r) => r.critical && !acked(r))
  const outside = RESULTS.filter((r) => r.flag !== 'Normal')
  const allToReview = RESULTS.filter((r) => !acked(r))
  const oldest = [...allToReview].sort((a, b) => a.reportedAt.getTime() - b.reportedAt.getTime())[0]

  /** Everyone with a result, most to review first — the summary column and the patient filter. */
  const byPatient = useMemo(() => {
    const map = new Map<string, ResultRow[]>()
    for (const r of RESULTS) map.set(r.patientId, [...(map.get(r.patientId) ?? []), r])
    return [...map.entries()]
      .map(([patientId, list]) => ({
        patientId,
        list,
        review: list.filter((r) => !r.acknowledged && acknowledgements[r.id] === undefined).length,
        abnormal: list.filter((r) => r.flag !== 'Normal').length,
        critical: list.some((r) => r.critical),
      }))
      .sort((a, b) => Number(b.critical) - Number(a.critical) || b.review - a.review || b.abnormal - a.abnormal)
  }, [acknowledgements])

  const top = criticalUnacked[0]
  const topPatient = top ? patient(top.patientId) : undefined

  /** The acknowledgement control a row carries: the act while it is owed, who did it once done. */
  const ackControl = (r: ResultRow) =>
    r.critical && !acked(r) ? (
      <span className="flex flex-col items-end gap-[4px]">
        <Pill variant="crit" size="md" icon={TriangleAlert} aria-label={`Acknowledge ${r.test} ${r.value} ${r.unit} for ${patient(r.patientId).name}`} onClick={() => setCritical(r)}>
          Acknowledge <span className="font-normal tabular-nums opacity-80">{r.unackMinutes} min</span>
        </Pill>
        {reassigned[r.id] && <span className="text-[12px] text-sh-text-3">reassigned to {reassigned[r.id].to}</span>}
      </span>
    ) : acked(r) ? (
      <span className="text-[12px] text-sh-norm-fg">acknowledged{acknowledgements[r.id] ? ` · ${acknowledgements[r.id].by}` : ''}</span>
    ) : null

  const filters = (
    <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[10px]">
      <Segmented
        label="Which results"
        value={filter}
        onChange={setFilter}
        options={[
          { key: 'to-review', label: 'To review', count: toReview.length },
          { key: 'reviewed', label: 'Reviewed', count: reviewed.length },
          { key: 'all', label: 'All', count: forWho.length },
        ]}
      />
      <Segmented
        label="How to show them"
        value={view}
        onChange={setView}
        options={[
          { key: 'list', label: 'List', icon: List },
          { key: 'patients', label: 'By patient', icon: Users },
        ]}
      />
      <Select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Patient" className="h-[44px] w-auto bg-sh-card hover:bg-sh-card">
        <option value="all">All patients</option>
        {byPatient.map((g) => (
          <option key={g.patientId} value={g.patientId}>
            {patient(g.patientId).name}
          </option>
        ))}
      </Select>
      <PillTag tone="neu" size="sm" icon={Clock}>
        as of {formatTime(NOW)}
      </PillTag>
    </div>
  )

  const emptyWhy = filter === 'to-review' ? 'No results are waiting for review. A newly released result for one of your patients would appear here.' : 'No results match this filter.'

  return (
    <>
      <ScreenFrame
        screenId="S-09-04"
        heading="Results"
        sub={`${allToReview.length} to review · ${RESULTS.length} results across ${byPatient.length} patients${criticalUnacked.length > 0 ? ` · ${criticalUnacked.length} critical, unacknowledged` : ''}`}
        empty={
          <Card className="items-center px-[24px] py-[40px] text-center">
            <p className="text-[17px] font-medium text-sh-text">No results are waiting for review.</p>
            <p className="mx-auto mt-[8px] max-w-[440px] text-[14px] text-sh-text-2">
              Everything released for your patients has been seen. A newly released result, or a critical value on anyone you are covering, would appear here within seconds.
            </p>
          </Card>
        }
      >
        <div className="grid min-w-0 grid-cols-1 items-start gap-[16px] xl:grid-cols-[minmax(0,8fr)_minmax(0,4fr)]">
          <div className="flex min-w-0 flex-col gap-[16px]">
            {/* AI-213 escalating. This is allowed to interrupt; nothing else here is. */}
            {top && topPatient && (
              <Alert
                tone="crit"
                role="alert"
                icon={TriangleAlert}
                title={`${top.test} ${top.value} ${top.unit} — critical, unacknowledged ${top.unackMinutes} minutes`}
                action={
                  <Pill variant="crit" size="md" onClick={() => setCritical(top)}>
                    Acknowledge now
                  </Pill>
                }
              >
                {topPatient.name} · {topPatient.bed}. This escalates to the on-call consultant at 15 minutes. Acknowledging records that you saw it — acting on it is documented
                separately.
                {reassigned[top.id] && ` Reassigned to ${reassigned[top.id].to} — still unacknowledged.`}
              </Alert>
            )}

            <div className="flex flex-wrap items-center justify-between gap-[12px]">
              {filters}
              <RankedSort aiSort={aiSort} onChange={setAiSort} aiLabel="Clinical concern" deterministicLabel="Most recent first" capabilityId="AI-212" label="Sort the results" />
            </div>

            {view === 'list' ? (
              <Card className="p-[8px]">
                {ordered.length === 0 ? (
                  <EmptyState
                    icon={List}
                    why={emptyWhy}
                    action={
                      filter !== 'all' && (
                        <Pill variant="control" size="md" onClick={() => setFilter('all')}>
                          Show every result
                        </Pill>
                      )
                    }
                  />
                ) : (
                  <>
                    <ul aria-label="Results released for this clinician's patients" className="flex flex-col">
                      {ordered.map((r, i) => {
                        const p = patient(r.patientId)
                        return (
                          <li key={r.id} className={cn('flex flex-wrap items-center gap-x-[8px] gap-y-[6px] py-[4px]', i > 0 && 'border-t border-sh-line')}>
                            <button
                              type="button"
                              onClick={() => navigate(`/results/${r.id}`)}
                              className="flex min-h-[60px] min-w-0 flex-1 basis-[300px] items-center gap-[12px] rounded-[14px] px-[10px] py-[6px] text-left transition-colors duration-150 hover:bg-sh-hover"
                            >
                              <span className="inline-flex h-[32px] min-w-[64px] shrink-0 items-center justify-center rounded-[10px] bg-sh-inner px-[10px] text-[13px] font-bold tabular-nums text-sh-text-2">
                                {when(r.reportedAt)}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[15px] font-semibold text-sh-text">{p.name}</span>
                                <span className="flex flex-wrap gap-x-[8px] text-[12px] text-sh-text-3">
                                  <span className="font-semibold tabular-nums text-sh-text-2">
                                    {r.test} {r.value} {r.unit}
                                  </span>
                                  <span>· {p.bed ?? 'outpatient'}</span>
                                  {/* The movement against the prior value, as a number; AI-212's reason lives on the result itself. */}
                                  <span className="tabular-nums">· {r.delta ? (/\bsince\b/.test(r.delta) ? r.delta : `${r.delta} vs prior`) : 'no prior'}</span>
                                </span>
                              </span>
                              <ClinicalFlag flag={r.flag} />
                            </button>
                            {ackControl(r) && <span className="shrink-0 pr-[6px]">{ackControl(r)}</span>}
                          </li>
                        )
                      })}
                    </ul>
                    <p className="border-t border-sh-line px-[10px] pb-[4px] pt-[10px] text-[12px] tabular-nums text-sh-text-3">
                      {ordered.length} {ordered.length === 1 ? 'result' : 'results'}
                    </p>
                  </>
                )}
              </Card>
            ) : (
              <Card
                titleSize="sm"
                title={
                  <span className="inline-flex items-center gap-[10px]">
                    Results by patient
                    <CountBubble className="bg-sh-control">{rows.length}</CountBubble>
                  </span>
                }
              >
                {rows.length === 0 ? (
                  <p className="px-[4px] py-[8px] text-[14px] text-sh-text-2">No results match this filter.</p>
                ) : (
                  <div className="flex flex-col gap-[12px]">
                    {byPatient
                      .filter((g) => rows.some((r) => r.patientId === g.patientId))
                      .map((g) => {
                        const p = patient(g.patientId)
                        const list = rows.filter((r) => r.patientId === g.patientId)
                        return (
                          <section key={g.patientId} aria-label={p.name} className="rounded-[16px] bg-sh-inner px-[8px] py-[8px]">
                            <header className="flex flex-wrap items-center justify-between gap-[8px] px-[6px] py-[4px]">
                              <span className="min-w-0">
                                <span className="text-[14px] font-semibold text-sh-text">{p.name}</span>
                                <span className="ml-[8px] text-[12px] tabular-nums text-sh-text-3">
                                  {p.age}/{p.sex} · {p.bed ?? 'outpatient'}
                                </span>
                              </span>
                              <Pill variant="ghost" size="md" onClick={() => navigate(recordPath(p, 'results'))}>
                                All of {p.name.split(' ')[0]}&rsquo;s results
                                <Icon icon={ChevronRight} size={14} />
                              </Pill>
                            </header>
                            <ul className="flex flex-col">
                              {list.map((r) => (
                                <li key={r.id} className="flex flex-wrap items-center gap-[8px]">
                                  <button
                                    type="button"
                                    onClick={() => navigate(`/results/${r.id}`)}
                                    className="flex min-h-[44px] min-w-0 flex-1 flex-wrap items-center justify-between gap-[8px] rounded-[12px] px-[6px] py-[6px] text-left transition-colors duration-150 hover:bg-sh-hover"
                                  >
                                    <span className="min-w-0 text-[14px] tabular-nums text-sh-text">
                                      <span className="mr-[8px] text-sh-text-3">{when(r.reportedAt)}</span>
                                      <span className="font-semibold">{r.test}</span> {r.value} {r.unit}
                                    </span>
                                    <span className="flex items-center gap-[8px]">
                                      {!acked(r) && (
                                        <PillTag tone="warn" size="xs" className="font-semibold">
                                          To review
                                        </PillTag>
                                      )}
                                      <ClinicalFlag flag={r.flag} />
                                    </span>
                                  </button>
                                  {r.critical && !acked(r) && <span className="shrink-0">{ackControl(r)}</span>}
                                </li>
                              ))}
                            </ul>
                          </section>
                        )
                      })}
                  </div>
                )}
              </Card>
            )}

            {/* AI-212 abstains on the incomplete culture rather than scoring it low — its claim, so only while it is live. */}
            {aiActive && ordered.some((r) => r.aiReason.startsWith('Cannot assess')) && (
              <Card className="border-l-[3px] border-sh-warn p-[16px]">
                <p className="flex items-center gap-[8px] text-[14px] font-semibold text-sh-warn-fg">
                  <Icon icon={CircleHelp} size={16} />
                  One result cannot be ranked
                </p>
                <p className="mt-[6px] text-[13px]/[1.55] text-sh-text-2">
                  The blood culture is incomplete — a final read is due at 72 hours. AI-212 abstains rather than ranking it low, because &ldquo;low concern&rdquo; and &ldquo;cannot
                  yet say&rdquo; are different claims.
                </p>
              </Card>
            )}
          </div>

          {/* The summary column: how much is critical, outside range, unreviewed — and whose. */}
          <section className="flex min-w-0 flex-col gap-[16px]" aria-label="Results summary">
            <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
              <StatTile
                label="Critical"
                value={RESULTS.filter((r) => r.critical).length}
                tone={criticalUnacked.length > 0 ? 'crit' : 'neu'}
                sub={criticalUnacked.length > 0 ? `${criticalUnacked.length} unacknowledged` : 'all acknowledged'}
              />
              <StatTile label="Outside range" value={outside.length} tone="warn" sub="high or low" />
              <StatTile
                label="To review"
                value={allToReview.length}
                tone={allToReview.length > 0 ? 'warn' : 'norm'}
                sub={oldest ? `oldest ${when(oldest.reportedAt)}` : 'nothing waiting'}
              />
            </div>

            <Card
              titleSize="sm"
              title={
                <span className="inline-flex items-center gap-[10px]">
                  Patients with results
                  <CountBubble className="bg-sh-control">{byPatient.length}</CountBubble>
                </span>
              }
            >
              <ul className="flex flex-col">
                {byPatient.map((g, i) => {
                  const p = patient(g.patientId)
                  const active = who === g.patientId
                  return (
                    <li key={g.patientId} className={cn(i > 0 && 'border-t border-sh-line')}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => setWho(active ? 'all' : g.patientId)}
                        className={cn(
                          'flex min-h-[52px] w-full items-center gap-[10px] rounded-[12px] px-[8px] py-[6px] text-left transition-colors duration-150',
                          active ? 'bg-sh-pend-bg' : 'hover:bg-sh-hover',
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] font-medium text-sh-text">{p.name}</span>
                          <span className="block text-[12px] tabular-nums text-sh-text-3">
                            {g.list.length} results · {g.abnormal} outside range
                          </span>
                        </span>
                        {g.critical && (
                          <PillTag tone="crit" size="xs" icon={TriangleAlert} className="font-semibold">
                            Critical
                          </PillTag>
                        )}
                        {g.review > 0 && <CountBubble className="bg-sh-pend-bg text-sh-pend-fg">{g.review}</CountBubble>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </Card>
          </section>
        </div>
      </ScreenFrame>

      {/* S-09-06, the modal it is specified to be. */}
      <CriticalAck result={critical} onClose={() => setCritical(null)} />
    </>
  )
}

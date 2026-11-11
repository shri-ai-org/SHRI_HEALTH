/**
 * S-06-18 · AI morning brief — `/brief`, opened from the Today panel's first
 * activity. What changed since yesterday evening, for this doctor, in the
 * order to act on it — read from the same live data as the Dashboard
 * (`useMyDay`), so the brief and every list it points to agree:
 *
 *   · In one line — AI-212's summary of the night: the critical results
 *     waiting, how many results changed and how many are outside range, who
 *     is deteriorating, and the day ahead. ◆, with its confidence and a Why.
 *   · Act first — critical results no named clinician has acknowledged, each
 *     opening its result, where it is acknowledged (S-09-05 / S-09-06).
 *   · Results that changed — grouped by patient, each against its prior value
 *     (AI-212's delta check); the most worrying patient first, or in time
 *     order with the AI off.
 *   · Your inpatients — the deterioration and admissions the attention list
 *     holds (AI-201), each opening its Quick-Panel.
 *   · Today — the day plan, and what is left to finish.
 *
 * With the AI off the one-line summary and the ranking go; the lists stay, in
 * time order, with the reference range and the prior value — AI-212's own
 * fallback. A result acknowledged elsewhere leaves the brief at once.
 */

import { ChevronRight, Sunrise, TriangleAlert } from 'lucide-react'
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'

import { RESULTS, type ResultRow } from '@/data/clinical'
import { patient } from '@/data/kit'
import { useClinical } from '@/store/clinical'

import { ScreenFrame } from '../app/ScreenFrame'
import { canonical } from '../app/paths'
import { fmtTime12 } from '../lib/clock'
import { cn } from '../lib/cn'
import { recordPath } from '../logic/record'
import { ClinicalFlag } from '../record/bits'
import { useShri } from '../state/store'
import { Why } from '../ui/Disclosure'
import { EmptyState } from '../ui/EmptyState'
import { iconFor } from '../ui/icons'
import { Card, Chip, ConfidenceMark, Diamond, Icon, Pill } from '../ui/primitives'
import { AiOffLine } from '../ui/states'

import { useMyDay } from './useMyDay'

const PATIENTS_SHOWN = 6
const RESULTS_SHOWN = 4

/** How much a result should worry: critical, then outside range, then the rest. */
const weight = (r: ResultRow) => (r.critical ? 100 : r.flag !== 'Normal' ? 10 : 1)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function BriefPage() {
  const d = useMyDay()
  const navigate = useNavigate()
  const openQuickPanel = useShri((s) => s.openQuickPanel)
  const acks = useClinical((s) => s.acknowledgements)

  // The same results the day plan's "N results changed" counts.
  const changed = useMemo(() => RESULTS.filter((r) => !r.acknowledged && acks[r.id] === undefined), [acks])
  const critical = d.criticalResults
  const outside = changed.filter((r) => r.flag !== 'Normal')
  const groups = useMemo(() => {
    const by = new Map<string, ResultRow[]>()
    for (const r of changed) by.set(r.patientId, [...(by.get(r.patientId) ?? []), r])
    const list = [...by].map(([patientId, rows]) => ({
      patientId,
      rows: [...rows].sort((a, b) => weight(b) - weight(a) || b.reportedAt.getTime() - a.reportedAt.getTime()),
      score: rows.reduce((n, r) => n + weight(r), 0),
      latest: Math.max(...rows.map((r) => r.reportedAt.getTime())),
    }))
    return d.aiActive ? list.sort((a, b) => b.score - a.score || b.latest - a.latest) : list.sort((a, b) => b.latest - a.latest)
  }, [changed, d.aiActive])
  // The attention list's ward items — results have their own section above.
  const ward = d.ordered(false).filter((i) => !i.id.startsWith('result-') && i.urgency !== 'pending')
  const deteriorating = ward.filter((i) => i.reason === 'New deterioration').length

  const brief = d.blocks.find((b) => b.id === 'brief')
  const clinic = d.opd.filter((r) => r.place.label === 'OPD').length
  const tele = d.opd.filter((r) => r.place.label === 'Teleconsult').length
  const first = critical[0]
  const summary = [
    first
      ? `${plural(critical.length, 'critical result')} ${critical.length === 1 ? 'is' : 'are'} waiting for you, starting with ${first.test.toLowerCase()} of ${first.value} ${first.unit} for ${patient(first.patientId).name}`
      : 'No critical result is waiting for you',
    `${plural(changed.length, 'result')} ${changed.length === 1 ? 'has' : 'have'} changed across ${plural(groups.length, 'patient')}, and ${outside.length} ${outside.length === 1 ? 'is' : 'are'} outside the normal range`,
    deteriorating ? `${plural(deteriorating, 'inpatient')} ${deteriorating === 1 ? 'is' : 'are'} deteriorating` : 'None of your inpatients is deteriorating',
    `Today you have ${plural(clinic, 'patient')} in OPD, ${plural(tele, 'teleconsult')} and ${plural(d.inpatients.length, 'inpatient')} on the ward round`,
  ].join('. ')

  return (
    <ScreenFrame
      screenId="S-06-18"
      sub={`${brief ? `Prepared at ${fmtTime12(brief.at)}` : 'Prepared this morning'}. It covers everything since yesterday evening's handover.`}
      empty={<EmptyState icon={Sunrise} why="Nothing changed overnight — no new result, no deterioration, nothing booked yet." />}
    >
      <div className="grid max-w-[1280px] grid-cols-1 gap-[16px] xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-[16px]">
          {d.aiActive ? (
            <Card titleSize="sm" title={<span className="inline-flex items-center gap-[8px]"><Diamond />In one line</span>} right={<ConfidenceMark band={brief?.band ?? 'HIGH'} short />}>
              <p className="text-[17px]/[1.5] text-sh-text" id="brief-summary">
                {summary}.
              </p>
              <Why label="Where this comes from" className="mt-[10px]">
                <p>AI-212 compares every result reported since yesterday evening with the patient&rsquo;s previous value and normal range, and ranks the patients who need your attention first. AI-201 scores deterioration for your inpatients. The day ahead comes from your own plan.</p>
                <p>The AI ranks and summarises, but it does not make decisions. Every number links to the result it came from.</p>
              </Why>
            </Card>
          ) : (
            <Card>
              <AiOffLine />
              <p className="mt-[8px] text-[14px] text-sh-text-2">With AI off, there is no summary or ranking. The lists below are in time order and show each result&rsquo;s reference range and previous value.</p>
            </Card>
          )}

          <Card titleSize="sm" title="Act first" right={critical.length > 0 && <Chip num={String(critical.length)} word="critical" tone="crit" />}>
            {critical.length === 0 ? (
              <p className="text-[14px] text-sh-text-2">No critical result is waiting to be acknowledged.</p>
            ) : (
              <ul aria-label="Critical results to acknowledge" className="flex flex-col gap-[8px]">
                {critical.map((r) => {
                  const p = patient(r.patientId)
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => navigate(`/results/${r.id}`)}
                        className="flex min-h-[56px] w-full flex-wrap items-center gap-x-[12px] gap-y-[4px] rounded-[14px] bg-sh-crit-bg px-[14px] py-[10px] text-left transition-[filter] duration-150 hover:brightness-[0.98]"
                      >
                        <Icon icon={TriangleAlert} size={18} className="shrink-0 text-sh-crit-fg" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] font-semibold text-sh-text">
                            {r.test} <span className="tabular-nums">{r.value} {r.unit}</span>
                          </span>
                          <span className="block text-[13px] text-sh-text-2">
                            {p.name} · {p.bed ?? 'OPD'}
                            {r.delta ? ` · ${r.delta}` : ''}
                            {r.unackMinutes ? ` · unacknowledged ${r.unackMinutes} min` : ''}
                          </span>
                        </span>
                        <ClinicalFlag flag={r.flag} />
                        <span className="inline-flex items-center gap-[4px] text-[13px] font-semibold text-sh-crit-fg">
                          Acknowledge <Icon icon={ChevronRight} size={15} />
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          <Card
            titleSize="sm"
            title="Results that changed"
            right={<span className="text-[13px] tabular-nums text-sh-text-2">{plural(changed.length, 'result')} · {plural(groups.length, 'patient')}</span>}
          >
            {groups.length === 0 ? (
              <p className="text-[14px] text-sh-text-2">Nothing new to review.</p>
            ) : (
              <ul aria-label="Results that changed, by patient" className="flex flex-col gap-[10px]">
                {groups.slice(0, PATIENTS_SHOWN).map((g) => {
                  const p = patient(g.patientId)
                  return (
                    <li key={g.patientId} className="rounded-[14px] bg-sh-inner p-[12px]">
                      <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[4px]">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[15px] font-semibold text-sh-text">{p.name}</span>
                          <span className="block text-[12px] text-sh-text-3">
                            {p.age}/{p.sex} · {p.bed ?? 'OPD'} · {p.uhid}
                          </span>
                        </span>
                        <Pill variant="card" size="lg" iconSize={15} onClick={() => navigate(canonical(recordPath(p, 'results')))} aria-label={`${p.name}'s test results`}>
                          {plural(g.rows.length, 'result')} <Icon icon={ChevronRight} size={15} />
                        </Pill>
                      </div>
                      <ul className="mt-[8px] flex flex-col divide-y divide-(--line)">
                        {g.rows.slice(0, RESULTS_SHOWN).map((r) => (
                          <li key={r.id} className="flex flex-wrap items-center gap-x-[10px] gap-y-[2px] py-[6px] text-[13px]">
                            <span className="min-w-[140px] flex-1 text-sh-text">{r.test}</span>
                            <span className="font-semibold tabular-nums text-sh-text">
                              {r.value} {r.unit}
                            </span>
                            <ClinicalFlag flag={r.flag} />
                            <span className={cn('basis-full text-[12px] text-sh-text-2 sm:basis-auto', d.aiActive && r.delta && 'inline-flex items-center gap-[4px]')}>
                              {d.aiActive && r.delta ? (
                                <>
                                  <Diamond /> {r.delta}
                                </>
                              ) : (
                                `Normal range ${r.refRange}${r.priorValue ? ` · previously ${r.priorValue}` : ''}`
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {g.rows.length > RESULTS_SHOWN && <p className="mt-[4px] text-[12px] text-sh-text-3">and {g.rows.length - RESULTS_SHOWN} more</p>}
                    </li>
                  )
                })}
                {groups.length > PATIENTS_SHOWN && (
                  <li className="text-[13px] text-sh-text-2">
                    {plural(groups.length - PATIENTS_SHOWN, 'more patient')} in Test results.
                  </li>
                )}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-[16px]">
          <Card titleSize="sm" title="Your inpatients overnight">
            {ward.length === 0 ? (
              <p className="text-[14px] text-sh-text-2">No inpatient is deteriorating, and no admission is waiting.</p>
            ) : (
              <ul aria-label="Your inpatients overnight" className="flex flex-col gap-[6px]">
                {ward.map((i) => {
                  const p = patient(i.patientId)
                  return (
                    <li key={i.id}>
                      <button
                        type="button"
                        onClick={() => openQuickPanel(i)}
                        className="flex min-h-[52px] w-full items-center gap-[10px] rounded-[14px] bg-sh-inner px-[12px] py-[8px] text-left transition-colors duration-150 hover:bg-sh-hover-strong"
                      >
                        <span className={cn('size-[10px] shrink-0 rounded-full', i.urgency === 'critical' ? 'bg-sh-crit' : 'bg-sh-warn')} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-[6px] text-[14px] font-medium text-sh-text">
                            {i.reason}
                            {i.ai && d.aiActive && <Diamond />}
                          </span>
                          <span className="block truncate text-[12px] text-sh-text-2">
                            {p.name} · {p.bed ?? '—'}
                          </span>
                        </span>
                        <Icon icon={ChevronRight} size={16} className="shrink-0 text-sh-chev" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          <Card titleSize="sm" title="Today">
            <ol aria-label="Today's plan" className="flex flex-col gap-[4px]">
              {d.blocks
                .filter((b) => b.id !== 'brief')
                .map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => navigate(canonical(b.to))}
                      className="flex min-h-[48px] w-full items-center gap-[10px] rounded-[12px] px-[8px] py-[6px] text-left transition-colors duration-150 hover:bg-sh-hover"
                    >
                      <span className="w-[64px] shrink-0 text-[13px] font-semibold tabular-nums text-sh-text">{fmtTime12(b.at)}</span>
                      <Icon icon={iconFor(b.icon)} size={16} className="shrink-0 text-sh-text-2" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-medium text-sh-text">{b.title}</span>
                        <span className="block truncate text-[12px] text-sh-text-2">{b.summary}</span>
                      </span>
                    </button>
                  </li>
                ))}
            </ol>
            {d.toFinish.length > 0 && (
              <div className="mt-[12px] border-t border-sh-line pt-[12px]">
                <p className="mb-[6px] text-[12px] font-semibold uppercase tracking-[0.06em] text-sh-text-3">Left to finish</p>
                <ul className="flex flex-wrap gap-[8px]" aria-label="Left to finish">
                  {d.toFinish.map((t) => (
                    <li key={t.key}>
                      <Pill variant="control" size="lg" icon={iconFor(t.icon)} onClick={() => navigate(canonical(t.to))}>
                        {t.label} · {t.count}
                      </Pill>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </div>
      </div>
    </ScreenFrame>
  )
}

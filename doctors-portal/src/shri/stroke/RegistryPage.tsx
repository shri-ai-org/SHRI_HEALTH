/**
 * S-18-20 · Stroke registry — `/stroke/registry` (`src/screens/m18/
 * S1820.tsx`): "Ninety days later, still chasing the call the award depends
 * on."
 *
 * The honest version of an outcomes screen: the clinical work finished three
 * months ago, and what is left is a phone call somebody has to make. AI-708
 * prioritises the outreach; the fallback is a scheduled call list, which is
 * what most registries run on. The default slice is the calls due now; the
 * hard 90-day deadline is stated once, on the alert; the class-3 export rule
 * once, behind Why.
 *
 * Fixed: the outstanding-calls alert quoted AI-708's outreach reason with the
 * AI off; it now says only the deadline, as the list does.
 */

import { Check, Clock, Download, PhoneCall, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { OUTCOMES, REGISTRY_INDICATORS, type OutcomeRow } from '@/data/stroke'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useScope } from '../logic/scope'
import { useAiActive } from '../state/ai'
import { Alert } from '../ui/Alert'
import { Why } from '../ui/Disclosure'
import { Select } from '../ui/forms'
import { Card, Pill, PillTag } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'
import { Worklist, type WorklistColumn } from '../ui/Worklist'

import { IndicatorBars } from './charts'

const MRS_LABEL: Record<number, string> = {
  0: 'No symptoms',
  1: 'No significant disability',
  2: 'Slight disability, independent',
  3: 'Moderate, walks unaided',
  4: 'Moderately severe, needs help',
  5: 'Severe, bedridden',
  6: 'Died',
}

type Scope = 'due' | 'open' | 'complete'
const SCOPES: readonly Scope[] = ['due', 'open', 'complete']
const PERIODS = ['Last 30 days', 'Last 90 days', 'This financial year']

export function RegistryPage() {
  const toast = useUI((s) => s.toast)
  const aiActive = useAiActive()
  const [period, setPeriod] = useState('Last 90 days')
  const [called, setCalled] = useState<string[]>([])
  const [scope, setScope] = useScope(SCOPES, 'due')

  const isDone = (o: OutcomeRow) => o.mrs90 !== null || called.includes(o.caseNo)
  /** The three slices of the follow-up field. Calls due is the one acted on now. */
  const due = OUTCOMES.filter((o) => !isDone(o) && (o.followUpStatus === 'Call due' || o.followUpStatus === 'Unreachable — 3 attempts'))
  const open = OUTCOMES.filter((o) => !isDone(o) && o.followUpStatus === 'Window open')
  const complete = OUTCOMES.filter(isDone)
  const completeness = Math.round((complete.length / OUTCOMES.length) * 100)
  const rows = scope === 'due' ? due : scope === 'open' ? open : complete

  const indicators = REGISTRY_INDICATORS.map((i) => {
    /** Fraction of the target, capped for the bar. */
    const numeric = parseFloat(i.value)
    const target = parseFloat(i.target.replace(/[^\d.]/g, ''))
    return { label: i.label, value: i.value, target: i.target, met: i.met, fraction: Math.min(1, numeric / target) }
  })

  const call = (o: OutcomeRow) => {
    setCalled((c) => [...c, o.caseNo])
    toast({ tone: 'success', title: `${o.patientInitials} reached`, detail: 'mRS recorded. Completeness has moved.' })
  }

  const columns: WorklistColumn<OutcomeRow>[] = [
    { key: 'case', label: 'Case', role: 'lead', cell: (o) => <span title={o.caseNo}>{o.caseNo.split('/').pop()}</span> },
    {
      key: 'site',
      label: 'Site',
      role: 'primary',
      cell: (o) => (
        <>
          {o.site} · {o.treatedWith}
          <span className="font-normal text-sh-text-3"> · {o.patientInitials}</span>
        </>
      ),
    },
    { key: 'dtn', label: 'DTN', role: 'context', cell: (o) => (o.dtnMin === null ? null : <span className="tabular-nums">DTN {o.dtnMin} min</span>) },
    { key: 'ditg', label: 'Door to groin', role: 'context', cell: (o) => (o.ditgMin === null ? null : <span className="tabular-nums">door-to-groin {o.ditgMin} min</span>) },
    {
      key: 'mrs',
      label: 'mRS at 90 days',
      role: 'context',
      cell: (o) =>
        o.mrs90 !== null ? (
          <span className="tabular-nums">
            mRS {o.mrs90} · {MRS_LABEL[o.mrs90]}
          </span>
        ) : called.includes(o.caseNo) ? (
          'mRS collected'
        ) : (
          'mRS not yet recorded'
        ),
    },
    { key: 'reason', label: 'Why now', role: 'context', cell: (o) => (aiActive && !isDone(o) && o.outreachReason ? o.outreachReason : null) },
    {
      key: 'status',
      label: 'Follow-up',
      role: 'status',
      cell: (o) =>
        isDone(o) ? (
          <PillTag tone="norm" size="sm" icon={Check}>
            Complete
          </PillTag>
        ) : o.followUpStatus === 'Window open' ? (
          <PillTag tone="neu" size="sm" icon={Clock}>
            Window open
          </PillTag>
        ) : (
          <PillTag tone={o.followUpStatus.startsWith('Unreachable') ? 'crit' : 'warn'} size="sm" icon={o.followUpStatus.startsWith('Unreachable') ? TriangleAlert : PhoneCall}>
            {o.followUpStatus}
          </PillTag>
        ),
    },
  ]

  return (
    <ScreenFrame
      screenId="S-18-20"
      heading="Stroke registry"
      sub={`${completeness}% follow-up complete against a 90% target · ${due.length} call${due.length === 1 ? '' : 's'} due`}
      actions={
        <>
          <Select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Reporting period" className="h-[46px] w-auto bg-sh-card">
            {PERIODS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
          <Pill variant="card" size="xl" icon={Download} iconSize={17} onClick={() => toast({ tone: 'info', title: 'Registry export prepared', detail: 'The recipient and the fields are recorded.' })}>
            Export
          </Pill>
        </>
      }
      railTitle="Registry"
      rail={
        <div className="flex flex-col gap-[12px]">
          <Card titleSize="sm" title="Completeness">
            <p className={cn('text-[36px] font-bold tabular-nums', completeness >= 90 ? 'text-sh-norm-fg' : 'text-sh-warn-fg')}>{completeness}%</p>
            <p className="text-[14px] text-sh-text-3">target 90%</p>
            <p className="mt-[10px] text-[13px] text-sh-text-2">
              Incomplete follow-up is the single commonest reason a stroke centre loses its accreditation, and it has nothing to do with the quality of the care.
            </p>
          </Card>
          {aiActive && (
            <Why label="How the call list is ordered">
              <p>AI-708 orders the call list by how close each case is to the end of its 90-day window, and suggests which contact to try. The fallback is a scheduled call list in date order.</p>
            </Why>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-[20px]">
        {/* The one statement of the hard deadline. */}
        {due.length > 0 && (
          <Alert tone="warn" title={`${due.length} follow-up call${due.length === 1 ? '' : 's'} outstanding`}>
            {aiActive && due[0].outreachReason ? `${due[0].outreachReason} ` : ''}Once the 90-day window closes the outcome cannot be recorded at all, and the case counts against
            completeness for good.
          </Alert>
        )}

        <Worklist
          rows={rows}
          columns={columns}
          rowKey={(o) => o.caseNo}
          caption="Stroke cases and their 90-day outcomes"
          noun="cases"
          rowAction={(o) =>
            isDone(o) || o.followUpStatus === 'Window open' ? null : (
              <Pill variant="primary" size="lg" icon={PhoneCall} onClick={() => call(o)} aria-label={`Call now, ${o.caseNo}`}>
                Call now
              </Pill>
            )
          }
          emptyWhy={
            scope === 'due'
              ? 'No case is waiting on a call right now. The ones whose window is still open are one tap away.'
              : scope === 'open'
                ? 'Every case in this period is either called or due — none is still inside its window.'
                : 'No outcome has been recorded in this period yet.'
          }
          filters={
            <Segmented
              label="Follow-up"
              value={scope}
              onChange={setScope}
              options={[
                { key: 'due', label: 'Calls due', icon: PhoneCall, count: due.length },
                { key: 'open', label: 'Window open', icon: Clock, count: open.length },
                { key: 'complete', label: 'Done', icon: Check, count: complete.length },
              ]}
            />
          }
        />

        <Card titleSize="sm" title="Indicators" right={<span className="text-[13px] text-sh-text-3">against target, one measure per bar</span>}>
          <IndicatorBars rows={indicators} />
          <Why label="Which two are missed, and what gets exported" className="mt-[12px]">
            <p>Two are missed: DIDO at the spokes, and follow-up completeness. Both are coordination problems rather than clinical ones, which is the whole argument for the module.</p>
            <p>
              An export carries clocks, treatment, outcome and site, with de-identified case references. Every export is a class-3 audit event: the recipient, the fields and the
              reason are all recorded, because a registry submission is a disclosure of patient data however aggregated it looks.
            </p>
          </Why>
        </Card>
      </div>
    </ScreenFrame>
  )
}

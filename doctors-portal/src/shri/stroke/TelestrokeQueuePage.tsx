/**
 * S-18-10 · Telestroke queue — `/stroke/telestroke/queue` (`src/screens/m18/
 * S1810.tsx`): "Requests from the spokes, ranked by clock and severity."
 *
 * The ranking is the highest-stakes use of AIP-07 in the product, so the
 * reversibility rule matters more than usual: arrival order is one choice
 * away, and it is the order with the AI off. The requests inside the
 * thrombolysis window are the default slice (`?scope=`); the one outside it
 * is a tap away and still needs answering. Window remaining is arithmetic on
 * the recorded last-known-well against the fixed 4.5-hour window — a
 * deadline, not a forecast.
 *
 * Where the old queue fell short: the window was said to be "recomputed every
 * second against the server clock" and never moved (it runs with the case
 * clock now); with the AI off it still ranked by time value (arrival order
 * then, as AIP-07 requires); the header said "ranked by clock, not arrival"
 * whichever order was chosen; Start / Rejoin was a span inside the row's
 * button (a real button beside the row), offered to a persona who cannot
 * open the session (absent, GP-02).
 */

import { Clock, Timer, Video } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatElapsed, formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { STROKE_NOW, TELESTROKE_QUEUE } from '@/data/stroke'
import { minutesBetween } from '@/store/stroke'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useCaseClock } from '../logic/caseClock'
import { useScope } from '../logic/scope'
import { useAiActive } from '../state/ai'
import { Why } from '../ui/Disclosure'
import { KeyValue } from '../ui/KeyValue'
import { Card, Pill, PillTag } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'
import { Worklist, type WorklistColumn } from '../ui/Worklist'

type Row = (typeof TELESTROKE_QUEUE)[number]
type Scope = 'inside' | 'outside'
const SCOPES: readonly Scope[] = ['inside', 'outside']

/** The 4.5-hour thrombolysis window, in minutes from last known well. */
const WINDOW_MIN = 270

export function TelestrokeQueuePage() {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const aiActive = useAiActive()
  const caseNow = useCaseClock()
  const [aiSort, setAiSort] = useState(true)
  const [scope, setScope] = useScope(SCOPES, 'inside')

  const byValue = aiActive && aiSort
  // The recorded LKW-elapsed is as of the case clock's base (02:52); it runs on with the clock.
  const sinceBase = minutesBetween(STROKE_NOW, caseNow)
  const lkwElapsed = (r: Row) => r.lkwElapsedMin + sinceBase
  /** Time-value ranking: window remaining, then severity. */
  const remaining = (r: Row) => Math.max(0, WINDOW_MIN - lkwElapsed(r))
  const sorted = byValue
    ? [...TELESTROKE_QUEUE].sort((a, b) => remaining(a) - remaining(b) || b.nihss - a.nihss)
    : [...TELESTROKE_QUEUE].sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
  const inside = sorted.filter((r) => remaining(r) > 0)
  const outside = sorted.filter((r) => remaining(r) <= 0)
  const rows = scope === 'inside' ? inside : outside
  const inSession = TELESTROKE_QUEUE.filter((r) => r.status === 'In session').length

  const sessionPath = (r: Row) => `/stroke/case/${r.caseId}/telestroke`
  const open = (r: Row) => {
    if (may(sessionPath(r))) navigate(sessionPath(r))
  }

  const columns: WorklistColumn<Row>[] = [
    {
      key: 'window',
      label: 'Window',
      role: 'lead',
      cell: (r) => <span className={cn(remaining(r) <= 0 ? 'text-sh-text-3' : remaining(r) < 90 ? 'text-sh-warn-fg' : 'text-sh-norm-fg')}>{remaining(r) <= 0 ? 'closed' : formatElapsed(remaining(r))}</span>,
    },
    {
      key: 'case',
      label: 'Case',
      role: 'primary',
      cell: (r) => {
        const p = patient(r.patientId)
        return (
          <>
            STROKE/26-27/{r.caseId} <span className="font-normal text-sh-text-2">· {r.site}</span>
            <span className="ml-[8px] font-normal tabular-nums text-sh-text-2">
              {p.age}/{p.sex}
            </span>
          </>
        )
      },
    },
    { key: 'nihss', label: 'NIHSS', role: 'context', cell: (r) => <span className="tabular-nums">NIHSS {r.nihss}</span> },
    { key: 'finding', label: 'Imaging', role: 'context', cell: (r) => (aiActive ? r.aiFinding : 'awaiting a read') },
    { key: 'lkw', label: 'LKW', role: 'context', cell: (r) => <span className="tabular-nums">LKW {formatElapsed(lkwElapsed(r))} ago</span> },
    {
      key: 'status',
      label: 'Status',
      role: 'status',
      cell: (r) => (
        <PillTag tone={r.status === 'In session' ? 'norm' : 'warn'} size="sm" icon={r.status === 'In session' ? Video : Clock}>
          {r.status}
        </PillTag>
      ),
    },
  ]

  return (
    <ScreenFrame
      screenId="S-18-10"
      heading="Telestroke queue"
      sub={`${TELESTROKE_QUEUE.length} requests · ${inside.length} inside the window · ${inSession} in session · ${byValue ? 'ranked by clock, not arrival' : 'in arrival order'}`}
      empty={
        <Card className="items-center p-[40px] text-center">
          <p className="text-[18px] font-medium">No telestroke requests waiting.</p>
          <p className="mx-auto mt-[8px] max-w-[448px] text-sh-text-2">A spoke site activating a code stroke raises a request here automatically. There is nothing to poll.</p>
        </Card>
      }
    >
      <div className="flex min-w-0 flex-col gap-[20px]">
        <Worklist
          rows={rows}
          columns={columns}
          rowKey={(r) => r.caseId}
          onOpen={open}
          aiSort={aiSort}
          onSortChange={setAiSort}
          sortCapability="AI-613"
          aiSortLabel="Time value"
          deterministicLabel="Arrival time"
          caption="Telestroke requests from the network"
          noun="requests"
          rowLabel={(r) => `STROKE/26-27/${r.caseId}, ${r.site}, NIHSS ${r.nihss}, ${remaining(r) <= 0 ? 'window closed' : `${formatElapsed(remaining(r))} of window left`}, ${r.status}`}
          rowAction={(r) =>
            may(sessionPath(r)) ? (
              <Pill variant={r.status === 'In session' ? 'primary' : 'control'} size="lg" icon={Video} onClick={() => open(r)} aria-label={`${r.status === 'In session' ? 'Rejoin' : 'Start'} STROKE/26-27/${r.caseId}`}>
                {r.status === 'In session' ? 'Rejoin' : 'Start'}
              </Pill>
            ) : null
          }
          emptyWhy={scope === 'inside' ? 'No request is inside the thrombolysis window right now. Requests outside it are one tap away and still need a plan.' : 'Every waiting request is still inside its window.'}
          filters={
            <Segmented
              label="Which to show"
              value={scope}
              onChange={setScope}
              options={[
                { key: 'inside', label: 'In window', icon: Timer, count: inside.length },
                { key: 'outside', label: 'Outside window', icon: Clock, count: outside.length },
              ]}
            />
          }
        />

        <Why label="How the queue is ranked, and what outside the window means">
          <p>
            Window remaining first, then severity. A patient whose window closes in 90 minutes outranks one who arrived first but is already outside it. Where the ranking is wrong, sorting by arrival time is one click away and the list does not re-order under you mid-scan.
          </p>
          <p>
            A request outside the window is still in the queue and still needs answering — outside the window is a different decision, not no decision. Extended-window imaging selection may still apply, and the patient needs a plan either way.
          </p>
          <dl className="flex flex-col divide-y divide-(--line)">
            <KeyValue label="Answer a request">within 5 min</KeyValue>
            <KeyValue label="Complete the NIHSS">within 15 min</KeyValue>
            <KeyValue label="Decision to the spoke">within 20 min</KeyValue>
          </dl>
          <p className="tabular-nums text-sh-text-3">
            Windows are computed from last-known-well against a 4.5-hour thrombolysis window, recomputed every second against the server clock ({formatTime(caseNow)}).
          </p>
        </Why>
      </div>
    </ScreenFrame>
  )
}

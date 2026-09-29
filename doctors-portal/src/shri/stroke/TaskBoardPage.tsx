/**
 * S-18-07 · Task board — `/stroke/case/:id/tasks` (`src/screens/m18/
 * S1807.tsx`): "Eight things happening at once, each with an owner and a
 * timer."
 *
 * The board exists because a stroke pathway is parallel, not sequential, and
 * ARC-04's rule about refused drags earns its place here: a task that cannot
 * legitimately move is refused with the reason on the target column, because
 * "load the ambulance before the bolus" is a clinical error, not a UI mistake.
 * Done folds behind its count; the prioritisation reason is quiet text.
 *
 * Removed, as a forecast (decision 8): T-07's AI-619 line "DIDO projected
 * breach in 19 min" (AI-209's projection) — filtered in the view
 * (`taskReason`); the card keeps its owner, its timer and its hard block.
 *
 * Where the old board fell short: the two self-moving tasks never moved —
 * "this task unblocks itself once thrombolysis is given" and "record who
 * performed it … and it moves itself" were said and not done (the ambulance
 * task leaves Blocked once the needle is stamped, the dose check is done once
 * its second checker is recorded); the "due-time order" fallback with the AI
 * off was named and not applied (it is); the blocked alert named the
 * ambulance task's reason for whatever task was blocked; a move wrote no
 * record (audited now); the index case's board was drawn on every case.
 */

import { Ban, Clock, Radio, User } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { STROKE_TASKS, type StrokeCase, type StrokeTask } from '@/data/stroke'
import { useStroke } from '@/store/stroke'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useCaseClock } from '../logic/caseClock'
import { useStrokeActions } from '../logic/strokeActions'
import { isIndexCase, taskReason, useStrokeCaseParam } from '../logic/strokeCase'
import { useAiActive } from '../state/ai'
import { Alert } from '../ui/Alert'
import { Board, type BoardColumn } from '../ui/Board'
import { Why } from '../ui/Disclosure'
import { Card, Icon, Pill } from '../ui/primitives'

import { CaseClockStrip } from './CaseClockStrip'
import { NoStream, NoSuchCase } from './StrokeBits'

const COLUMNS = ['To do', 'In progress', 'Blocked', 'Done'] as const
const TONE = { 'To do': 'neu', 'In progress': 'warn', Blocked: 'crit', Done: 'norm' } as const

export function TaskBoardPage() {
  const { id, strokeCase } = useStrokeCaseParam()
  if (!strokeCase) return <NoSuchCase screenId="S-18-07" id={id} />
  return <TaskBoard key={strokeCase.id} c={strokeCase} />
}

function TaskBoard({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const aiActive = useAiActive()
  const caseNow = useCaseClock()
  const actions = useStrokeActions()
  const taskColumns = useStroke((s) => s.taskColumns)
  const needleStamped = useStroke((s) => s.stamps.some((x) => x.key === 'needle'))
  const secondCheckBy = useStroke((s) => s.secondCheckBy)

  const p = patient(c.patientId)
  const own = isIndexCase(c)
  const tasks = own ? STROKE_TASKS : []

  /** Where a task sits: where it was moved to, else where the record puts it — the two that move themselves included. */
  const columnOf = (t: StrokeTask): string => {
    if (taskColumns[t.id]) return taskColumns[t.id]
    if (t.id === 'T-07' && needleStamped) return 'To do'
    if (t.id === 'T-06' && secondCheckBy) return 'Done'
    return t.column
  }
  // AI-619's order is the record's; with the AI off, due-time order (untimed last), as the Why says.
  const ordered = aiActive ? tasks : [...tasks].sort((a, b) => (a.dueInMin ?? Infinity) - (b.dueInMin ?? Infinity))
  const inColumn = (k: string) => ordered.filter((t) => columnOf(t) === k)
  const columns: BoardColumn<StrokeTask>[] = COLUMNS.map((k) => ({ key: k, label: k, tone: TONE[k], rows: inColumn(k) }))
  const blocked = inColumn('Blocked')

  /** The hard rules: the ambulance waits for the bolus; the dose check is not ticked off from here. */
  function canDrop(task: StrokeTask, columnKey: string): true | string {
    if (task.id === 'T-07' && columnKey !== 'Blocked' && !needleStamped) {
      return 'The needle has not been stamped. Drip-and-ship requires the bolus before the patient is loaded — this task unblocks itself once thrombolysis is given.'
    }
    if (task.id === 'T-06' && columnKey === 'Done' && columnOf(task) === 'To do') {
      return 'The second dose check cannot go straight to done. Record who performed it on the thrombolysis screen and it moves itself.'
    }
    return true
  }

  const clock = `/stroke/case/${c.id}/clock`

  return (
    <ScreenFrame
      screenId="S-18-07"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="Task board"
      sub={`${inColumn('To do').length} to do · ${inColumn('In progress').length} in progress · ${blocked.length} blocked · ${inColumn('Done').length} done`}
      actions={
        may(clock) && (
          <Pill variant="card" size="xl" icon={Clock} iconSize={17} onClick={() => navigate(clock)}>
            Case clock
          </Pill>
        )
      }
    >
      {/* Below 1024 the board scrolls sideways inside itself, never the page. Its scroller is not positioned, so the
          cards' 44px hit areas would escape it and widen the page; this frame holds and clips them. */}
      <div className="relative flex min-w-0 flex-col gap-[20px] overflow-x-clip">
        {blocked.length > 0 && (
          <Alert tone="crit" title={`${blocked.length} ${blocked.length === 1 ? 'task' : 'tasks'} blocked`}>
            {blocked[0].id === 'T-07' && !needleStamped ? `${blocked[0].label} cannot move until the needle is stamped — the card says why.` : `${blocked[0].label} is blocked — the card says why.`}
          </Alert>
        )}

        {own ? (
          <Board
            columns={columns}
            hiddenColumns={['Done']}
            rowKey={(t) => t.id}
            rowName={(t) => t.label}
            canDrop={canDrop}
            onDrop={(t, k) => actions.moveTask(t.id, t.label, t.owner, k)}
            legend={<span className="text-[13px] text-sh-text-2">Drag a card · a refused drop names the clinical reason on the column</span>}
            asOf={
              <span className="flex items-center gap-[4px] text-[13px] tabular-nums text-sh-text-2">
                <Icon icon={Radio} size={12} />
                server {formatTime(caseNow)}
              </span>
            }
            renderCard={(t) => {
              const reason = aiActive ? taskReason(t) : undefined
              const isBlocked = columnOf(t) === 'Blocked'
              return (
                <div className={cn('rounded-[16px] bg-sh-card p-[14px]', isBlocked && 'inset-ring-1 inset-ring-(--crit-fg)')}>
                  <p className="font-medium text-sh-text">{t.label}</p>
                  <p className="mt-[4px] flex flex-wrap items-center gap-x-[8px] gap-y-[2px] text-[13px] text-sh-text-2">
                    <span className="flex items-center gap-[6px]">
                      <Icon icon={User} size={12} />
                      {t.owner}
                    </span>
                    {t.dueInMin !== null && <span className={cn('font-semibold tabular-nums', t.dueInMin <= 10 ? 'text-sh-crit-fg' : 'text-sh-warn-fg')}>· {t.dueInMin} min</span>}
                  </p>
                  {/* The prioritisation reason, as quiet text. Provenance lives in the Why. */}
                  {reason && <p className="mt-[6px] text-[13px] text-sh-text-2">{reason}</p>}
                  {t.blockedBy && isBlocked && (
                    <p className="mt-[8px] flex items-start gap-[6px] rounded-[12px] bg-sh-crit-bg px-[10px] py-[6px] text-[13px] font-medium text-sh-crit-fg">
                      <Icon icon={Ban} size={12} className="mt-[3px]" />
                      {t.blockedBy}
                    </p>
                  )}
                </div>
              )
            }}
          />
        ) : (
          <Card>
            <NoStream caseNo={c.caseNo} what="tasks" />
          </Card>
        )}

        <Why label="Why the board is parallel, and how the cards are ordered">
          <p>Consent, imaging, blood pressure and pre-authorisation all run at the same time. Sequenced, they add up to more than the window. The board exists so nobody waits for a step they are not blocking.</p>
          {aiActive && <p>AI-619 orders the cards by how much clock they free, not by when they were created; the quiet line on each card says why it sits where it does. Fallback: due-time order.</p>}
          <p className="text-sh-text-3">A drag that violates a hard rule is refused with the reason on the target column, because the ordering is clinical rather than administrative.</p>
        </Why>
      </div>
    </ScreenFrame>
  )
}

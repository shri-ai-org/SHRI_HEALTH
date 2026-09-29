/**
 * S-05-03 · OPD queue — `/op-queue` (`src/screens/m05/S0503.tsx`): "The
 * waiting room told the truth about how long it will be." Now the OPD tab of
 * My patients (`MyPatientsFrame`).
 *
 * The same rows, in the same order, with the same statuses as My Day's
 * Patients Today and its counts — all from `useOpdLive` (`logic/opd.ts`), so
 * calling a patient here puts them In room on My Day too, and signing their
 * note makes them Seen everywhere. Two shapes: LIST, what a consultant between
 * patients wants; BOARD, the session at a glance for the front office.
 *
 * Forecasts removed (decision 8): AI-607's "next in about N min" and each
 * card's "~Nm to be called" with its Why. What stays is what was recorded —
 * how long each patient has waited, and that the session runs 6 min behind.
 */

import { ArrowLeft, ArrowRight, Check, Clock, DoorOpen, Grid2x2, Hourglass, Phone, RotateCcw, Video, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { maybeEncounter } from '@/data/clinical'
import { NOW, formatElapsed, formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { isFollowUp } from '@/data/myday'
import { useUI } from '@/store/ui'

import { cn } from '../lib/cn'
import { opdCounts, useOpdLive, type OpdRow } from '../logic/opd'
import { consultPath, recordPath } from '../logic/record'
import { useOpd } from '../state/opd'
import { Board, type BoardColumn } from '../ui/Board'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'
import { Worklist, type WorklistColumn } from '../ui/Worklist'

import { MyPatientsFrame } from './MyPatientsFrame'

const waited = (r: OpdRow) => formatElapsed((NOW.getTime() - (r.clinic?.arrivedAt?.getTime() ?? NOW.getTime())) / 60000)
const key = (r: OpdRow) => r.clinic?.token ?? r.tele?.id ?? r.patientId

export function OpdQueuePage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const toast = useUI((s) => s.toast)
  const start = useOpd((s) => s.start)
  const all = useOpdLive()
  const [view, setView] = useState<'list' | 'board'>('list')

  const followUpOnly = params.get('type') === 'follow-up'
  const rows = followUpOnly ? all.filter((r) => isFollowUp(r.patientId)) : all
  const counts = opdCounts(rows)
  const next = rows.find((r) => r.live === 'Waiting')

  /** Calling in starts the consultation: In room on every card until the note is signed. */
  function call(r: OpdRow) {
    start(r.patientId)
    const p = patient(r.patientId)
    toast({ tone: 'info', title: `Calling ${key(r)}`, detail: `${p.name} · the note opens with the scribe ready.` })
    const to = consultPath(p)
    if (to) navigate(to)
  }
  /** A teleconsult is joined from its session; joining is what puts them in the room. */
  const connect = (r: OpdRow) => r.tele && navigate(`/tele/session/${maybeEncounter(r.tele.id) ? r.tele.id : r.patientId}`)
  const resume = (r: OpdRow) => {
    const to = r.tele ? `/tele/session/${maybeEncounter(r.tele.id) ? r.tele.id : r.patientId}` : consultPath(patient(r.patientId))
    if (to) navigate(to)
  }

  function statusChip(r: OpdRow) {
    switch (r.live) {
      case 'Admission in progress':
        return (
          <PillTag tone="warn" size="sm" icon={Hourglass}>
            Admission in progress
          </PillTag>
        )
      case 'Seen':
        return (
          <PillTag tone="norm" size="sm" icon={Check}>
            Seen
          </PillTag>
        )
      case 'In room':
        return (
          <PillTag tone="pend" size="sm" icon={DoorOpen}>
            In room
          </PillTag>
        )
      case 'Waiting':
        return (
          <PillTag tone="warn" size="sm" icon={Clock}>
            Waiting {waited(r)}
          </PillTag>
        )
      case 'Teleconsult':
        return r.tele?.videoReady ? (
          <PillTag tone="neu" size="sm" icon={Video}>
            Video {formatTime(r.due)}
          </PillTag>
        ) : (
          <PillTag tone="warn" size="sm" icon={Phone}>
            Telephone only
          </PillTag>
        )
      default:
        return (
          <PillTag tone="neu" size="sm" icon={Clock}>
            Not arrived
          </PillTag>
        )
    }
  }

  function action(r: OpdRow) {
    const p = patient(r.patientId)
    if (r.live === 'Waiting')
      return (
        <Pill variant="primary" size="lg" icon={ArrowRight} onClick={() => call(r)} aria-label={`Call ${key(r)}, ${p.name}`}>
          Call
        </Pill>
      )
    if (r.live === 'Teleconsult')
      return (
        <Pill variant="control" size="lg" icon={Video} onClick={() => connect(r)} aria-label={`Connect to ${p.name}`}>
          Connect
        </Pill>
      )
    if (r.live === 'In room')
      return (
        <Pill variant="control" size="lg" icon={ArrowRight} onClick={() => resume(r)} aria-label={`Continue the consultation with ${p.name}`}>
          Continue
        </Pill>
      )
    return null
  }

  const columns: WorklistColumn<OpdRow>[] = [
    { key: 'token', label: 'Token', role: 'lead', cell: (r) => r.clinic?.token ?? formatTime(r.due) },
    { key: 'patient', label: 'Patient', role: 'primary', cell: (r) => patient(r.patientId).name },
    {
      key: 'who',
      label: 'Age / sex',
      role: 'context',
      cell: (r) => {
        const p = patient(r.patientId)
        return (
          <span className="tabular-nums">
            {p.age}/{p.sex}
          </span>
        )
      },
    },
    { key: 'booked', label: 'Booked', role: 'context', cell: (r) => (r.clinic ? <span className="tabular-nums">booked {formatTime(r.clinic.bookedAt)}</span> : null) },
    { key: 'visit', label: 'Visit', role: 'context', cell: (r) => r.kind?.label },
    { key: 'state', label: 'Status', role: 'status', cell: statusChip },
  ]

  const cols: BoardColumn<OpdRow>[] = [
    { key: 'notarrived', label: 'Not arrived', tone: 'neu', rows: rows.filter((r) => r.live === 'Not arrived') },
    { key: 'waiting', label: 'Waiting', tone: 'warn', capacity: `longest ${formatElapsed(18)}`, rows: rows.filter((r) => r.live === 'Waiting' || r.live === 'Admission in progress') },
    { key: 'video', label: 'Teleconsult', tone: 'pend', rows: rows.filter((r) => r.live === 'Teleconsult') },
    { key: 'inroom', label: 'In room', tone: 'norm', rows: rows.filter((r) => r.live === 'In room') },
    { key: 'seen', label: 'Seen', tone: 'neu', rows: rows.filter((r) => r.live === 'Seen') },
  ]

  return (
    <MyPatientsFrame
      tab="opd"
      screenId="S-05-03"
      sub={`${counts.booked} booked · ${counts.seen} seen · ${counts.waiting} waiting · running 6 min behind`}
      actions={
        next && (
          <Pill variant="primary" size="xl" icon={ArrowRight} onClick={() => call(next)}>
            Call {key(next)}
          </Pill>
        )
      }
    >
      {view === 'list' ? (
        <div className="max-w-[896px]">
          <Worklist
            rows={rows}
            columns={columns}
            rowKey={key}
            // A row opens the record; Call, Connect and Continue are the consultation's own steps.
            onOpen={(r) => navigate(recordPath(patient(r.patientId), 'record'))}
            rowAction={action}
            caption="Today's outpatient session"
            noun="patients"
            emptyWhy={
              followUpOnly
                ? 'No follow-up patients are booked into this session. Clearing the filter shows all of OPD.'
                : 'No patients are booked into this session. A booking, or a walk-in registered at the front office, would appear here.'
            }
            emptyAction={
              followUpOnly ? (
                <Pill variant="control" size="lg" icon={X} onClick={() => setParams({}, { replace: true })}>
                  All of OPD
                </Pill>
              ) : undefined
            }
            filters={
              <>
                <Segmented
                  label="Who to show"
                  value={followUpOnly ? 'followup' : 'all'}
                  options={[
                    { key: 'all', label: 'All' },
                    { key: 'followup', label: 'Follow-ups', icon: RotateCcw },
                  ]}
                  onChange={(k) => setParams(k === 'followup' ? { type: 'follow-up' } : {}, { replace: true })}
                />
                <Pill variant="control" size="lg" icon={Grid2x2} onClick={() => setView('board')}>
                  Session board
                </Pill>
              </>
            }
          />
        </div>
      ) : (
        <>
          <div>
            <Pill variant="control" size="lg" icon={ArrowLeft} onClick={() => setView('list')}>
              Back to the list
            </Pill>
          </div>
          <Board
            columns={cols}
            rowKey={key}
            asOf={<span className="text-[12px] tabular-nums text-sh-text-3">Data as of {formatTime(NOW)}</span>}
            legend={<span className="text-[13px] text-sh-text-2">Token order is the deterministic order. Nothing here reorders a patient without a reason on the card.</span>}
            renderCard={(r) => {
              const p = patient(r.patientId)
              return (
                <Card className={cn('p-[14px]', r.live === 'In room' && 'inset-ring-1 inset-ring-(--norm)')}>
                  <div className="flex items-start justify-between gap-[8px]">
                    <div className="min-w-0">
                      <p className="font-semibold tabular-nums">{key(r)}</p>
                      <p className="truncate text-[14px]">{p.name}</p>
                      <p className="text-[12px] tabular-nums text-sh-text-3">
                        {p.age}/{p.sex} · {r.clinic ? `booked ${formatTime(r.clinic.bookedAt)}` : `video ${formatTime(r.due)}`}
                      </p>
                    </div>
                    {r.live === 'Seen' && <Icon icon={Check} size={15} className="shrink-0 text-sh-norm-fg" />}
                  </div>
                  {r.live === 'Waiting' && r.clinic?.arrivedAt && <p className="mt-[8px] text-[13px] tabular-nums text-sh-text-2">waiting {waited(r)}</p>}
                  {r.live === 'Waiting' && (
                    <Pill variant="primary" size="lg" icon={ArrowRight} className="mt-[10px] w-full" onClick={() => call(r)}>
                      Call this patient
                    </Pill>
                  )}
                  {r.live === 'Teleconsult' && (
                    <Pill variant="control" size="lg" icon={Video} className="mt-[10px] w-full" onClick={() => connect(r)}>
                      Connect
                    </Pill>
                  )}
                </Card>
              )
            }}
          />
        </>
      )}
    </MyPatientsFrame>
  )
}

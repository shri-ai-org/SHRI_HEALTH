/**
 * S-13-01 · Discharge board — `/discharge/board` (`src/screens/m13/
 * S1301.tsx`). Deck beat #24.
 *
 * Two views, the calm one the default. The list is what a consultant on the
 * round wants: one row each, grouped by what is recorded — cleared for
 * discharge, waiting on a gate, discharged — with what is in the way said on
 * the row. The board is ARC-04, kept behind a button for the job the list
 * cannot do: the drag that discharges, "refused with an inline reason on the
 * target" when a hard rule says no, never silently reverted. Every card also
 * has its Discharge button, the way in by keyboard or touch.
 *
 * The old board grouped patients by AI-610's forecast (going home today,
 * tomorrow, not yet) and AI-514's; this build shows no forecasts, so the
 * groups are recorded readiness (decision 9), and the forecast's Why and its
 * "07:00" framing go with it. Its two remaining hard rules stand in its words;
 * the third — no discharge without a signed summary — is retired by "discharge
 * now, sign later": the summary goes to the sign queue instead.
 */

import { CalendarCheck, Clock, DoorOpen, FileText, Grid2x2, List, Pill as PillIcon, TriangleAlert, Wallet, Check } from 'lucide-react'
import { useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'

import { can } from '@/atlas/personas'
import { DISCHARGE_BOARD, encounterForPatient, type DischargeRow } from '@/data/clinical'
import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { useClinical } from '@/store/clinical'
import { useSession } from '@/store/session'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { gatesFor, outstandingFor, summaryKey, useDischarge, type Readiness } from '../logic/discharge'
import { medRecOpen } from '../logic/medrec'
import { useScope } from '../logic/scope'
import type { Tone } from '../mocks/types'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Card, CountBubble, Icon, Pill, PillTag } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'

const SCOPES: readonly Readiness[] = ['cleared', 'waiting', 'gone']

const READINESS: Record<Readiness, { label: string; tone: Tone; icon: typeof Check }> = {
  cleared: { label: 'Cleared for discharge', tone: 'norm', icon: CalendarCheck },
  waiting: { label: 'Waiting on', tone: 'warn', icon: Clock },
  gone: { label: 'Discharged', tone: 'neu', icon: DoorOpen },
}

interface BoardRow {
  row: DischargeRow
  readiness: Readiness
  gates: string[]
  outstanding: string[]
  summarySigned: boolean
}

export function DischargeBoardPage() {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const persona = useSession((s) => s.persona)
  const discharges = useClinical((s) => s.discharges)
  const notes = useClinical((s) => s.notes)
  const medRecs = useClinical((s) => s.medRecs)
  const discharge = useDischarge()
  const [view, setView] = useState<'list' | 'board'>('list')
  const [scope, setScope] = useScope(SCOPES, 'cleared')
  const [confirming, setConfirming] = useState<BoardRow | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const mayDischarge = can(persona, 'discharge.write')

  const rows: BoardRow[] = DISCHARGE_BOARD.map((row) => {
    const enc = encounterForPatient(row.patientId)
    const summarySigned = enc ? notes[summaryKey(enc.id)]?.status === 'signed' : false
    const gates = gatesFor(row)
    const readiness: Readiness = discharges[row.patientId] ? 'gone' : gates.length > 0 ? 'waiting' : 'cleared'
    return { row, readiness, gates, outstanding: outstandingFor(row, summarySigned, medRecOpen(row.patientId, enc ? medRecs[enc.id] : undefined)), summarySigned }
  })
  const inGroup = (r: Readiness) => rows.filter((x) => x.readiness === r)
  const cleared = inGroup('cleared')
  const waiting = inGroup('waiting')
  const gone = inGroup('gone')
  const scoped = inGroup(scope)

  /** The gate a drop on "Discharged" hits first, or true — the old board's refusal, named on the target. */
  const canDischarge = (b: BoardRow): true | string => (b.gates.length > 0 ? b.gates[0] : true)

  function askToDischarge(b: BoardRow) {
    const verdict = canDischarge(b)
    if (verdict !== true) {
      setRefusal(verdict)
      return
    }
    setRefusal(null)
    setConfirming(b)
  }

  /** The two navigations a row offers — the summary and the medicines — shared by the list and the board. */
  const actionsFor = (b: BoardRow) => {
    // The summary and the medicines live on an encounter; the discharge does not need one.
    const enc = encounterForPatient(b.row.patientId)
    const summary = enc ? `/encounter/${enc.id}/discharge-summary` : undefined
    const medRec = enc ? `/encounter/${enc.id}/med-rec` : undefined
    return (
      <>
        {summary && may(summary) && (
          <Pill variant={b.summarySigned ? 'control' : 'primary'} size="md" icon={FileText} aria-label={`Discharge summary — ${patient(b.row.patientId).name}`} onClick={() => navigate(summary)}>
            Summary
          </Pill>
        )}
        {medRec && may(medRec) && (
          <Pill variant="control" size="md" icon={PillIcon} aria-label={`Medication reconciliation — ${patient(b.row.patientId).name}`} onClick={() => navigate(medRec)}>
            Med rec
          </Pill>
        )}
        {b.readiness !== 'gone' && mayDischarge && (
          <Pill
            variant="card"
            size="md"
            icon={DoorOpen}
            aria-label={`Discharge ${patient(b.row.patientId).name}`}
            aria-disabled={b.readiness === 'waiting'}
            title={b.readiness === 'waiting' ? b.gates[0] : undefined}
            className={cn(b.readiness === 'waiting' && 'opacity-40')}
            onClick={() => askToDischarge(b)}
          >
            Discharge
          </Pill>
        )}
      </>
    )
  }

  const facts = (b: BoardRow) => {
    const p = patient(b.row.patientId)
    const clear = b.row.financialClearance === 'Clear'
    const rec = discharges[b.row.patientId]
    return (
      <>
        <p className="text-[12px] tabular-nums text-sh-text-3">
          {p.age}/{p.sex} · {b.row.bed}
          {p.losDays !== undefined && ` · LOS ${p.losDays}d`}
          {rec && ` · discharged ${formatTime(new Date(rec.at))} by ${rec.by}`}
        </p>
        {/* What holds it — the gate, in the old board's words. */}
        {b.readiness === 'waiting' &&
          b.gates.map((g) => (
            <p key={g} className="mt-[6px] flex items-start gap-[6px] text-[12px] font-medium text-sh-warn-fg">
              <Icon icon={TriangleAlert} size={12} className="mt-[2px] shrink-0" />
              {g}
            </p>
          ))}
        {/* What is outstanding but does not block. */}
        {b.outstanding.length > 0 && (
          <p className="mt-[6px] text-[12px] text-sh-text-2">
            {b.readiness === 'gone' && !b.summarySigned ? 'Summary unsigned — it is in the sign queue' : b.outstanding.join(' · ')}
          </p>
        )}
        <span className="mt-[8px] inline-flex">
          <PillTag tone={clear ? 'norm' : 'warn'} size="xs" icon={clear ? Check : Wallet} className="font-semibold">
            {b.row.financialClearance}
          </PillTag>
        </span>
      </>
    )
  }

  const onDropGone = (e: DragEvent) => {
    e.preventDefault()
    // The card carries its patient (Firefox starts no drag without data); the state only lights the target.
    const id = e.dataTransfer.getData('text/plain') || dragging
    const b = rows.find((x) => x.row.patientId === id)
    setDragging(null)
    if (b && b.readiness !== 'gone') askToDischarge(b)
  }

  return (
    <>
      <ScreenFrame
        screenId="S-13-01"
        sub={`${cleared.length} cleared for discharge · ${waiting.length} waiting on a gate · ${gone.length} discharged`}
        actions={
          <Pill variant="card" size="xl" icon={view === 'list' ? Grid2x2 : List} iconSize={17} onClick={() => setView(view === 'list' ? 'board' : 'list')}>
            {view === 'list' ? 'Board view' : 'List view'}
          </Pill>
        }
      >
        {refusal && view === 'list' && <Refusal text={refusal} />}

        {view === 'list' ? (
          <div className="flex max-w-[896px] flex-col gap-[16px]">
            <Segmented
              label="Which patients"
              value={scope}
              onChange={setScope}
              options={SCOPES.map((k) => ({ key: k, label: READINESS[k].label, count: inGroup(k).length }))}
            />
            <Card
              titleSize="sm"
              title={
                <span className="inline-flex items-center gap-[10px]">
                  {READINESS[scope].label}
                  <CountBubble className="bg-sh-control">{scoped.length}</CountBubble>
                </span>
              }
            >
              {scoped.length === 0 ? (
                <p className="px-[4px] py-[8px] text-[14px] text-sh-text-2">
                  {scope === 'cleared'
                    ? 'Nobody is cleared for discharge. A patient with no gate outstanding would appear here.'
                    : scope === 'waiting'
                      ? 'Nobody is waiting on a gate.'
                      : 'Nobody has been discharged yet.'}
                </p>
              ) : (
                <ul className="flex flex-col">
                  {scoped.map((b, i) => (
                    <li key={b.row.patientId} className={cn('flex flex-wrap items-start justify-between gap-x-[16px] gap-y-[10px] py-[12px]', i > 0 && 'border-t border-sh-line', i === 0 && 'pt-0')}>
                      <div className="min-w-0 flex-1 basis-[260px]">
                        <p className="flex flex-wrap items-center gap-[8px]">
                          <span className="truncate text-[15px] font-semibold text-sh-text">{patient(b.row.patientId).name}</span>
                          <PillTag tone={READINESS[b.readiness].tone} size="xs" icon={READINESS[b.readiness].icon} className="font-semibold">
                            {READINESS[b.readiness].label}
                          </PillTag>
                        </p>
                        {facts(b)}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[10px]">{actionsFor(b)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        ) : (
          <div className="flex flex-col gap-[12px]">
            <p className="text-[12px] text-sh-text-3">Drag a card to Discharged, or use its Discharge button. A refusal names its reason on the column.</p>
            <div className="grid grid-cols-1 gap-[16px] md:grid-cols-3 md:items-start">
              {SCOPES.map((k) => {
                const target = k === 'gone'
                return (
                  <section
                    key={k}
                    aria-label={READINESS[k].label}
                    onDragOver={target ? (e) => e.preventDefault() : undefined}
                    onDrop={target ? onDropGone : undefined}
                    className={cn('flex min-h-[160px] flex-col gap-[10px] rounded-sh-card bg-sh-inner p-[12px]', target && dragging && 'inset-ring-2 inset-ring-sh-accent')}
                  >
                    <header className="flex items-center gap-[8px] px-[4px]">
                      <Icon icon={READINESS[k].icon} size={14} className="text-sh-text-3" />
                      <h2 className="text-[14px] font-semibold text-sh-text">{READINESS[k].label}</h2>
                      <CountBubble className="bg-sh-card">{inGroup(k).length}</CountBubble>
                      {target && <span className="ml-auto text-[12px] text-sh-text-3">bed released</span>}
                    </header>
                    {/* The refusal, on the target it refused. */}
                    {target && refusal && <Refusal text={refusal} />}
                    {inGroup(k).map((b) => (
                      <Card
                        key={b.row.patientId}
                        as="article"
                        aria-label={patient(b.row.patientId).name}
                        draggable={b.readiness !== 'gone' && mayDischarge}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', b.row.patientId)
                          e.dataTransfer.effectAllowed = 'move'
                          setDragging(b.row.patientId)
                        }}
                        onDragEnd={() => setDragging(null)}
                        className={cn('p-[14px]', b.readiness !== 'gone' && mayDischarge && 'cursor-grab active:cursor-grabbing')}
                      >
                        <p className="truncate text-[14px] font-semibold text-sh-text">{patient(b.row.patientId).name}</p>
                        {facts(b)}
                        <div className="mt-[10px] flex flex-wrap items-center gap-x-[8px] gap-y-[10px]">{actionsFor(b)}</div>
                      </Card>
                    ))}
                  </section>
                )
              })}
            </div>
          </div>
        )}
      </ScreenFrame>

      <ConfirmDialog
        open={confirming !== null}
        title={`Discharge ${confirming ? patient(confirming.row.patientId).name : ''}?`}
        consequence={
          confirming?.summarySigned
            ? 'The bed will be released to the bed board, and the front office will be notified.'
            : 'The bed will be released to the bed board, and the front office will be notified. The summary is not signed yet, so it will go to the signing queue. The discharge still goes ahead.'
        }
        confirmLabel="Discharge"
        onConfirm={() => {
          if (confirming) discharge(confirming.row.patientId, confirming.row.bed)
          setConfirming(null)
        }}
        onCancel={() => setConfirming(null)}
      />
    </>
  )
}

function Refusal({ text }: { text: string }) {
  return (
    <p role="alert" className="flex items-start gap-[8px] rounded-[14px] bg-sh-warn-bg px-[14px] py-[10px] text-[13px] font-medium text-sh-warn-fg">
      <Icon icon={TriangleAlert} size={14} className="mt-[2px] shrink-0" />
      {text}
    </p>
  )
}

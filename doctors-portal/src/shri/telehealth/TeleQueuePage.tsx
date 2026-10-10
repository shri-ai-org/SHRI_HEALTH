/**
 * S-27-02 · Video visits — `/tele/queue`: the day's video visits as cards in
 * appointment order, each with where it stands (Waiting, In the waiting room, In
 * call, Call ended, Done — visitStatus.ts) and the one button that moves it on:
 * Connect (also for a patient in the waiting room), Back to call, Finish visit, or Open. Above them the four counts, each also a
 * filter; below, the visits already finished, with what they kept.
 */

import { ArrowRight, BellRing, Clock, Film, MessagesSquare, Phone, Video } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { maybeEncounter, type TeleRow } from '@/data/clinical'
import { formatTime } from '@/data/format'
import { patient, patientByAnyId } from '@/data/kit'

import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { initials } from '../lib/initials'
import { Avatar, Card, Icon, Pill } from '../ui/primitives'

import { VISITS } from './visits'
import { clockOf } from './visitRecord'
import { useTele } from './teleStore'
import { STATUS_CLASS, STATUS_WORD, useVisitStatus, type VisitStatus } from './visitStatus'
import { DemoCodeNote } from './DemoCodeNote'
import { alertsAsked, askForAlerts } from './waitingAlerts'

const SEX = { M: 'Male', F: 'Female', O: 'Other' } as const

type Filter = 'all' | 'waiting' | 'incall' | 'ended' | 'done'
// A patient in the waiting room has not been seen yet: counted with Waiting, shown as waiting for you.
const IN_FILTER: Record<Exclude<Filter, 'all'>, VisitStatus[]> = { waiting: ['waiting', 'lobby'], incall: ['incall'], ended: ['ended'], done: ['done'] }

const ACTION: Record<VisitStatus, { label: string; variant: 'primary' | 'control' }> = {
  waiting: { label: 'Connect', variant: 'primary' },
  lobby: { label: 'Connect', variant: 'primary' },
  incall: { label: 'Back to call', variant: 'primary' },
  ended: { label: 'Finish visit', variant: 'primary' },
  done: { label: 'Open', variant: 'control' },
}

function Count({ n, word, hint, cls, active, onClick }: { n: number; word: string; hint: string; cls: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex items-center gap-[12px] rounded-[18px] border-2 bg-sh-card px-[16px] py-[14px] text-left transition-colors hover:bg-sh-hover',
        active ? 'border-sh-primary' : 'border-transparent',
      )}
      data-count={word}
    >
      <span className={cn('flex size-[42px] shrink-0 items-center justify-center rounded-full text-[18px] font-semibold tabular-nums', cls)}>{n}</span>
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold">{word}</span>
        <span className="block text-[12px] text-sh-text-3">{hint}</span>
      </span>
    </button>
  )
}

/** Asked once per computer: a notice when a patient is waiting, even with Shri Health behind other windows. */
function AlertsPrompt() {
  const [asked, setAsked] = useState(alertsAsked)
  if (asked) return null
  return (
    <div className="flex flex-wrap items-center gap-[12px] rounded-[18px] bg-sh-card px-[16px] py-[12px]" data-alerts-prompt="">
      <Icon icon={BellRing} size={18} className="text-sh-text-2" />
      <p className="min-w-[220px] flex-1 text-[14px] text-sh-text-2">Turn on alerts on this computer, so you are told when a patient is waiting in a video call, even when Shri Health is behind other windows.</p>
      <Pill variant="control" size="lg" icon={BellRing} onClick={() => void askForAlerts().then(() => setAsked(true))}>
        Turn on alerts
      </Pill>
    </div>
  )
}

export function TeleQueuePage() {
  const navigate = useNavigate()
  const sessions = useTele((s) => s.sessions)
  const statusOf = useVisitStatus()
  const [filter, setFilter] = useState<Filter>('all')

  const rows = VISITS.map((r) => ({ r, st: statusOf(r.patientId) }))
  const count = (f: Exclude<Filter, 'all'>) => rows.filter((x) => IN_FILTER[f].includes(x.st)).length
  const shown = filter === 'all' ? rows : rows.filter((x) => IN_FILTER[filter].includes(x.st))
  // Connect, for a patient in the waiting room: the visit opens with the call already started, as from the waiting alert.
  const open = (r: TeleRow, join = false) => navigate(`/tele/session/${maybeEncounter(r.id) ? r.id : r.patientId}`, join ? { state: { join: true } } : undefined)
  const toggle = (f: Filter) => setFilter((cur) => (cur === f ? 'all' : f))

  const past = Object.values(sessions)
    .filter((s) => s.endedAt)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 6)
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <ScreenFrame
      screenId="S-27-02"
      heading="Video visits"
      sub={`${today} · ${rows.length} patients today`}
      empty={
        <Card className="items-center p-[40px] text-center">
          <p className="text-[18px] font-medium">No video visits today.</p>
          <p className="mx-auto mt-[8px] max-w-[448px] text-sh-text-3">When a patient books a video visit, they appear here.</p>
        </Card>
      }
    >
      <DemoCodeNote />
      <AlertsPrompt />
      <div className="grid grid-cols-2 gap-[12px] lg:grid-cols-4" role="group" aria-label="Show">
        <Count n={count('waiting')} word="Waiting" hint="Booked, not started" cls={STATUS_CLASS.waiting} active={filter === 'waiting'} onClick={() => toggle('waiting')} />
        <Count n={count('incall')} word="In call" hint="On a video call now" cls={STATUS_CLASS.incall} active={filter === 'incall'} onClick={() => toggle('incall')} />
        <Count n={count('ended')} word="Call ended" hint="Notes to finish" cls={STATUS_CLASS.ended} active={filter === 'ended'} onClick={() => toggle('ended')} />
        <Count n={count('done')} word="Done" hint="Finished today" cls={STATUS_CLASS.done} active={filter === 'done'} onClick={() => toggle('done')} />
      </div>

      <section className="mt-[8px]">
        <div className="mb-[10px] flex items-baseline gap-[10px]">
          <h2 className="text-[17px] font-semibold">{filter === 'all' ? 'Today' : `${STATUS_WORD[filter]} · ${shown.length}`}</h2>
          {filter !== 'all' && (
            <button type="button" className="text-[13px] text-sh-text-3 underline hover:text-sh-text" onClick={() => setFilter('all')}>
              All patients
            </button>
          )}
        </div>
        <ul aria-label="Today's video visits" className="flex flex-col gap-[10px]">
          {shown.map(({ r, st }) => {
            const p = patient(r.patientId)
            const act = ACTION[st]
            return (
              <li key={r.id} data-status={st}>
                <div className={cn('flex flex-wrap items-center gap-[16px] rounded-[20px] bg-sh-card px-[18px] py-[16px]', st === 'done' && 'opacity-80')}>
                  <span className="w-[56px] shrink-0 text-[16px] font-semibold tabular-nums">{formatTime(r.scheduledAt)}</span>
                  <Avatar initials={initials(p.name)} size={48} variant="pend" />
                  <div className="min-w-[180px] flex-1">
                    <p className="text-[16px] font-semibold">{p.name}</p>
                    <p className="text-[13px] text-sh-text-3">
                      {p.age} · {SEX[p.sex]} · {r.reason}
                    </p>
                  </div>
                  {!r.videoReady && st !== 'done' && (
                    <span className="inline-flex h-[28px] items-center gap-[6px] rounded-full bg-sh-inner px-[10px] text-[12px] font-medium text-sh-text-2" title="The patient’s video did not work in their test">
                      <Icon icon={Phone} size={12} />
                      Phone call only
                    </span>
                  )}
                  <span className={cn('inline-flex h-[28px] min-w-[96px] items-center justify-center rounded-full px-[12px] text-[13px] font-semibold', STATUS_CLASS[st])}>{STATUS_WORD[st]}</span>
                  <Pill
                    variant={act.variant}
                    size="lg"
                    icon={st === 'done' ? ArrowRight : Video}
                    className="min-w-[136px]"
                    onClick={() => open(r, st === 'lobby')}
                    aria-label={st === 'waiting' ? `Connect with ${p.name}` : st === 'lobby' ? `Connect: ${p.name} is waiting in the video call` : `${act.label} ${p.name}`}
                  >
                    {act.label}
                  </Pill>
                </div>
              </li>
            )
          })}
          {!shown.length && <li className="rounded-[20px] bg-sh-card px-[18px] py-[24px] text-center text-[14px] text-sh-text-3">No patients here right now.</li>}
        </ul>
        {rows.some((x) => !x.r.videoReady) && (
          <p className="mt-[10px] flex items-center gap-[6px] text-[13px] text-sh-text-3">
            <Icon icon={Phone} size={13} />
            “Phone call only” means the patient’s video did not work in their test. Call them by phone; some medicines cannot be prescribed on a phone call, and the
            prescription page checks this for you.
          </p>
        )}
      </section>

      {past.length > 0 && (
        <section className="mt-[8px]">
          <h2 className="mb-[10px] text-[17px] font-semibold">Finished visits</h2>
          <ul aria-label="Finished video visits" className="grid gap-[10px] md:grid-cols-2">
            {past.map((s) => {
              const p = patientByAnyId(s.patientId)
              if (!p) return null
              const mins = Math.max(1, Math.round(((s.endedAt ?? s.startedAt) - s.startedAt) / 60000))
              const st = statusOf(s.patientId)
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/tele/session/${s.encounterId ?? p.id}`)}
                    className="flex w-full items-center gap-[14px] rounded-[20px] bg-sh-card px-[16px] py-[14px] text-left transition-colors hover:bg-sh-hover"
                  >
                    <Avatar initials={initials(p.name)} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold">{p.name}</span>
                      <span className="flex flex-wrap items-center gap-x-[10px] text-[13px] text-sh-text-3">
                        <span className="inline-flex items-center gap-[4px]">
                          <Icon icon={Clock} size={12} />
                          {new Date(s.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} {clockOf(s.startedAt).slice(0, 5)} · {mins} min
                        </span>
                        {s.recordings?.some((r) => !r.removed) && (
                          <span className="inline-flex items-center gap-[4px]">
                            <Icon icon={Film} size={12} /> video
                          </span>
                        )}
                        {s.segments.length > 0 && (
                          <span className="inline-flex items-center gap-[4px]">
                            <Icon icon={MessagesSquare} size={12} /> {s.segments.length} lines
                          </span>
                        )}
                      </span>
                    </span>
                    {(st === 'done' || st === 'ended') && <span className={cn('rounded-full px-[10px] py-[3px] text-[12px] font-semibold', STATUS_CLASS[st])}>{STATUS_WORD[st]}</span>}
                    <Icon icon={ArrowRight} size={16} className="text-sh-text-3" />
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </ScreenFrame>
  )
}

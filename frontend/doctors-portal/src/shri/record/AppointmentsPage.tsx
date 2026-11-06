/**
 * S-06-17 · Appointments — `/patient/:id/appointments` (`src/screens/m06/
 * record/S0617.tsx`): when the patient is next due, what to prepare, and every
 * visit before. The next appointment is the whole top of the screen — date,
 * place, who with, what for, and what to bring — because that is what gets
 * read out to a patient at the end of a visit. Everything else is a quiet
 * list. From the live book (`logic/schedule.ts`): an appointment of the
 * doctor's own that is still to come can be moved or cancelled here (the same
 * dialogs as the calendar), and what was moved or cancelled stays visible,
 * with where it went or why.
 */

import { Ambulance, CalendarCheck, CalendarClock, CalendarX2, Check, Eye, FlaskConical, History, PhoneForwarded, Stethoscope, Syringe, Video, type LucideIcon } from 'lucide-react'
import { useParams } from 'react-router-dom'

import { formatDateLong, formatTime } from '@/data/format'
import type { Patient } from '@/data/kit'
import type { Appointment } from '@/data/record'
import { useCurrentStaff } from '@/store/session'

import { cn } from '../lib/cn'
import { appointmentsOf, canChange, isActive, nextOf, slotLabel, useAppointments, type ShriAppointment, type ShriStatus } from '../logic/schedule'
import { useShri } from '../state/store'
import type { Tone } from '../mocks/types'
import { EmptyState } from '../ui/EmptyState'
import { Card, Chip, CountBubble, Icon, Pill, PillTag } from '../ui/primitives'

import { RecordFrame } from './RecordFrame'

const STATUS_TONE: Record<ShriStatus, Tone> = { Today: 'pend', Booked: 'norm', Completed: 'neu', Missed: 'warn', Cancelled: 'warn', Moved: 'neu' }

const KIND_ICON: Record<Appointment['kind'], LucideIcon> = {
  'Follow-up': Stethoscope,
  Review: Eye,
  Procedure: Syringe,
  Investigation: FlaskConical,
  Teleconsult: Video,
  Transfer: Ambulance,
}

export function AppointmentsPage() {
  const { id } = useParams()
  return (
    <RecordFrame id={id} section="appointments">
      {(p) => <Appointments patient={p} />}
    </RecordFrame>
  )
}

/** Move · Cancel, for the doctor's own appointment still to come; "front office rebooking" once handed over. */
function Changes({ a }: { a: ShriAppointment }) {
  const me = useCurrentStaff()
  const open = useShri((s) => s.openScheduleDialog)
  if (a.rebooking)
    return (
      <PillTag tone="warn" size="sm" icon={PhoneForwarded}>
        Front office rebooking
      </PillTag>
    )
  if (!canChange(a, me.name)) return null
  return (
    <span className="flex flex-wrap gap-[6px]">
      <Pill variant="control" size="md" icon={CalendarClock} onClick={() => open({ kind: 'move', appointmentId: a.id })} aria-label={`Move: ${a.purpose}`}>
        Move
      </Pill>
      <Pill variant="control" size="md" icon={CalendarX2} onClick={() => open({ kind: 'cancel', appointmentId: a.id })} aria-label={`Cancel: ${a.purpose}`}>
        Cancel
      </Pill>
    </span>
  )
}

function Appointments({ patient: p }: { patient: Patient }) {
  const book = useAppointments()
  const all = appointmentsOf(book, p.id)
  const next = nextOf(book, p.id)
  const upcoming = all.filter((a) => a !== next && isActive(a))
  const past = all.filter((a) => a.status === 'Completed' || a.status === 'Missed').reverse()
  const changed = all.filter((a) => a.status === 'Cancelled' || a.status === 'Moved').reverse()

  return (
    <>
      {next ? (
        <Card titleSize="sm" title="Next appointment">
          <div className="flex flex-wrap items-start gap-[16px]">
            <span className="inline-flex size-[48px] shrink-0 items-center justify-center rounded-[14px] bg-sh-accent-soft text-sh-text" aria-hidden="true">
              <Icon icon={KIND_ICON[next.kind]} size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[20px]/[1.25] font-semibold tabular-nums tracking-[-0.015em] text-sh-text">
                {next.status === 'Today' ? 'Today' : formatDateLong(next.at)} · {formatTime(next.at)}
              </p>
              <p className="mt-[2px] text-[14px] font-medium text-sh-text">{next.purpose}</p>
              <p className="mt-[2px] text-[14px] text-sh-text-2">
                {next.clinic} · {next.with}
                {next.location ? ` · ${next.location}` : ''}
              </p>
            </div>
            <span className="flex flex-col items-end gap-[8px]">
              <Chip word={next.kind} tone={STATUS_TONE[next.status]} />
              <Changes a={next} />
            </span>
          </div>
          {next.prepare && next.prepare.length > 0 && (
            <div className="mt-[14px] rounded-[16px] bg-sh-inner px-[14px] py-[10px]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">Before this visit</p>
              <ul className="mt-[6px] flex flex-col gap-[4px]">
                {next.prepare.map((x) => (
                  <li key={x} className="flex items-start gap-[8px] text-[13px] text-sh-text-2">
                    <Icon icon={Check} size={13} className="mt-[3px] shrink-0 text-sh-norm-fg" />
                    {x}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      ) : (
        <Card titleSize="sm" title="Next appointment">
          <EmptyState icon={CalendarCheck} why={`Nothing is booked for ${p.name}. A follow-up booked at the end of a visit would appear here.`} />
        </Card>
      )}

      {upcoming.length > 0 && (
        <Card
          titleSize="sm"
          title={
            <span className="inline-flex items-center gap-[10px]">
              Also booked
              <CountBubble className="bg-sh-control">{upcoming.length}</CountBubble>
            </span>
          }
        >
          <ul className="flex flex-col">
            {upcoming.map((a, i) => (
              <AppointmentRow key={a.id} a={a} first={i === 0} book={book} />
            ))}
          </ul>
        </Card>
      )}

      {changed.length > 0 && (
        <Card
          titleSize="sm"
          title={
            <span className="inline-flex items-center gap-[10px]">
              Changed
              <CountBubble className="bg-sh-control">{changed.length}</CountBubble>
            </span>
          }
        >
          <ul className="flex flex-col">
            {changed.map((a, i) => (
              <AppointmentRow key={a.id} a={a} first={i === 0} book={book} />
            ))}
          </ul>
        </Card>
      )}

      <Card
        titleSize="sm"
        title={
          <span className="inline-flex items-center gap-[10px]">
            Earlier visits
            <CountBubble className="bg-sh-control">{past.length}</CountBubble>
          </span>
        }
      >
        {past.length === 0 ? (
          <EmptyState icon={History} why="No earlier visits are on this record — this is the first." />
        ) : (
          <ul className="flex flex-col">
            {past.map((a, i) => (
              <AppointmentRow key={a.id} a={a} first={i === 0} book={book} />
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}

function AppointmentRow({ a, first, book }: { a: ShriAppointment; first: boolean; book: ShriAppointment[] }) {
  const change = a.change
  const movedTo = change?.kind === 'moved' ? book.find((x) => x.id === change.to) : undefined
  return (
    <li className={cn('flex flex-wrap items-start gap-[12px] py-[12px]', first ? 'pt-0' : 'border-t border-sh-line')}>
      <span className="inline-flex size-[36px] shrink-0 items-center justify-center rounded-[12px] bg-sh-inner text-sh-text-2" aria-hidden="true">
        <Icon icon={KIND_ICON[a.kind]} size={16} />
      </span>
      <span className="min-w-0 flex-1 basis-[220px]">
        <span className="block text-[14px] font-medium text-sh-text">{a.purpose}</span>
        <span className="block text-[13px] text-sh-text-2">
          {a.clinic} · {a.with}
        </span>
        {a.prepare && a.prepare.length > 0 && <span className="block text-[12px] text-sh-text-3">Before: {a.prepare.join(' · ')}</span>}
        {change?.kind === 'cancelled' && <span className="block text-[12px] text-sh-text-3">Cancelled by {change.by} · {change.reason}</span>}
        {movedTo && <span className="block text-[12px] text-sh-text-3">Moved by {change!.by} to {slotLabel(movedTo.at)}</span>}
      </span>
      <span className="flex flex-col items-end gap-[4px]">
        <span className={cn('text-[13px] tabular-nums', isActive(a) ? 'font-semibold text-sh-text' : 'text-sh-text-3', !isActive(a) && a.status !== 'Completed' && 'line-through')}>
          {a.status === 'Today' ? 'Today' : formatDateLong(a.at)} · {formatTime(a.at)}
        </span>
        <Chip word={a.status} tone={STATUS_TONE[a.status]} />
        {isActive(a) && <Changes a={a} />}
      </span>
    </li>
  )
}

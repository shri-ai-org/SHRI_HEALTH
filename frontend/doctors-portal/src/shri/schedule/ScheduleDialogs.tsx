/**
 * The calendar's dialogs, one open at a time (`useShri.scheduleDialog`),
 * drawn by the shell so the calendar, the day detail, the record's
 * Appointments part and Blocks and leave all open the same ones:
 *
 *   • Block time — the doctor's own leave or a block of hours, on one day or
 *     several. Bookings it would displace are listed before anything is done
 *     (the old S-05-05 rule), each with a way out, default the first free
 *     slot of the same clinic: move it, hand it to the front office to rebook
 *     with the patient, or cancel it with a reason. The front office gets one
 *     message with the reason and what happens to each booking; each patient
 *     is told their appointment has changed, not why.
 *   • Move — the doctor's next free slots (same clinic first), or hand it to
 *     the front office.
 *   • Cancel — a reason is required and kept on the record.
 *   • Schedule — a patient into the doctor's own free time, opened only by
 *     tapping free time still to come on the Today panel's timeline, at the
 *     minute tapped: the patient, the visit and why — typed or dictated; a
 *     procedure or an operation with its place and length. Tapped in off
 *     hours, its start can be changed (an operation at 6 AM, before the
 *     timeline's 7). What it overlaps is said first; blocked time and time
 *     gone are never scheduled. The patient and the front office are told.
 *   • Off hours — tapped outside the working day: open extra hours there, or
 *     schedule there anyway.
 *   • Open extra hours / Close extra hours — time outside the working day the
 *     front office may book patients into (and is told), or the doctor's own;
 *     closing them leaves anyone already booked where they are.
 *
 * Free slots come from the doctor's own session templates, less what is
 * booked and what is blocked (`logic/schedule.ts`) — a lookup, not a guess.
 */

import { format } from 'date-fns'
import { Ban, CalendarClock, CalendarPlus, CalendarRange, CalendarX2, Check, ChevronRight, Clock, PhoneForwarded, Syringe, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { PATIENTS, patient } from '@/data/kit'
import { PROCEDURE_PLACES } from '@/data/places'
import type { Appointment } from '@/data/record'
import { useCurrentStaff } from '@/store/session'

import { cn } from '../lib/cn'
import { NOW, range12, time12 } from '../lib/clock'
import { affectedBy, dayIso, freeSlots, hoursLabel, openingSpan, rangeLabel, slotLabel, useAppointments, useScheduleActions, usualClinic, whenLabel, type Decision, type ShriAppointment, type Slot } from '../logic/schedule'
import { SCHEDULE_MIN, atMinute, dayModel, duration, durationSpoken, isActivity } from '../myday/dayModel'
import { useMyDay } from '../myday/useMyDay'
import { BLOCK_REASONS, useSchedule, type BlockReason } from '../state/schedule'
import { useShri } from '../state/store'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Dialog } from '../ui/Dialog'
import { Why } from '../ui/Disclosure'
import { CheckboxRow, Field, Select, TextArea, TextInput } from '../ui/forms'
import { Icon, Pill } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'
import { VoiceField } from '../ui/VoiceField'

const CANCEL_REASONS = ['Clinician unavailable', 'No longer needed', 'Patient asked to cancel', 'Booked in error', 'Other'] as const
/** Today on the demo clock — the same "now" every screen uses, never the machine's. */
const TODAY_ISO = dayIso(NOW)

export function ScheduleDialogs() {
  const dialog = useShri((s) => s.scheduleDialog)
  const close = useShri((s) => s.closeScheduleDialog)
  const book = useAppointments()
  if (!dialog) return null
  if (dialog.kind === 'block') return <BlockDialog from={dialog.from ?? useShri.getState().selectedDay} onClose={close} />
  if (dialog.kind === 'unblock') return <UnblockDialog blockId={dialog.blockId} onClose={close} />
  if (dialog.kind === 'schedule') return <NewAppointmentDialog date={dialog.date} at={dialog.at} until={dialog.until} offHours={dialog.offHours} onClose={close} />
  if (dialog.kind === 'offHours') return <OffHoursDialog date={dialog.date} at={dialog.at} from={dialog.from} to={dialog.to} onClose={close} />
  if (dialog.kind === 'openHours') return <OpenHoursDialog date={dialog.date} from={dialog.from} to={dialog.to} onClose={close} />
  if (dialog.kind === 'closeHours') return <CloseHoursDialog openingId={dialog.openingId} onClose={close} />
  const a = book.find((x) => x.id === dialog.appointmentId)
  if (!a) return null
  return dialog.kind === 'move' ? <MoveDialog appointment={a} onClose={close} /> : <CancelDialog appointment={a} onClose={close} />
}

/** A choice row — the whole row is the target, `role="radio"`. */
function Choice({ checked, onSelect, icon, title, sub }: { checked: boolean; onSelect: () => void; icon?: typeof Check; title: ReactNode; sub?: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'flex min-h-[48px] w-full items-center gap-[10px] rounded-[14px] px-[12px] py-[8px] text-left transition-colors duration-150',
        checked ? 'bg-sh-primary text-sh-on-primary' : 'bg-sh-inner text-sh-text hover:bg-sh-hover-strong',
      )}
    >
      {icon && <Icon icon={icon} size={16} />}
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium tabular-nums">{title}</span>
        {sub && <span className={cn('block text-[12px]', checked ? 'opacity-80' : 'text-sh-text-3')}>{sub}</span>}
      </span>
      {checked && <Icon icon={Check} size={16} />}
    </button>
  )
}

function who(a: ShriAppointment) {
  const p = patient(a.patientId)
  return `${p.name} · ${whenLabel(a.at)}`
}

/* ------------------------------------------------------------ Block time */

type Way = 'move' | 'rebook' | 'cancel'

function BlockDialog({ from: initial, onClose }: { from: string; onClose: () => void }) {
  const me = useCurrentStaff()
  const book = useAppointments()
  const blocks = useSchedule((s) => s.blocks)
  const openings = useSchedule((s) => s.openings)
  const actions = useScheduleActions()
  const start0 = initial < TODAY_ISO ? TODAY_ISO : initial
  const [from, setFrom] = useState(start0)
  const [to, setTo] = useState(start0)
  const [allDay, setAllDay] = useState(true)
  const [start, setStart] = useState('08:00')
  const [end, setEnd] = useState('12:00')
  const [reason, setReason] = useState<BlockReason>('Annual leave')
  const [note, setNote] = useState('')
  const [ways, setWays] = useState<Record<string, Way>>({})
  const [cancelWhy, setCancelWhy] = useState<Record<string, string>>({})

  const rangeOk = from !== '' && to !== '' && to >= from && (allDay || start < end)
  const input = { from, to: to < from ? from : to, allDay, start: allDay ? undefined : start, end: allDay ? undefined : end, reason, note: note.trim() || undefined }
  const affected = rangeOk ? affectedBy(book, input, me.name) : []

  /** Each displaced booking's first free slot of its own clinic — outside the new block, and not a slot already given to another of them. */
  const pending = [...blocks, { ...input, id: 'pending', by: me.name, at: '' }]
  const taken: Date[] = []
  const slots: Record<string, Slot | undefined> = {}
  for (const a of affected) {
    const s = freeSlots(book, pending, me.name, { hint: a.clinic, limit: 1, taken, openings })[0]
    slots[a.id] = s
    if (s) taken.push(s.at)
  }

  const wayOf = (a: ShriAppointment): Way => ways[a.id] ?? (slots[a.id] ? 'move' : 'rebook')
  const decisions = affected.map((a) => {
    const w = wayOf(a)
    const decision: Decision | null = w === 'move' ? (slots[a.id] ? { action: 'move', slot: slots[a.id]! } : null) : w === 'rebook' ? { action: 'rebook' } : cancelWhy[a.id] ? { action: 'cancel', reason: cancelWhy[a.id] } : null
    return { appointment: a, decision }
  })
  const ready = rangeOk && decisions.every((d) => d.decision !== null)
  const setAll = (w: Way) => setWays(Object.fromEntries(affected.map((a) => [a.id, w])))
  const allWay = affected.length > 0 && affected.every((a) => wayOf(a) === wayOf(affected[0])) ? wayOf(affected[0]) : undefined

  return (
    <Dialog
      open
      onClose={onClose}
      title="Block time"
      subtitle="Block time for leave or other commitments. The front office will be notified of the reason. Patients will only be told that their appointment has changed."
      icon={Ban}
      width={600}
      footer={
        <>
          <Pill variant="control" size="lg" icon={X} onClick={onClose}>
            Cancel
          </Pill>
          <Pill
            variant="primary"
            size="lg"
            icon={Check}
            disabled={!ready}
            onClick={() => {
              actions.block(input, decisions.map((d) => ({ appointment: d.appointment, decision: d.decision! })))
              onClose()
            }}
          >
            {affected.length > 0 ? `Block and notify ${affected.length + 1}` : 'Block and tell the front office'}
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[14px]">
        <div className="grid grid-cols-2 gap-[12px]">
          <Field label="From" required htmlFor="blk-from">
            <TextInput id="blk-from" type="date" min={TODAY_ISO} value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value) }} />
          </Field>
          <Field label="To" required htmlFor="blk-to" error={to < from ? 'The last day is before the first.' : undefined}>
            <TextInput id="blk-to" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <CheckboxRow checked={allDay} onChange={setAllDay}>
          All day
        </CheckboxRow>
        {!allDay && (
          <div className="grid grid-cols-2 gap-[12px]">
            <Field label="From time" required htmlFor="blk-start">
              <TextInput id="blk-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Until" required htmlFor="blk-end" error={start >= end ? 'The block ends before it starts.' : undefined}>
              <TextInput id="blk-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="Reason" required htmlFor="blk-reason" hint="Goes to the front office. Never to a patient.">
          <Select id="blk-reason" value={reason} onChange={(e) => setReason(e.target.value as BlockReason)}>
            {BLOCK_REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
        <Field label="Note for the front office" htmlFor="blk-note">
          <TextArea id="blk-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the rota owner should know…" className="min-h-[72px]" />
        </Field>

        {rangeOk && (
          <section aria-label="Bookings in this time" className="flex flex-col gap-[10px] rounded-[16px] bg-sh-inner p-[12px]">
            {affected.length === 0 ? (
              <p className="text-[13px] text-sh-text-2">Nobody is booked with you in this time, so blocking it moves no one.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-[8px]">
                  <p className="text-[13px] font-semibold text-sh-text">
                    {affected.length} booked with you — nothing is done to them until you confirm
                  </p>
                  <Segmented
                    label="For every booking"
                    value={allWay ?? ('' as Way)}
                    onChange={setAll}
                    options={[
                      { key: 'move', label: 'Move all' },
                      { key: 'rebook', label: 'Front office' },
                      { key: 'cancel', label: 'Cancel all' },
                    ]}
                  />
                </div>
                <ul className="flex flex-col gap-[10px]">
                  {affected.map((a) => {
                    const w = wayOf(a)
                    const slot = slots[a.id]
                    return (
                      <li key={a.id} className="rounded-[14px] bg-sh-card p-[10px]">
                        <p className="text-[14px] font-medium">{who(a)}</p>
                        <p className="text-[12px] text-sh-text-3">
                          {a.purpose} · {a.clinic}
                        </p>
                        <div role="radiogroup" aria-label={`What happens to ${patient(a.patientId).name}'s appointment`} className="mt-[8px] flex flex-col gap-[6px]">
                          <Choice
                            checked={w === 'move'}
                            onSelect={() => slot && setWays((x) => ({ ...x, [a.id]: 'move' }))}
                            icon={CalendarClock}
                            title={slot ? `Move to ${slotLabel(slot.at)}` : 'No free slot in the next six weeks'}
                            sub={slot ? `${slot.clinic} — your first free slot` : 'Hand it to the front office instead'}
                          />
                          <Choice checked={w === 'rebook'} onSelect={() => setWays((x) => ({ ...x, [a.id]: 'rebook' }))} icon={PhoneForwarded} title="Ask the front office to rebook" sub="They call the patient to agree a time" />
                          <Choice checked={w === 'cancel'} onSelect={() => setWays((x) => ({ ...x, [a.id]: 'cancel' }))} icon={CalendarX2} title="Cancel it" sub="A reason is kept on the record" />
                        </div>
                        {w === 'cancel' && (
                          <Field label="Why it is cancelled" required htmlFor={`blk-cancel-${a.id}`} className="mt-[8px]">
                            <Select id={`blk-cancel-${a.id}`} value={cancelWhy[a.id] ?? ''} onChange={(e) => setCancelWhy((x) => ({ ...x, [a.id]: e.target.value }))}>
                              <option value="">Choose a reason…</option>
                              {CANCEL_REASONS.map((r) => (
                                <option key={r}>{r}</option>
                              ))}
                            </Select>
                          </Field>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </section>
        )}
        <Why label="Who can block time, and what patients are told">
          <p>Blocking time does not cancel existing appointments. Before you confirm, you will see every patient booked in that time and choose what happens to each one. Patients are told that their appointment has moved, but not why.</p>
          <p>A block inside 14 days needs an administrator&rsquo;s override, because patients are already booked. Beyond 14 days it is yours to set.</p>
        </Why>
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------ Unblock */

function UnblockDialog({ blockId, onClose }: { blockId: string; onClose: () => void }) {
  const b = useSchedule((s) => s.blocks.find((x) => x.id === blockId))
  const actions = useScheduleActions()
  if (!b) return null
  return (
    <ConfirmDialog
      open
      title={`Unblock ${rangeLabel(b)}?`}
      consequence="This time will be available for booking again, and the front office will be notified. Appointments that were already moved, or sent to the front office for rebooking, will not change."
      confirmLabel="Unblock"
      onConfirm={() => {
        actions.unblock(b)
        onClose()
      }}
      onCancel={onClose}
    />
  )
}

/* ------------------------------------------------------------ Move */

function MoveDialog({ appointment: a, onClose }: { appointment: ShriAppointment; onClose: () => void }) {
  const me = useCurrentStaff()
  const book = useAppointments()
  const blocks = useSchedule((s) => s.blocks)
  const openings = useSchedule((s) => s.openings)
  const actions = useScheduleActions()
  const slots = useMemo(() => freeSlots(book, blocks, me.name, { hint: a.clinic, limit: 6, openings }), [book, blocks, openings, me.name, a.clinic])
  const [choice, setChoice] = useState<number | 'rebook'>(slots.length > 0 ? 0 : 'rebook')
  return (
    <Dialog
      open
      onClose={onClose}
      title="Move the appointment"
      subtitle={`${who(a)} · ${a.purpose}`}
      icon={CalendarClock}
      width={520}
      footer={
        <>
          <Pill variant="control" size="lg" icon={X} onClick={onClose}>
            Keep it
          </Pill>
          <Pill
            variant="primary"
            size="lg"
            icon={Check}
            onClick={() => {
              if (choice === 'rebook') actions.rebook(a)
              else actions.reschedule(a, slots[choice])
              onClose()
            }}
          >
            {choice === 'rebook' ? 'Send to the front office' : 'Move and notify'}
          </Pill>
        </>
      }
    >
      <div role="radiogroup" aria-label="Where the appointment goes" className="flex flex-col gap-[6px]">
        {slots.map((s, i) => (
          <Choice key={s.at.toISOString()} checked={choice === i} onSelect={() => setChoice(i)} title={slotLabel(s.at)} sub={`${s.clinic}${i === 0 ? ' — your first free slot' : ''}`} />
        ))}
        {slots.length === 0 && <p className="text-[13px] text-sh-text-2">No free slot in your sessions in the next six weeks.</p>}
        <Choice checked={choice === 'rebook'} onSelect={() => setChoice('rebook')} icon={PhoneForwarded} title="Ask the front office to rebook" sub="They call the patient to agree a time" />
      </div>
      <p className="mt-[12px] text-[12px] text-sh-text-3">The patient and the front office will be notified of the new time. Free slots come from your own sessions and extra hours, excluding times that are already booked or blocked.</p>
    </Dialog>
  )
}

/* ------------------------------------------------------------ Cancel */

function CancelDialog({ appointment: a, onClose }: { appointment: ShriAppointment; onClose: () => void }) {
  const actions = useScheduleActions()
  const [reason, setReason] = useState('')
  const [other, setOther] = useState('')
  const why = reason === 'Other' ? other.trim() : reason
  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      tone="warn"
      title="Cancel the appointment?"
      subtitle={`${who(a)} · ${a.purpose}`}
      icon={CalendarX2}
      width={500}
      footer={
        <>
          <Pill
            variant="control"
            size="lg"
            icon={PhoneForwarded}
            onClick={() => {
              actions.rebook(a)
              onClose()
            }}
          >
            Rebook instead
          </Pill>
          <Pill
            variant="crit"
            size="lg"
            icon={CalendarX2}
            disabled={why.length < 3}
            onClick={() => {
              actions.cancel(a, why)
              onClose()
            }}
          >
            Cancel the appointment
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[12px]">
        <Field label="Reason" required htmlFor="cx-reason" hint="This reason is saved on the record and sent to the front office. The patient will only be told that the appointment is cancelled.">
          <Select id="cx-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose a reason…</option>
            {CANCEL_REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
        {reason === 'Other' && (
          <Field label="The reason" required htmlFor="cx-other">
            <TextInput id="cx-other" value={other} onChange={(e) => setOther(e.target.value)} />
          </Field>
        )}
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------ Schedule */

const VISITS: { kind: Appointment['kind']; label: string }[] = [
  { kind: 'Follow-up', label: 'Follow-up' },
  { kind: 'Review', label: 'Review' },
  { kind: 'Teleconsult', label: 'Teleconsult' },
  { kind: 'Procedure', label: 'Procedure / surgery' },
]
/** How long a procedure or an operation is booked for. */
const LENGTHS = [30, 60, 90, 120, 180, 240]
const dateOfIso = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const minutesOfHhmm = (v: string) => {
  const [h, m] = v.split(':').map(Number)
  return h * 60 + m
}
const nowMinute = () => NOW.getHours() * 60 + NOW.getMinutes()
/** "A", "A and B", "A, B and C". */
const listed = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/**
 * At the minute tapped on the Today panel's timeline. In free time it is never asked again, and a visit
 * is half an hour or until the free time ends; in off hours the start can be changed. A procedure or an
 * operation takes its place and its length.
 */
function NewAppointmentDialog({ date, at, until, offHours = false, onClose }: { date: string; at: number; until: number; offHours?: boolean; onClose: () => void }) {
  const me = useCurrentStaff()
  const book = useAppointments()
  const actions = useScheduleActions()
  const { dayInfo } = useMyDay()
  const day = dayInfo(dateOfIso(date))
  const model = dayModel(day)
  const [start, setStart] = useState(at)
  const [patientId, setPatientId] = useState('')
  const [kind, setKind] = useState<Appointment['kind']>('Follow-up')
  const [place, setPlace] = useState<string>(PROCEDURE_PLACES[0])
  const [length, setLength] = useState(60)
  const [purpose, setPurpose] = useState('')
  const people = useMemo(() => [...PATIENTS].filter((p) => p.name).sort((x, y) => x.name.localeCompare(y.name)), [])

  const procedure = kind === 'Procedure'
  const end = procedure ? start + length : offHours ? start + SCHEDULE_MIN : Math.min(start + SCHEDULE_MIN, until)
  const valid = Number.isFinite(start) && end > start && end <= 24 * 60
  // Never time gone, never the doctor's own blocked time; what it overlaps is said, and theirs to decide.
  const gone = (!day.isToday && day.date < NOW) || (model.now !== null && start < model.now)
  const blockedBy = model.items.find((i) => i.kind === 'blocked' && i.start < end && start < i.end)
  const clashes = model.items.filter((i) => isActivity(i.kind) && i.start < end && start < i.end)
  const ready = valid && !gone && !blockedBy && patientId !== '' && purpose.trim() !== ''
  const clinic = kind === 'Teleconsult' ? 'Teleconsult' : procedure ? place : usualClinic(book, me.name)

  return (
    <Dialog
      open
      onClose={onClose}
      title="Schedule an appointment"
      subtitle="The patient and the front office will be notified."
      icon={CalendarPlus}
      width={560}
      footer={
        <>
          <Pill variant="control" size="lg" icon={X} onClick={onClose}>
            Cancel
          </Pill>
          <Pill
            variant="primary"
            size="lg"
            icon={Check}
            disabled={!ready}
            onClick={() => {
              actions.schedule({
                patientId,
                at: atMinute(day.date, start),
                minutes: end - start,
                kind,
                clinic,
                location: procedure ? place : undefined,
                purpose: purpose.trim(),
                offHours,
              })
              onClose()
            }}
          >
            Schedule appointment
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[14px]">
        {offHours && (
          <p className="flex items-start gap-[10px] rounded-[14px] bg-sh-warn-bg px-[14px] py-[10px] text-[13px] text-sh-warn-fg">
            <Icon icon={Clock} size={16} className="mt-[1px] shrink-0" />
            This time is outside your working hours. Only this appointment will be added, and the front office will be notified.
          </p>
        )}
        <div className={cn('flex items-center gap-[12px] rounded-[14px] px-[14px] py-[12px]', gone || blockedBy || !valid ? 'bg-sh-crit-bg' : 'bg-sh-inner')}>
          <Icon icon={CalendarClock} size={18} className={gone || blockedBy || !valid ? 'text-sh-crit-fg' : 'text-sh-text-2'} />
          <p className="min-w-0 flex-1">
            <span id="sch-when" className="block text-[15px] font-semibold tabular-nums text-sh-text">
              {format(day.date, 'EEEE d MMMM')}
              {valid ? ` · ${range12(start, end)}` : ''}
            </span>
            <span className={cn('block text-[12px]', gone || blockedBy || !valid ? 'text-sh-crit-fg' : 'text-sh-text-3')}>
              {!valid
                ? 'The appointment must end before midnight. Please choose an earlier start time.'
                : gone
                  ? 'This time has already passed. Please choose a later time.'
                  : blockedBy
                    ? `This time is blocked (${blockedBy.title.replace(/^Blocked · /, '')}). Please unblock it first or choose another time.`
                    : `${durationSpoken(end - start)}${offHours ? '' : ', starting at the time you selected on the timeline'}`}
            </span>
          </p>
        </div>
        {offHours && (
          <Field label="Starts at" required htmlFor="sch-start" hint="You can choose any start time, including before 7 AM for an early operation.">
            <TextInput id="sch-start" type="time" step={300} value={hhmm(start)} onChange={(e) => setStart(e.target.value ? minutesOfHhmm(e.target.value) : NaN)} />
          </Field>
        )}
        {clashes.length > 0 && valid && (
          <p className="flex items-start gap-[10px] rounded-[14px] bg-sh-warn-bg px-[14px] py-[10px] text-[13px] text-sh-warn-fg" role="status">
            <Icon icon={TriangleAlert} size={16} className="mt-[1px] shrink-0" />
            <span>This overlaps with {listed(clashes.map((c) => `${c.title} at ${time12(c.start)}`))}. You can still schedule it.</span>
          </p>
        )}
        <Field label="Patient" required htmlFor="sch-patient">
          <Select id="sch-patient" value={patientId} onChange={(e) => setPatientId(e.target.value)}>
            <option value="">Choose a patient…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.age}/{p.sex} · {p.uhid}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Visit"
          required
          htmlFor="sch-kind"
          hint={procedure ? 'The selected room will be reserved for you for the full length.' : kind === 'Teleconsult' ? 'This will be a video or phone call in Telehealth.' : `This will be an in-person visit at ${usualClinic(book, me.name)}.`}
        >
          <Select id="sch-kind" value={kind} onChange={(e) => setKind(e.target.value as Appointment['kind'])}>
            {VISITS.map((v) => (
              <option key={v.kind} value={v.kind}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        {procedure && (
          <div className="grid grid-cols-2 gap-[12px]">
            <Field label="Place" required htmlFor="sch-place">
              <Select id="sch-place" value={place} onChange={(e) => setPlace(e.target.value)}>
                {PROCEDURE_PLACES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
            </Field>
            <Field label="Length" required htmlFor="sch-length">
              <Select id="sch-length" value={length} onChange={(e) => setLength(Number(e.target.value))}>
                {LENGTHS.map((m) => (
                  <option key={m} value={m}>
                    {duration(m)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <VoiceField
          id="sch-purpose"
          label="Reason"
          required
          rows={2}
          tidy={false}
          value={purpose}
          onChange={setPurpose}
          placeholder={procedure ? 'Type or dictate the reason, e.g. Laparoscopic cholecystectomy' : 'Type or dictate the reason, e.g. Thyroid review with results'}
          typedPlaceholder={procedure ? 'e.g. Laparoscopic cholecystectomy' : 'e.g. Thyroid review with results'}
          hint="The patient will see this reason with their appointment."
        />
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------ Off hours */

function ActionChoice({ icon, title, sub, onClick }: { icon: LucideIcon; title: string; sub: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[64px] w-full items-center gap-[12px] rounded-[14px] bg-sh-inner px-[14px] py-[10px] text-left transition-colors duration-150 hover:bg-sh-hover-strong"
    >
      <span className="flex size-[40px] shrink-0 items-center justify-center rounded-[12px] bg-sh-card text-sh-text">
        <Icon icon={icon} size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-sh-text">{title}</span>
        <span className="block text-[13px] text-sh-text-2">{sub}</span>
      </span>
      <Icon icon={ChevronRight} size={16} className="shrink-0 text-sh-chev" />
    </button>
  )
}

/** Off hours tapped: open extra hours there — from now, if they have begun — or schedule there anyway. */
function OffHoursDialog({ date, at, from, to, onClose }: { date: string; at: number; from: number; to: number; onClose: () => void }) {
  const open = useShri((s) => s.openScheduleDialog)
  const openFrom = date === TODAY_ISO ? Math.max(from, Math.ceil(nowMinute() / 5) * 5) : from
  return (
    <Dialog
      open
      onClose={onClose}
      title="Outside your working hours"
      subtitle={`${format(dateOfIso(date), 'EEEE d MMMM')} · ${time12(at)}`}
      icon={Clock}
      width={540}
      footer={
        <Pill variant="control" size="lg" icon={X} onClick={onClose}>
          Cancel
        </Pill>
      }
    >
      <div className="flex flex-col gap-[10px]">
        <ActionChoice
          icon={CalendarRange}
          title="Open extra hours"
          sub={`Make ${range12(openFrom, to)} available so the front office can book patients. They will be notified.`}
          onClick={() => open({ kind: 'openHours', date, from: openFrom, to })}
        />
        <ActionChoice
          icon={Syringe}
          title="Schedule a patient or procedure"
          sub={`Add a single appointment starting at ${time12(at)}, such as an early operation or a late review.`}
          onClick={() => open({ kind: 'schedule', date, at, until: to, offHours: true })}
        />
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------ Extra hours */

function OpenHoursDialog({ date: initial, from, to, onClose }: { date?: string; from?: number; to?: number; onClose: () => void }) {
  const actions = useScheduleActions()
  const openings = useSchedule((s) => s.openings)
  const [date, setDate] = useState(initial && initial >= TODAY_ISO ? initial : TODAY_ISO)
  const [start, setStart] = useState(hhmm(from ?? 17 * 60))
  const [end, setEnd] = useState(hhmm(to ?? 19 * 60))
  const [frontOffice, setFrontOffice] = useState(true)
  const [note, setNote] = useState('')
  const [a, b] = [minutesOfHhmm(start), minutesOfHhmm(end)]
  const inOrder = Number.isFinite(a) && Number.isFinite(b) && b > a
  const gone = date < TODAY_ISO || (date === TODAY_ISO && b <= nowMinute())
  const already = openings.find((o) => o.date === date && openingSpan(o)[0] < b && a < openingSpan(o)[1])
  const ready = date !== '' && inOrder && !gone && !already

  return (
    <Dialog
      open
      onClose={onClose}
      title="Open extra hours"
      subtitle="Make time outside your usual working hours available for appointments."
      icon={CalendarRange}
      width={540}
      footer={
        <>
          <Pill variant="control" size="lg" icon={X} onClick={onClose}>
            Cancel
          </Pill>
          <Pill
            variant="primary"
            size="lg"
            icon={Check}
            disabled={!ready}
            onClick={() => {
              actions.openHours({ date, start, end, frontOffice, note: note.trim() || undefined })
              onClose()
            }}
          >
            Open extra hours
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[14px]">
        <Field label="Date" required htmlFor="oh-date">
          <TextInput id="oh-date" type="date" min={TODAY_ISO} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-[12px]">
          <Field label="From" required htmlFor="oh-start">
            <TextInput id="oh-start" type="time" step={300} value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Until" required htmlFor="oh-end" error={!inOrder && start && end ? 'Until is before From.' : undefined}>
            <TextInput id="oh-end" type="time" step={300} value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        {inOrder && (
          <p id="oh-when" className={cn('rounded-[14px] px-[14px] py-[10px] text-[14px] font-semibold tabular-nums', gone || already ? 'bg-sh-crit-bg text-sh-crit-fg' : 'bg-sh-inner text-sh-text')}>
            {hoursLabel({ date, start, end })}
            {gone && <span className="block text-[12px] font-normal">These hours have already passed.</span>}
            {already && <span className="block text-[12px] font-normal">You have already opened extra hours at {hoursLabel(already)}.</span>}
          </p>
        )}
        <CheckboxRow checked={frontOffice} onChange={setFrontOffice}>
          Allow the front office to book patients into these hours (they will be notified)
        </CheckboxRow>
        <Field label="Note for the front office" htmlFor="oh-note">
          <TextArea id="oh-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Follow-ups only, no new patients" className="min-h-[72px]" />
        </Field>
      </div>
    </Dialog>
  )
}

function CloseHoursDialog({ openingId, onClose }: { openingId: string; onClose: () => void }) {
  const o = useSchedule((s) => s.openings.find((x) => x.id === openingId))
  const actions = useScheduleActions()
  if (!o) return null
  return (
    <ConfirmDialog
      open
      title={`Close extra hours ${hoursLabel(o)}?`}
      consequence={
        o.frontOffice
          ? 'The front office will be notified that these hours are no longer available. Patients who are already booked will keep their appointments.'
          : 'Patients who are already booked will keep their appointments.'
      }
      confirmLabel="Close extra hours"
      onConfirm={() => {
        actions.closeHours(o)
        onClose()
      }}
      onCancel={onClose}
    />
  )
}

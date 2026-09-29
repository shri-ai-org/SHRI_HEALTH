/**
 * The calendar's three dialogs, one open at a time (`useShri.scheduleDialog`),
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
 *
 * Free slots come from the doctor's own session templates, less what is
 * booked and what is blocked (`logic/schedule.ts`) — a lookup, not a guess.
 */

import { Ban, CalendarClock, CalendarX2, Check, PhoneForwarded, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { patient } from '@/data/kit'
import { useCurrentStaff } from '@/store/session'

import { cn } from '../lib/cn'
import { NOW } from '../lib/clock'
import { affectedBy, dayIso, freeSlots, rangeLabel, slotLabel, useAppointments, useScheduleActions, whenLabel, type Decision, type ShriAppointment, type Slot } from '../logic/schedule'
import { BLOCK_REASONS, useSchedule, type BlockReason } from '../state/schedule'
import { useShri } from '../state/store'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Dialog } from '../ui/Dialog'
import { Why } from '../ui/Disclosure'
import { CheckboxRow, Field, Select, TextArea, TextInput } from '../ui/forms'
import { Icon, Pill } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'

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
    const s = freeSlots(book, pending, me.name, { hint: a.clinic, limit: 1, taken })[0]
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
      subtitle="Your own leave or a block of hours. The front office is told, with the reason; patients are told only that their appointment has changed."
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
        <Why label="Who may block, and what the patients are told">
          <p>Blocking time does not cancel the patients already booked into it. They are listed before you confirm, not after, and each one goes where you choose — they are told the appointment has moved, not why.</p>
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
      consequence="The time becomes bookable again and the front office is told. Appointments already moved, or handed to the front office to rebook, stay as they are."
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
  const actions = useScheduleActions()
  const slots = useMemo(() => freeSlots(book, blocks, me.name, { hint: a.clinic, limit: 6 }), [book, blocks, me.name, a.clinic])
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
      <p className="mt-[12px] text-[12px] text-sh-text-3">The patient and the front office are told the new time. Free slots are your own sessions, less what is booked and what you have blocked.</p>
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
        <Field label="Reason" required htmlFor="cx-reason" hint="Kept on the record and sent to the front office. The patient is told it is cancelled.">
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

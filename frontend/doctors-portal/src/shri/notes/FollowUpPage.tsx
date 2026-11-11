/**
 * S-06-19 — Follow-up request (demo step 10, D98). The doctor asks for a revisit at the end of
 * the visit: when (a number of days, weeks or months from the visit's date, in the facility's
 * time zone), and optionally what kind of visit, with whom, and a note for the desk. The front
 * desk books it at check-out, or records that the patient declined; the doctor never changes the
 * calendar (D67). While the request is open, the doctor who asked can change or withdraw it.
 *
 * Real API only (shri-health/followUp.ts): the route's `:id` is the encounter's ID. A 412 means
 * someone changed the visit since it was read: the screen reads it again and says so.
 */
import { CalendarClock, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

import {
  FollowUpRefusal,
  intervalLabel,
  loadChoices,
  loadFollowUp,
  saveFollowUp,
  withdrawFollowUp,
  type FollowUpChoices,
  type FollowUpForm,
  type FollowUpState,
  type Unit,
} from '../../../shri-health/followUp'
import { ScreenFrame } from '../app/ScreenFrame'

const UNITS: Unit[] = ['day', 'week', 'month']
const LIMITS: Record<Unit, number> = { day: 365, week: 104, month: 24 }
const STATUS_TEXT: Record<string, string> = {
  open: 'Asked for: the front desk books it at check-out.',
  booked: 'Booked by the front desk.',
  declined: 'The patient declined to book it.',
  withdrawn: 'Withdrawn.',
}

function emptyForm(): FollowUpForm {
  return { value: 2, unit: 'week', appointmentTypeId: '', providerId: '', note: '' }
}

function formOf(state: FollowUpState): FollowUpForm {
  const f = state.followUp
  if (!f || f.status !== 'open') return emptyForm()
  return {
    value: f.interval.value,
    unit: f.interval.unit,
    appointmentTypeId: f.appointmentTypeId ?? '',
    providerId: f.providerId ?? '',
    note: f.note ?? '',
  }
}

export function FollowUpPage() {
  const { id = '' } = useParams()
  const [state, setState] = useState<FollowUpState | null>(null)
  const [choices, setChoices] = useState<FollowUpChoices>({ types: [], providers: [] })
  const [form, setForm] = useState<FollowUpForm>(emptyForm())
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<FollowUpRefusal | null>(null)

  const read = useCallback(async () => {
    const fresh = await loadFollowUp(id)
    setState(fresh)
    setForm(formOf(fresh))
    return fresh
  }, [id])

  useEffect(() => {
    let live = true
    Promise.all([read(), loadChoices().catch(() => ({ types: [], providers: [] }))])
      .then(([, c]) => live && setChoices(c))
      .catch((e: unknown) => live && setError(e as FollowUpRefusal))
    return () => {
      live = false
    }
  }, [read])

  async function act(run: () => Promise<FollowUpState>, done: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const next = await run()
      setState(next)
      setForm(formOf(next))
      setReason('')
      setNotice(done)
    } catch (e) {
      const refused = e as FollowUpRefusal
      if (refused.status === 412) {
        await read().catch(() => undefined)
        setNotice('Someone changed this visit since you opened it. This is the current request; check it and try again.')
      } else {
        setError(refused)
      }
    } finally {
      setBusy(false)
    }
  }

  const open = state?.followUp?.status === 'open'
  const valid = Number.isInteger(form.value) && form.value >= 1 && form.value <= LIMITS[form.unit]

  if (error && !state) {
    return (
      <ScreenFrame screenId="S-06-19" heading="Follow-up request">
        <p role="alert" className="text-sm text-danger">{error.message}</p>
      </ScreenFrame>
    )
  }
  if (!state) {
    return (
      <ScreenFrame screenId="S-06-19" heading="Follow-up request">
        <p className="text-sm text-ink-subtle">Loading the visit…</p>
      </ScreenFrame>
    )
  }

  const current = state.followUp
  return (
    <ScreenFrame screenId="S-06-19" heading="Follow-up request"
                 sub="Ask the front desk to book a revisit. They book it at check-out.">
      <section aria-labelledby="fu-current" className="mb-6">
        <h2 id="fu-current" className="text-sm font-semibold">This visit's request</h2>
        {current ? (
          <p data-testid="fu-status" className="text-sm">
            {intervalLabel(current.interval.value, current.interval.unit)} —{' '}
            {STATUS_TEXT[current.status] ?? current.status}
          </p>
        ) : (
          <p data-testid="fu-status" className="text-sm text-ink-subtle">No revisit asked for yet.</p>
        )}
      </section>

      {(!current || open) && (
        <form
          aria-label="Follow-up"
          className="grid max-w-xl gap-3"
          onSubmit={(ev) => {
            ev.preventDefault()
            if (!valid || busy) return
            void act(() => saveFollowUp(state, form), 'Follow-up saved: the front desk will see it at check-out.')
          }}
        >
          <fieldset className="flex items-end gap-2">
            <legend className="text-sm font-medium">See the patient again in</legend>
            <label className="grid text-sm">
              <span className="sr-only">Number</span>
              <input type="number" min={1} max={LIMITS[form.unit]} required value={form.value}
                     aria-invalid={!valid}
                     onChange={(ev) => setForm({ ...form, value: Number(ev.target.value) })}
                     className="w-24 rounded border px-2 py-1" />
            </label>
            <label className="grid text-sm">
              <span className="sr-only">Unit</span>
              <select value={form.unit} onChange={(ev) => setForm({ ...form, unit: ev.target.value as Unit })}
                      className="rounded border px-2 py-1">
                {UNITS.map((u) => <option key={u} value={u}>{u}s</option>)}
              </select>
            </label>
          </fieldset>
          <label className="grid text-sm">
            Kind of visit (optional)
            <select value={form.appointmentTypeId}
                    onChange={(ev) => setForm({ ...form, appointmentTypeId: ev.target.value })}
                    className="rounded border px-2 py-1">
              <option value="">Any</option>
              {choices.types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          <label className="grid text-sm">
            With (optional)
            <select value={form.providerId}
                    onChange={(ev) => setForm({ ...form, providerId: ev.target.value })}
                    className="rounded border px-2 py-1">
              <option value="">Any provider</option>
              {choices.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className="grid text-sm">
            Note for the front desk (optional)
            <textarea maxLength={500} value={form.note}
                      onChange={(ev) => setForm({ ...form, note: ev.target.value })}
                      className="rounded border px-2 py-1" rows={2} />
          </label>
          <button type="submit" disabled={!valid || busy}
                  className="inline-flex w-fit items-center gap-2 rounded bg-brand px-3 py-1.5 text-sm text-white disabled:opacity-50">
            <CalendarClock size={16} aria-hidden /> {open ? 'Change the follow-up' : 'Ask for a follow-up'}
          </button>
        </form>
      )}

      {open && (
        <form
          aria-label="Withdraw"
          className="mt-6 grid max-w-xl gap-2"
          onSubmit={(ev) => {
            ev.preventDefault()
            if (!reason.trim() || busy) return
            void act(() => withdrawFollowUp(state, reason), 'Follow-up withdrawn.')
          }}
        >
          <label className="grid text-sm">
            Reason for withdrawing
            <input required maxLength={500} value={reason} onChange={(ev) => setReason(ev.target.value)}
                   className="rounded border px-2 py-1" />
          </label>
          <button type="submit" disabled={!reason.trim() || busy}
                  className="inline-flex w-fit items-center gap-2 rounded border px-3 py-1.5 text-sm disabled:opacity-50">
            <Undo2 size={16} aria-hidden /> Withdraw
          </button>
        </form>
      )}

      {notice && <p role="status" data-testid="fu-notice" className="mt-4 text-sm">{notice}</p>}
      {error && <p role="alert" className="mt-4 text-sm text-danger">{error.message}</p>}
    </ScreenFrame>
  )
}

export default FollowUpPage

import { useEffect, useId, useState } from 'react'
import { ApiError } from '../../api/client'
import { listSlots } from '../../api/generated/endpoints/scheduling/scheduling'
import type { Slot } from '../../api/generated/model'
import { Alert, DateInput, Field, formatTime, ProblemAlert, Select, Spinner, type Problem } from '../../design-system'
import { allPages, useBookableProviders, type BookingReference } from './reference'

export interface SlotChoice {
  facilityId: string
  appointmentTypeId: string
  /** '' means any provider at the facility. */
  providerId: string
  /** `YYYY-MM-DD` in the facility's time zone, `null` when typed but not a real date, `''` when empty. */
  date: string | null
  slot: Slot | null
}

export const EMPTY_CHOICE: SlotChoice = { facilityId: '', appointmentTypeId: '', providerId: '', date: '', slot: null }

export type SlotErrors = Partial<Record<keyof SlotChoice, string | undefined>>

export function validateChoice(c: SlotChoice): SlotErrors {
  const errors: SlotErrors = {}
  if (!c.facilityId) errors.facilityId = 'Choose the facility.'
  if (!c.appointmentTypeId) errors.appointmentTypeId = 'Choose the appointment type.'
  if (!c.date) errors.date = 'Enter the date as MM/DD/YYYY.'
  if (!c.slot) errors.slot = 'Choose a time.'
  return errors
}

/**
 * Facility, appointment type, provider, date and a free time (`GET /slots`), from the booking lists
 * (D49). Changing anything clears the chosen time, so a booking never uses a stale slot.
 */
export function SlotFields({
  reference,
  value,
  onChange,
  errors,
  refreshKey = 0,
  current,
}: {
  reference: BookingReference
  value: SlotChoice
  onChange: (next: SlotChoice) => void
  errors: SlotErrors
  /** Bump to read the free times again, e.g. after a `409 booking-conflict`. */
  refreshKey?: number
  /** When rescheduling: the appointment's own time, shown as current and not offered. */
  current?: { startAt: string; providerId: string }
}) {
  const groupId = useId()
  const providers = useBookableProviders(value.facilityId)
  const facility = reference.facilities?.find((f) => f.id === value.facilityId)
  const [slots, setSlots] = useState<{ key: string; items: Slot[]; problem: Problem | null } | null>(null)

  const ready = Boolean(value.facilityId && value.appointmentTypeId && value.date)
  const key = `${value.facilityId}|${value.appointmentTypeId}|${value.providerId}|${value.date}|${refreshKey}`
  useEffect(() => {
    if (!ready || !value.date) return
    let current = true
    const date = value.date
    allPages(async (cursor) => {
      const res = await listSlots({
        date,
        facilityId: value.facilityId,
        appointmentTypeId: value.appointmentTypeId,
        ...(value.providerId ? { providerId: value.providerId } : {}),
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })
      return res.status === 200 ? res.data : null
    })
      .then((items) => {
        if (current) setSlots({ key, items, problem: null })
      })
      .catch((error: unknown) => {
        if (!current) return
        if (error instanceof ApiError) setSlots({ key, items: [], problem: error.problem })
        else throw error
      })
    return () => {
      current = false
    }
  }, [ready, key, value.date, value.facilityId, value.appointmentTypeId, value.providerId])

  const shown = slots?.key === key ? slots : null
  const change = (changes: Partial<SlotChoice>) => onChange({ ...value, ...changes, slot: null })
  const providerName = (id: string) => providers?.find((p) => p.id === id)?.displayName ?? ''

  if (reference.problem) return <ProblemAlert problem={reference.problem} />
  if (!reference.facilities || !reference.types) return <Spinner label="Loading booking lists" />

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Facility" required error={errors.facilityId}>
          {(p) => (
            <Select {...p} value={value.facilityId} onChange={(e) => change({ facilityId: e.target.value, providerId: '' })}>
              <option value="">Choose…</option>
              {reference.facilities!.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Appointment type" required error={errors.appointmentTypeId}>
          {(p) => (
            <Select {...p} value={value.appointmentTypeId} onChange={(e) => change({ appointmentTypeId: e.target.value })}>
              <option value="">Choose…</option>
              {reference.types!.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.defaultDurationMinutes} min)
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Provider" error={errors.providerId}>
          {(p) => (
            <Select {...p} value={value.providerId} onChange={(e) => change({ providerId: e.target.value })} disabled={!value.facilityId}>
              <option value="">Any provider</option>
              {(providers ?? []).map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Date" hint={facility ? `MM/DD/YYYY, ${facility.name} time` : 'MM/DD/YYYY'} required error={errors.date}>
          {(p) => <DateInput {...p} value={value.date ?? ''} onValueChange={(v) => change({ date: v })} />}
        </Field>
      </div>

      {ready ? (
        !shown ? (
          <Spinner label="Finding free times" />
        ) : shown.problem ? (
          <ProblemAlert problem={shown.problem} />
        ) : shown.items.length === 0 ? (
          <Alert tone="info" title="No free times that day">
            Try another date or provider.
          </Alert>
        ) : (
          <fieldset aria-describedby={errors.slot ? `${groupId}-error` : undefined}>
            <legend className="mb-2 text-sm font-semibold text-ink">
              Time <span className="text-ink-muted">(required)</span>
            </legend>
            <div className="grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2">
              {shown.items.map((s) => {
                const id = `${s.startAt}|${s.providerId}`
                const checked = value.slot?.startAt === s.startAt && value.slot.providerId === s.providerId
                const isCurrent = current !== undefined && Date.parse(current.startAt) === Date.parse(s.startAt) && current.providerId === s.providerId
                return (
                  <label key={id} className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-primary-600 has-[:checked]:bg-primary-50">
                    <input type="radio" name={groupId} checked={checked} disabled={isCurrent} onChange={() => onChange({ ...value, slot: s })} />
                    <span className="tabular-nums">{formatTime(s.startAt, facility?.timeZone ?? null, { withZone: false })}</span>
                    <span className="text-ink-muted">{providerName(s.providerId)}</span>
                    {s.overbook ? <span className="text-xs text-warning-fg">overbook</span> : null}
                    {isCurrent ? <span className="text-xs text-ink-muted">(current time)</span> : null}
                  </label>
                )
              })}
            </div>
            {errors.slot ? (
              <p id={`${groupId}-error`} className="mt-1 text-sm text-critical-fg">
                {errors.slot}
              </p>
            ) : null}
          </fieldset>
        )
      ) : errors.slot ? (
        <p className="text-sm text-critical-fg">{errors.slot}</p>
      ) : null}
    </div>
  )
}

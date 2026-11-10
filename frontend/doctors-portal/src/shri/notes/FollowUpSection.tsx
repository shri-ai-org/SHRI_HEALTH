/**
 * The Follow-up section, copied from the discharge flow (`../discharge/DischargeFlow.tsx`,
 * "Follow-up") for the outpatient visit, on the patient instructions page (Minalini's
 * exception of 2026-11-04 for the follow-up request). The section, its two choices, the note
 * for the front office and the reason when none is needed are the discharge flow's; the booked
 * fields follow the contract's follow-up request (interval, appointment type, provider) instead
 * of a date and a clinic, and an open request can be withdrawn with a reason.
 * Data: `shri-health/followup.ts` (the request on the encounter, #161).
 */

import { AlertTriangle, Check, Undo2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { cn } from '../lib/cn'
import { Alert } from '../ui/Alert'
import { Field, Select, TextInput } from '../ui/forms'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import {
  INTERVAL_UNITS,
  followUpError,
  followUpRequestFor,
  loadFollowUp,
  loadFollowUpOptions,
  saveFollowUp,
  withdrawFollowUp,
  type FollowUpDraft,
  type MockRequest,
  type Option,
} from '../../../shri-health/followup'

export function FollowUpSection({ encounterId, locked }: { encounterId: string; locked?: boolean }) {
  const [request, setRequest] = useState<MockRequest | undefined>(() => followUpRequestFor(encounterId))
  const [draft, setDraft] = useState<FollowUpDraft>(() => (request?.status === 'open' ? request : {}))
  const [editing, setEditing] = useState(() => request?.status !== 'open')
  const [options, setOptions] = useState<{ types: Option[]; providers: Option[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawReason, setWithdrawReason] = useState('')
  const [withdrawTried, setWithdrawTried] = useState(false)

  // The request the server already has for this visit (it may have been set in another tab).
  useEffect(() => {
    let live = true
    loadFollowUp(encounterId)
      .then((saved) => {
        if (!live || !saved) return
        setRequest(saved)
        if (saved.status === 'open') {
          setDraft(saved)
          setEditing(false)
        }
      })
      .catch((error: unknown) => live && setLoadError(followUpError(error)))
    return () => {
      live = false
    }
  }, [encounterId])

  useEffect(() => {
    let live = true
    loadFollowUpOptions()
      .then((o) => live && setOptions(o))
      .catch((error: unknown) => live && setLoadError(followUpError(error)))
    return () => {
      live = false
    }
  }, [])

  const set = (patch: Partial<FollowUpDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setSaveError(null)
  }

  // The discharge flow's rules, on the contract's fields.
  const value = Number(draft.fuValue)
  const problems = {
    choice: !draft.followUp ? 'book one, or record that none is needed' : undefined,
    interval: draft.followUp === 'booked' && !(Number.isInteger(value) && value >= 1 && value <= 365) ? 'a whole number from 1 to 365' : undefined,
    none: draft.followUp === 'none' && (draft.fuNoneReason ?? '').trim().length < 5 ? 'say why none is needed' : undefined,
  }
  const shown = (key: keyof typeof problems) => (tried ? problems[key] : undefined)

  const typeLabel = (id?: string) => options?.types.find((t) => t.value === id)?.label ?? 'Any type'
  const providerLabel = (id?: string) => options?.providers.find((p) => p.value === id)?.label ?? 'Any provider'
  const unitLabel = (unit?: string) => INTERVAL_UNITS.find((u) => u.value === (unit ?? 'week'))?.label ?? 'weeks'

  async function onSave() {
    setTried(true)
    if (Object.values(problems).some(Boolean)) return
    setBusy(true)
    try {
      const saved = await saveFollowUp(encounterId, draft)
      setRequest(saved)
      setEditing(false)
      setTried(false)
    } catch (error) {
      setSaveError(followUpError(error))
    } finally {
      setBusy(false)
    }
  }

  async function onWithdraw() {
    setWithdrawTried(true)
    if (!withdrawReason.trim()) return
    setBusy(true)
    try {
      setRequest(await withdrawFollowUp(encounterId, withdrawReason))
      setWithdrawing(false)
      setWithdrawReason('')
      setWithdrawTried(false)
      setDraft({})
      setEditing(true)
    } catch (error) {
      setSaveError(followUpError(error))
    } finally {
      setBusy(false)
    }
  }

  const open = request?.status === 'open' && !editing

  return (
    <Card id="follow-up">
      <Section title="Follow-up">
        {request?.status === 'withdrawn' && editing && (
          <p className="text-[12px] text-sh-text-3">The earlier request was withdrawn: {request.withdrawnReason}</p>
        )}

        {open ? (
          <>
            <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] rounded-[14px] bg-sh-inner px-[14px] py-[10px]">
              <span className="min-w-0 flex-1">
                {request.followUp === 'none' ? (
                  <>
                    <span className="block text-[14px] font-medium text-sh-text">No follow-up needed</span>
                    <span className="block text-[12px] text-sh-text-2">{request.fuNoneReason}</span>
                  </>
                ) : (
                  <>
                    <span className="block text-[14px] font-medium text-sh-text">
                      In {request.fuValue} {unitLabel(request.fuUnit)}
                    </span>
                    <span className="block text-[12px] text-sh-text-2">
                      {typeLabel(request.fuTypeId)} · {providerLabel(request.fuProviderId)}
                      {request.fuNote ? ` · ${request.fuNote}` : ''}
                    </span>
                  </>
                )}
              </span>
              {/* "No follow-up needed" has no state on the server (gap 41): it stays in this tab. */}
              <PillTag tone="neu" size="xs" icon={Check}>
                {request.followUp === 'none' ? 'Saved here, not yet sent' : 'Sent to the front desk'}
              </PillTag>
            </div>
            {withdrawing ? (
              <Field label="Why the follow-up is withdrawn" required htmlFor="fu-withdraw" error={withdrawTried && !withdrawReason.trim() ? 'say why' : undefined}>
                <TextInput id="fu-withdraw" maxLength={500} value={withdrawReason} onChange={(e) => setWithdrawReason(e.target.value)} placeholder="Not needed after the results, say" />
              </Field>
            ) : null}
            {saveError && <Alert tone="crit" title="The follow-up was not changed">{saveError}</Alert>}
            <div className="flex flex-wrap justify-end gap-[8px]">
              {withdrawing ? (
                <>
                  <Pill variant="ghost" size="md" onClick={() => setWithdrawing(false)} disabled={busy}>
                    Keep it
                  </Pill>
                  <Pill variant="primary" size="md" icon={Undo2} onClick={onWithdraw} disabled={busy}>
                    {busy ? 'Withdrawing…' : 'Withdraw'}
                  </Pill>
                </>
              ) : (
                <>
                  <Pill variant="control" size="md" icon={Undo2} onClick={() => setWithdrawing(true)} disabled={locked}>
                    Withdraw
                  </Pill>
                  <Pill variant="control" size="md" onClick={() => setEditing(true)} disabled={locked}>
                    Change
                  </Pill>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <Choice
              label="Follow-up"
              value={draft.followUp ?? ''}
              options={[
                { key: 'booked', label: 'Schedule follow-up' },
                { key: 'none', label: 'No follow-up needed' },
              ]}
              onChange={(v) => set({ followUp: v as FollowUpDraft['followUp'] })}
            />
            {shown('choice') && <p className="text-[12px] font-medium text-sh-crit-fg">Follow-up: {problems.choice}</p>}
            {draft.followUp === 'booked' && (
              <>
                {loadError && (
                  <Alert tone="warn" icon={AlertTriangle} title="Appointment types and providers could not be loaded">
                    {loadError}
                  </Alert>
                )}
                <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2">
                  <Field label="Follow up in" required htmlFor="fu-interval" hint="Counted from the day of this visit" error={shown('interval')}>
                    <div className="flex gap-[8px]">
                      <TextInput id="fu-interval" type="number" min={1} max={365} inputMode="numeric" value={draft.fuValue ?? ''} disabled={locked} onChange={(e) => set({ fuValue: e.target.value })} className="w-[96px]" />
                      <Select id="fu-unit" aria-label="Unit" value={draft.fuUnit ?? 'week'} disabled={locked} onChange={(e) => set({ fuUnit: e.target.value as FollowUpDraft['fuUnit'] })}>
                        {INTERVAL_UNITS.map((u) => (
                          <option key={u.value} value={u.value}>
                            {u.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </Field>
                  <Field label="Appointment type" htmlFor="fu-type">
                    <Select id="fu-type" value={draft.fuTypeId ?? ''} disabled={locked || !options} onChange={(e) => set({ fuTypeId: e.target.value })}>
                      <option value="">{options ? (options.types.length ? 'Any' : 'None available') : loadError ? 'Not available' : 'Loading…'}</option>
                      {options?.types.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Provider" htmlFor="fu-provider">
                    <Select id="fu-provider" value={draft.fuProviderId ?? ''} disabled={locked || !options} onChange={(e) => set({ fuProviderId: e.target.value })}>
                      <option value="">{options ? (options.providers.length ? 'Any' : 'None available') : loadError ? 'Not available' : 'Loading…'}</option>
                      {options?.providers.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Note for the front office" htmlFor="fu-note" className="sm:col-span-2">
                    <TextInput id="fu-note" maxLength={500} value={draft.fuNote ?? ''} disabled={locked} onChange={(e) => set({ fuNote: e.target.value })} placeholder="e.g., labs to complete before the visit" />
                  </Field>
                </div>
              </>
            )}
            {draft.followUp === 'none' && (
              // TODO(question for Vimal, #85): the contract has no "no follow-up needed" state; kept on the screen only.
              <Field label="Why no follow-up is needed" required htmlFor="fu-none" error={shown('none')}>
                <TextInput id="fu-none" value={draft.fuNoneReason ?? ''} disabled={locked} onChange={(e) => set({ fuNoneReason: e.target.value })} placeholder="Resolved; the GP follows up, say" />
              </Field>
            )}
            {saveError && <Alert tone="crit" title="The follow-up was not saved">{saveError}</Alert>}
            <div className="flex flex-wrap justify-end gap-[8px]">
              {request?.status === 'open' && (
                <Pill variant="ghost" size="md" onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </Pill>
              )}
              <Pill variant="primary" size="md" icon={Check} onClick={onSave} disabled={locked || busy}>
                {busy ? 'Saving…' : 'Save follow-up'}
              </Pill>
            </div>
          </>
        )}
      </Section>
    </Card>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[10px]">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">{title}</h3>
      {children}
    </section>
  )
}

function Choice({ label, value, options, onChange }: { label: string; value: string; options: { key: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-x-[8px] gap-y-[10px]">
      {options.map((o) => {
        const on = o.key === value
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.key)}
            className={cn('inline-flex h-[44px] items-center gap-[6px] rounded-full px-[16px] text-[13px] font-medium transition-colors duration-150', on ? 'bg-sh-primary text-sh-on-primary' : 'bg-sh-control text-sh-text-2 hover:text-sh-text')}
          >
            {on && <Icon icon={Check} size={14} />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

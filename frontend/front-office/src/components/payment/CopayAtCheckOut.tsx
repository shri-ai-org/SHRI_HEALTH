import { useEffect, useRef, useState } from 'react'
import { FileText, Wallet } from 'lucide-react'
import { Button } from '../ui/Button'
import { cn } from '../../utils/cn'
import { errorClass, inputClass, labelClass } from '../../utils/formClasses'
import { formatMoney } from '../../utils/billing'
import { newIdempotencyKey } from '../../../shri-health/client'
import {
  COPAY_METHODS,
  CopayRefusal,
  isSecondCopay,
  receiptUrl,
  recordCopay,
  suggestedCopay,
  type CopayForm,
} from '../../../shri-health/payments'
import type { Payment } from '../../../../src/api/generated/model'

/**
 * The copay at check-out (demo step 11), adapted from care-entry's BillAtCounter and
 * PaymentReceiptPage: the same card and its two states, due and paid, without the billing
 * counter's fee and without a separate counter step. The desk records the copay the patient
 * hands over (cash, check or other; cards wait for the card processor), and the receipt PDF the
 * payment created in the same step opens from here (D104). The amount starts from the visit's
 * eligibility check when it found a copay; the desk can change it.
 */
export function CopayAtCheckOut({ patientId, appointmentId, encounterId, onPaid }: {
  patientId: string
  appointmentId: string
  encounterId?: string
  onPaid?: (payment: Payment) => void
}) {
  const [form, setForm] = useState<CopayForm>({ amount: '', method: 'cash', checkNumber: '', note: '' })
  const [suggested, setSuggested] = useState<string | null>(null)
  const [paid, setPaid] = useState<Payment | null>(null)
  const [busy, setBusy] = useState<'pay' | 'receipt' | null>(null)
  const [error, setError] = useState<CopayRefusal | null>(null)
  /** M11: the server already has a copay for this visit (its 409 on a second one). */
  const [already, setAlready] = useState(false)
  // M11: one key per attempt, reused only to retry the very same request (a dropped connection, a
  // timeout, a 5xx); a changed form is a new attempt with a new key.
  const attempt = useRef<{ body: string; key: string } | null>(null)
  // M11: a second click while the first is on its way does nothing (the button is disabled too).
  const inFlight = useRef(false)

  useEffect(() => {
    let live = true
    void suggestedCopay(appointmentId).then((copay) => {
      if (!live || !copay) return
      setSuggested(copay)
      setForm((f) => (f.amount ? f : { ...f, amount: copay }))
    })
    return () => {
      live = false
    }
  }, [appointmentId])

  async function pay() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy('pay')
    setError(null)
    const body = JSON.stringify(form)
    if (attempt.current?.body !== body) attempt.current = { body, key: newIdempotencyKey() }
    try {
      const payment = await recordCopay(patientId, appointmentId, encounterId, form, attempt.current.key)
      attempt.current = null
      setPaid(payment)
      onPaid?.(payment)
    } catch (e) {
      const r = e as CopayRefusal
      if (isSecondCopay(r)) setAlready(true)
      setError(r)
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  async function openReceipt() {
    if (!paid) return
    setBusy('receipt')
    setError(null)
    try {
      const url = await receiptUrl(paid.receiptFileId)
      if (url) window.open(url, '_blank', 'noopener')
      else setError(new CopayRefusal('The receipt is not ready yet. Try again in a moment.', 0))
    } catch (e) {
      setError(e as CopayRefusal)
    } finally {
      setBusy(null)
    }
  }

  const tone = paid || already
    ? 'border-[color-mix(in_oklab,var(--color-hue-green)_28%,var(--color-border-soft))] bg-[color-mix(in_oklab,var(--color-hue-green)_8%,var(--color-surface-1))]'
    : 'border-[color-mix(in_oklab,var(--color-hue-amber)_28%,var(--color-border-soft))] bg-[color-mix(in_oklab,var(--color-hue-amber)_8%,var(--color-surface-1))]'
  const fieldError = (pointer: string) => (error?.pointer === pointer ? error.message : null)

  return (
    <div className={cn('rounded-xl border px-3.5 py-2.5', tone)} data-testid="copay">
      {already && !paid ? (
        <p className="text-sm font-semibold text-ink" data-testid="copay-already">
          Copay paid · already recorded for this visit
        </p>
      ) : paid ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-ink" data-testid="copay-paid">
            Copay paid · {formatMoney(Number(paid.amount.value))} · {COPAY_METHODS.find((m) => m.value === paid.method)?.label ?? paid.method}
          </p>
          <div>
            <Button size="xs" variant="secondary" onClick={() => void openReceipt()} disabled={busy !== null}>
              <FileText className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              {busy === 'receipt' ? 'Opening…' : 'Open receipt'}
            </Button>
          </div>
        </div>
      ) : (
        <form
          aria-label="Copay"
          className="grid gap-2"
          onSubmit={(ev) => {
            ev.preventDefault()
            if (busy === null) void pay()
          }}
        >
          <p className="text-xs text-ink-muted">
            {suggested
              ? `The eligibility check found a ${formatMoney(Number(suggested))} copay for this visit.`
              : 'No copay was found by the eligibility check. Enter what the patient pays, if anything.'}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className={labelClass}>
              Amount ($)
              <input inputMode="decimal" value={form.amount} aria-invalid={Boolean(fieldError('/amount'))}
                     onChange={(ev) => setForm({ ...form, amount: ev.target.value })}
                     className={cn(inputClass, 'w-28')} />
            </label>
            <label className={labelClass}>
              Paid by
              <select value={form.method} onChange={(ev) => setForm({ ...form, method: ev.target.value as CopayForm['method'] })}
                      className={inputClass}>
                {COPAY_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            {form.method === 'check' ? (
              <label className={labelClass}>
                Check number
                <input value={form.checkNumber} maxLength={30} aria-invalid={Boolean(fieldError('/checkNumber'))}
                       onChange={(ev) => setForm({ ...form, checkNumber: ev.target.value })}
                       className={cn(inputClass, 'w-32')} />
              </label>
            ) : null}
          </div>
          <label className={labelClass}>
            Note (optional)
            <input value={form.note} maxLength={500} onChange={(ev) => setForm({ ...form, note: ev.target.value })}
                   className={inputClass} />
          </label>
          <div>
            <Button size="xs" type="submit" disabled={busy !== null}>
              <Wallet className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              {busy === 'pay' ? 'Recording…' : 'Record copay'}
            </Button>
          </div>
        </form>
      )}
      {error ? <p role="alert" className={cn(errorClass, 'mt-1')}>{error.message}</p> : null}
    </div>
  )
}

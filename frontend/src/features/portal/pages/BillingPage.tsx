import { CheckCircle2, Lock } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Alert, Button, Field, formatMoney, Modal, parseMoneyInput, problemCopy, TextInput, type Money } from '../../../design-system'
import { usePortalApi } from '../api/portalApi'
import type { Bill, Payment } from '../api/types'
import { toProblem, useResource } from '../api/useResource'
import { AsyncPanel, formatShortDate, matches, PageHeader, SearchBox, Table } from '../ui'

function cents(m: Money): number {
  return Math.round(Number(m.value) * 100)
}

function money(m: Money): string {
  return cents(m) === 0 ? '---' : formatMoney(m)
}

/** The old "Pay Bills": the table, Details (the medical bill), and Pay (bill → Proceed to Pay → payment). */
export function BillingPage() {
  const api = usePortalApi()
  const bills = useResource(() => api.listBills(), [])
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState<{ kind: 'details' | 'pay-bill' | 'payment'; bill: Bill } | null>(null)
  const [paid, setPaid] = useState(false)

  function close() {
    setDialog(null)
    if (paid) {
      setPaid(false)
      bills.reload()
    }
  }

  return (
    <>
      <PageHeader title="Pay Bills" back={{ to: '/', label: 'Home' }} actions={<SearchBox value={q} onChange={setQ} />} />
      <AsyncPanel resource={bills} label="your bills">
        {(list) => (
          <Table
            caption="Bills by visit"
            empty="No bills in the list"
            rows={list.filter((b) => matches(q, b.practice.name, b.provider.displayName, b.visitReason, formatShortDate(b.serviceDate)))}
            rowKey={(b) => b.id}
            columns={[
              {
                header: 'Practice',
                cell: (b) => (
                  <>
                    <span className="block font-medium">{b.practice.name}</span>
                    <span className="block text-xs text-ink-muted">{b.practice.address}</span>
                  </>
                ),
              },
              {
                header: 'Visit Details',
                rowHeader: true,
                cell: (b) => (
                  <>
                    <span className="block">{b.visitReason}</span>
                    <span className="block text-xs font-normal text-ink-muted">
                      {b.provider.displayName} · {formatShortDate(b.serviceDate)}
                    </span>
                  </>
                ),
              },
              { header: 'Actual Charges', numeric: true, cell: (b) => formatMoney(b.charges) },
              { header: 'Insurance Payment Paid', numeric: true, cell: (b) => money(b.insurancePaid) },
              { header: 'Patient Payment Paid (with Copay)', numeric: true, cell: (b) => money(b.patientPaid) },
              { header: 'Amount Due', numeric: true, cell: (b) => <strong>{money(b.amountDue)}</strong> },
              {
                header: 'Action',
                cell: (b) => (
                  <span className="flex gap-1">
                    <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'details', bill: b })} aria-label={`Details for ${b.visitReason}, ${formatShortDate(b.serviceDate)}`}>
                      Details
                    </Button>
                    <Button size="sm" disabled={cents(b.amountDue) === 0} onClick={() => setDialog({ kind: 'pay-bill', bill: b })} aria-label={`Pay ${b.visitReason}, ${formatShortDate(b.serviceDate)}`}>
                      Pay
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        )}
      </AsyncPanel>

      {dialog && dialog.kind !== 'payment' ? (
        <Modal
          open
          size="lg"
          title="Medical Bill"
          onClose={close}
          footer={
            <>
              <Button variant="outline" onClick={close}>
                Close
              </Button>
              {dialog.kind === 'pay-bill' ? <Button onClick={() => setDialog({ kind: 'payment', bill: dialog.bill })}>Proceed to Pay</Button> : null}
            </>
          }
        >
          <BillDetail bill={dialog.bill} />
        </Modal>
      ) : null}
      {dialog?.kind === 'payment' ? <PaymentDialog bill={dialog.bill} onPaid={() => setPaid(true)} onClose={close} /> : null}
    </>
  )
}

function BillDetail({ bill }: { bill: Bill }) {
  return (
    <div className="space-y-4 text-ink">
      <div className="flex flex-wrap justify-between gap-2">
        <div>
          <p className="font-semibold">{bill.practice.name}</p>
          <p className="text-ink-muted">{bill.practice.address}</p>
        </div>
        <p className="text-ink-muted">Date: {formatShortDate(bill.serviceDate)}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] text-sm">
          <caption className="sr-only">Charges and payments</caption>
          <thead className="text-xs text-ink-muted">
            <tr className="border-b border-border-soft">
              <th scope="col" className="py-2 text-left font-semibold">Date</th>
              <th scope="col" className="py-2 text-left font-semibold">Description</th>
              <th scope="col" className="py-2 text-right font-semibold">Qty</th>
              <th scope="col" className="py-2 text-right font-semibold">Unit Price</th>
              <th scope="col" className="py-2 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.description} className="border-b border-border-soft">
                <td className="py-2 pr-2">{formatShortDate(l.date)}</td>
                <td className="py-2 pr-2">{l.description}</td>
                <td className="py-2 text-right tabular-nums">{l.quantity}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(l.unitPrice)}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(l.total)}</td>
              </tr>
            ))}
            <tr className="border-b border-border font-semibold">
              <th scope="row" colSpan={4} className="py-2 text-left">Total Charges</th>
              <td className="py-2 text-right tabular-nums">{formatMoney(bill.charges)}</td>
            </tr>
            {bill.adjustments.map((a, i) => (
              <tr key={`${a.description}-${i}`} className="border-b border-border-soft text-ink-muted">
                <td className="py-2 pr-2">{formatShortDate(a.date)}</td>
                <td colSpan={3} className="py-2 pr-2">{a.description}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(a.amount)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <th scope="row" colSpan={4} className="py-2 text-left">Balance Due</th>
              <td className="py-2 text-right tabular-nums">{formatMoney(bill.amountDue)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * The old "Payment Details". The card section is the payment processor's hosted form (Q17): card
 * numbers never reach this page's code or our servers; we receive a one-time token.
 */
function PaymentDialog({ bill, onPaid, onClose }: { bill: Bill; onPaid: () => void; onClose: () => void }) {
  const api = usePortalApi()
  const [amount, setAmount] = useState(bill.amountDue.value)
  const [token, setToken] = useState<string | null>(null)
  const [errors, setErrors] = useState<{ amount?: string; card?: string }>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [paid, setPaid] = useState<Payment | null>(null)

  async function pay(e: FormEvent) {
    e.preventDefault()
    const parsed = parseMoneyInput(amount)
    const next: typeof errors = {}
    if (!parsed || Number(parsed) <= 0 || Number(parsed) > Number(bill.amountDue.value)) next.amount = `Enter an amount from $0.01 to ${formatMoney(bill.amountDue)}`
    if (!token) next.card = 'Enter your card in the secure card form'
    setErrors(next)
    if (next.amount || next.card || !parsed || !token) return
    setBusy(true)
    setFailure(null)
    try {
      setPaid(await api.makePayment({ billId: bill.id, amount: { value: parsed, currency: 'USD' }, paymentToken: token }))
      onPaid()
    } catch (err) {
      setFailure(problemCopy(toProblem(err)).message)
    } finally {
      setBusy(false)
    }
  }

  if (paid) {
    return (
      <Modal open title="Payment Details" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
        <Alert tone="success" title={`Transaction completed. We received ${formatMoney(paid.amount)}.`}>
          Confirmation number <strong>{paid.confirmationNumber}</strong>.
        </Alert>
      </Modal>
    )
  }

  return (
    <Modal
      open
      title="Payment Details"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" form="payment-form" loading={busy} icon={<Lock aria-hidden="true" size={15} />}>
            Pay Now
          </Button>
        </>
      }
    >
      <form id="payment-form" noValidate onSubmit={pay} className="space-y-4">
        {failure ? <Alert tone="critical" title="Payment failed">{failure}</Alert> : null}
        <p className="text-ink">
          {bill.visitReason}, {formatShortDate(bill.serviceDate)} · Amount due <strong>{formatMoney(bill.amountDue)}</strong>
        </p>
        <div className="rounded-lg border border-dashed border-border-strong bg-surface-2 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Lock aria-hidden="true" size={15} /> Card details
          </p>
          <p className="mt-1 text-xs text-ink-muted">Card number, CVV and expiry date go straight to our payment processor. Shri Health never sees your card number.</p>
          {token ? (
            <p className="mt-3 flex items-center gap-2 text-sm font-medium text-success-fg">
              <CheckCircle2 aria-hidden="true" size={16} /> Test card ready
            </p>
          ) : (
            <Button className="mt-3" variant="outline" size="sm" onClick={() => setToken(`tok_mock_${Date.now()}`)}>
              Use a test card (mock)
            </Button>
          )}
          {errors.card ? <p className="mt-2 text-xs font-medium text-critical-fg">{errors.card}</p> : null}
        </div>
        <Field id="pay-amount" label="Amount" hint="In dollars, for example 25.00" required error={errors.amount}>
          {(p) => <TextInput {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
      </form>
    </Modal>
  )
}

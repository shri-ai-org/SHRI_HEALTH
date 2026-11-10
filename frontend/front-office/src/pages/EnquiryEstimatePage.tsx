import { useMemo, useState } from 'react'
import { Receipt, Plus, Minus, Trash2, Search, Printer } from 'lucide-react'
import { PageHeader } from '../components/layout/PageHeader'
import { Card, CardBody, CardHeader } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { EmptyState } from '../components/ui/EmptyState'
import { ResponsiveTable } from '../components/ui/ResponsiveTable'
import { PatientPickField } from '../components/patient/PatientPickField'
import { useStoreValue } from '../hooks/useStore'
import { useToast } from '../hooks/useToast'
import { BillAtCounter } from '../components/payment/BillAtCounter'
import { printBill } from '../utils/printBill'
import { getTariffs, getDepartments, getActiveEstimateForPatient, getBillForEstimate, getPatientById } from '../domain/selectors'
import { addEstimateItem, createPaymentBill, updateEstimateItemQuantity, removeEstimateItem } from '../domain/actions'
import { billNumberFor, formatRupees } from '../utils/billing'
import type { Tariff } from '../types/frontDesk'


/** An estimate always belongs to exactly one patient — the patient chosen
 *  here gates every "Add", so there is no anonymous/global estimate to
 *  accidentally add a service into. */
export function EnquiryEstimatePage() {
  const { notify } = useToast()
  const [patientId, setPatientId] = useState('')
  const patient = useStoreValue(getPatientById, patientId)

  const tariffs = useStoreValue(getTariffs)
  const departments = useStoreValue(getDepartments)
  const estimate = useStoreValue(getActiveEstimateForPatient, patient?.patientId ?? '')
  const estimateBill = useStoreValue(getBillForEstimate, estimate?.estimateId ?? '')

  const [query, setQuery] = useState('')
  const [department, setDepartment] = useState('All departments')

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return tariffs.filter((tariff) => {
      const matchesTerm = term.length === 0 || tariff.name.toLowerCase().includes(term) || tariff.code.toLowerCase().includes(term)
      const matchesDept = department === 'All departments' || tariff.department === department
      return matchesTerm && matchesDept
    })
  }, [tariffs, query, department])

  function handleAdd(tariff: Tariff) {
    if (!patient) {
      notify('Select a patient first', { tone: 'error', detail: 'An estimate must be linked to a patient before adding a service.' })
      return
    }
    try {
      addEstimateItem({
        patientId: patient.patientId,
        patientName: patient.name,
        item: { code: tariff.code, name: tariff.name, rate: tariff.rate, quantity: 1 },
      })
    } catch (err) {
      notify('Could not add service', { tone: 'error', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  function handleQuantity(code: string, quantity: number) {
    if (!estimate) return
    try {
      updateEstimateItemQuantity({ estimateId: estimate.estimateId, code, quantity })
    } catch (err) {
      notify('Could not update quantity', { tone: 'error', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  function handleRemove(code: string) {
    if (!estimate) return
    removeEstimateItem({ estimateId: estimate.estimateId, code })
  }

  // Care Entry takes no money: the estimate is raised as a bill, printed, and
  // the patient pays it at the billing counter.
  function raiseAndPrintBill() {
    if (!estimate || !patient) return
    try {
      const bill = createPaymentBill({
        patientId: patient.patientId,
        items: estimate.items.map((item) => ({ code: item.code, description: item.name, amount: item.rate * (item.quantity ?? 1) })),
        estimateId: estimate.estimateId,
      })
      printBill(bill.paymentId)
      notify(`Bill printed for ${patient.name}`, { detail: `${billNumberFor(bill)} · ${formatRupees(bill.totalAmount)}` })
    } catch (err) {
      notify('Could not raise the bill', { tone: 'error', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  const hasItems = Boolean(estimate && estimate.items.length > 0)
  const canBill = Boolean(estimate && estimate.status !== 'Cancelled' && hasItems && !estimateBill)

  return (
    <div>
      <PageHeader title="Enquiry & Estimate" />

      <div className="flex flex-col gap-4 sm:gap-5 mt-4 sm:mt-5">
        {/* Patient gate — every estimate belongs to one patient */}
        <Card accentTone="cyan">
          <CardBody className="flex flex-col gap-2 lg:max-w-xl">
            <p className="text-xs font-medium text-ink-muted">Patient</p>
            <PatientPickField
              patient={patient}
              onChange={(next) => setPatientId(next.patientId)}
              placeholder="Search for the patient this estimate is for"
              detail={patient?.mobile}
            />
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_380px]">
          {/* Available services */}
          <Card accentTone="stable" className="min-w-0">
            <CardHeader icon={Receipt} iconTone="stable" title="Available Services" />
            <div className="flex flex-col gap-3 border-b border-border-soft p-4 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border-soft bg-surface-1 px-3 transition-colors hover:border-border-strong focus-within:border-primary-600 focus-within:ring-4 focus-within:ring-primary-600/10">
                <Search className="h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.75} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search services"
                  aria-label="Search services"
                  className="min-h-11 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
                />
              </div>
              <select
                value={department}
                onChange={(event) => setDepartment(event.target.value)}
                aria-label="Department"
                className="focus-ring min-h-11 rounded-lg border border-border bg-surface-1 px-3 text-sm text-ink"
              >
                <option>All departments</option>
                {departments.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </div>

            {filtered.length === 0 ? (
              <EmptyState icon={Search} title="No services match" />
            ) : (
              <ResponsiveTable
                rows={filtered}
                rowKey={(tariff) => tariff.code}
                caption="Available services"
                columns={[
                  {
                    key: 'service',
                    header: 'Service',
                    mobile: 'title',
                    sortValue: (tariff) => tariff.name,
                    cell: (tariff) => (
                      <>
                        <span className="block font-medium text-ink">{tariff.name}</span>
                        <span className="block text-2xs font-normal text-ink-subtle">{tariff.code}</span>
                      </>
                    ),
                  },
                  { key: 'department', header: 'Department', className: 'whitespace-nowrap text-ink-muted', sortValue: (tariff) => tariff.department, cell: (tariff) => tariff.department },
                  {
                    key: 'rate',
                    header: 'Rate',
                    numeric: true,
                    mobile: 'aside',
                    className: 'whitespace-nowrap font-medium text-ink',
                    sortValue: (tariff) => tariff.rate,
                    cell: (tariff) => formatRupees(tariff.rate),
                  },
                  {
                    key: 'actions',
                    header: <span className="sr-only">Actions</span>,
                    className: 'whitespace-nowrap text-right',
                    mobile: 'actions',
                    cell: (tariff) => (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!patient}
                        title={patient ? undefined : 'Select a patient first'}
                        onClick={() => handleAdd(tariff)}
                      >
                        <Plus size={14} className="text-success-fg" aria-hidden="true" />
                        Add
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </Card>

          {/* Estimate for the selected patient */}
          <div className="min-w-0">
            <Card accentTone="cyan" className="2xl:sticky 2xl:top-6">
              <CardHeader
                title={patient ? `Estimate for ${patient.name}` : 'Estimate'}
                subtitle={estimate ? estimate.estimateId : undefined}
                action={estimate ? <Badge status={estimate.status} /> : undefined}
              />
              <CardBody className="flex flex-col gap-4">
                {!patient ? (
                  <p className="text-sm text-ink-muted">No patient selected</p>
                ) : !estimate || estimate.items.length === 0 ? (
                  <p className="text-sm text-ink-muted">No estimate yet</p>
                ) : (
                  <div className="divide-y divide-border-soft">
                    {estimate.items.map((item) => {
                      const quantity = item.quantity ?? 1
                      return (
                        <div key={item.code} className="flex items-center justify-between gap-2 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-ink" title={item.name}>
                              {item.name}
                            </p>
                            <p className="text-xs text-ink-muted">{formatRupees(item.rate)} each</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <div className="flex items-center gap-1 rounded-lg border border-border px-1">
                              <button
                                type="button"
                                onClick={() => handleQuantity(item.code, quantity - 1)}
                                disabled={quantity <= 1}
                                aria-label={`Decrease quantity for ${item.name}`}
                                className="focus-ring tap-reach flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                              >
                                <Minus className="h-3 w-3" strokeWidth={2} />
                              </button>
                              <span className="w-5 text-center text-xs font-medium tabular-nums text-ink">{quantity}</span>
                              <button
                                type="button"
                                onClick={() => handleQuantity(item.code, quantity + 1)}
                                aria-label={`Increase quantity for ${item.name}`}
                                className="focus-ring tap-reach flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                              >
                                <Plus className="h-3 w-3" strokeWidth={2} />
                              </button>
                            </div>
                            <span className="w-16 shrink-0 text-right text-sm font-medium tabular-nums text-ink">
                              {formatRupees(item.rate * quantity)}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleRemove(item.code)}
                              aria-label={`Remove ${item.name}`}
                              className="focus-ring tap-target rounded-lg text-ink-subtle transition-colors hover:bg-surface-2 hover:text-critical-fg"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {hasItems && estimate ? (
                  <div className="flex items-baseline justify-between border-t border-border-soft pt-3">
                    <span className="text-sm text-ink-muted">Estimated Total</span>
                    <span className="text-xl font-semibold tabular-nums text-ink">{formatRupees(estimate.total)}</span>
                  </div>
                ) : null}

                {patient ? (
                  <div className="flex flex-wrap gap-2 border-t border-border-soft pt-4">
                    {hasItems && estimate ? (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => window.print()}>
                          Print estimate
                        </Button>
                        {canBill && estimate ? (
                          <Button size="sm" onClick={raiseAndPrintBill}>
                            <Printer className="h-3.5 w-3.5" strokeWidth={1.75} />
                            Print bill · {formatRupees(estimate.total)}
                          </Button>
                        ) : null}
                        {estimateBill ? <BillAtCounter paymentId={estimateBill.paymentId} className="w-full" /> : null}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </CardBody>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

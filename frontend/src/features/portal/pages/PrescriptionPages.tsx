import { CheckCircle2, Search } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Alert, Badge, Button, Field, formatPhone, problemCopy, Select, TextInput, type BadgeTone } from '../../../design-system'
import { usePortalApi } from '../api/portalApi'
import type { PortalMedication } from '../../../api/generated/model'
import type { Pharmacy, Prescription } from '../api/types'
import { REAL_API } from '../features'
import { toProblem, useResource } from '../api/useResource'
import { Link, useRouter } from '../router'
import { AsyncPanel, Card, DefinitionList, ErrorSummary, formatInstantShort, formatShortDate, matches, PageHeader, Pager, SearchBox, usePaged } from '../ui'
import { useClinicTimeZone } from '../clinicZone'
import { refillRequestsOn } from '../refills'
import { RefillControl, useMyRefills } from './RefillRequest'

const STATUS: Record<Prescription['requestStatus'], { label: string; tone: BadgeTone }> = {
  none: { label: '—', tone: 'neutral' },
  requested: { label: 'Requested', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  denied: { label: 'Denied', tone: 'critical' },
}

/**
 * The old PRESCRIPTIONS page: tick rows, choose a pharmacy, write a message, send the request. With
 * the real API, the patient's own medication list (listPortalMedications, #389) instead: refills
 * have no contract yet, so there is no refill step.
 */
export function PrescriptionsPage() {
  return REAL_API ? <MedicationsPage /> : <SamplePrescriptionsPage />
}

const MED_STATUS: Record<PortalMedication['status'], { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  completed: { label: 'Completed', tone: 'neutral' },
  stopped: { label: 'Stopped', tone: 'neutral' },
}
const MED_SOURCE: Record<PortalMedication['source'], string> = {
  prescription: 'Prescribed by your clinic',
  reported: 'Reported by you',
}
const TRANSMISSION: Record<NonNullable<PortalMedication['transmissionStatus']>, string> = {
  queued: 'Waiting to be sent to the pharmacy',
  sent: 'Sent to the pharmacy',
  accepted: 'Received by the pharmacy',
  rejected: 'Not accepted by the pharmacy. Contact your clinic.',
  error: "Couldn't be sent to the pharmacy. Contact your clinic.",
}

/** The patient's medications, active first as the API gives them. Read only. */
export function MedicationsPage() {
  const api = usePortalApi()
  const tz = useClinicTimeZone()
  const meds = useResource(() => api.listMedications(), [])
  // Refill requests (#415): only in a build with VITE_FEATURE_REFILL_REQUESTS=on.
  const refills = refillRequestsOn()
  return (
    <>
      <PageHeader
        title="Prescriptions"
        description={refills ? 'Ask your clinic to refill a current prescription, or contact your clinic.' : 'To request a refill, contact your clinic.'}
        back={{ to: '/', label: 'Home' }}
      />
      {refills ? <RefillsFor meds={meds} tz={tz} /> : <MedicationList meds={meds} tz={tz} />}
    </>
  )
}

/** The medications with each one's refill status and "Request refill". */
function RefillsFor({ meds, tz }: { meds: ReturnType<typeof useResource<PortalMedication[]>>; tz: string | null }) {
  const { state, reload, retry } = useMyRefills()
  return (
    <>
      {state.kind === 'error' ? (
        <div className="mb-4">
          <Alert
            tone="critical"
            title="We couldn't read your refill requests."
            actions={
              <Button size="sm" variant="outline" onClick={retry}>
                Try again
              </Button>
            }
          >
            Your medicines are below; refills can be requested once your requests are read.
          </Alert>
        </div>
      ) : null}
      {state.kind === 'forbidden' ? (
        <div className="mb-4">
          <Alert tone="warning" title="Your account can't see refill requests. Contact your clinic for a refill." />
        </div>
      ) : null}
      <MedicationList
        meds={meds}
        tz={tz}
        extra={(m) =>
          state.kind === 'ok' ? <RefillControl med={m} latest={state.latest.get(m.id)} timeZone={tz} onChanged={() => void reload()} /> : state.kind === 'loading' ? (
            <p className="mt-2 text-sm text-ink-muted">Checking refills…</p>
          ) : null
        }
      />
    </>
  )
}

function MedicationList({
  meds,
  tz,
  extra,
}: {
  meds: ReturnType<typeof useResource<PortalMedication[]>>
  tz: string | null
  extra?: (m: PortalMedication) => React.ReactNode
}) {
  return (
    <>
      <AsyncPanel resource={meds} label="your medications">
        {(list) =>
          list.length === 0 ? (
            <Card>
              <p className="py-6 text-center text-sm text-ink-muted">No medications on your record yet.</p>
            </Card>
          ) : (
            <ul aria-label="Your medications" className="divide-y divide-border-soft overflow-hidden rounded-2xl border border-(--accent-line) bg-surface-1 shadow-card">
              {list.map((m) => (
                <li key={m.id} className="px-4 py-3.5 sm:px-5">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <h2 className="text-base font-semibold text-ink">{m.display}</h2>
                    <Badge tone={MED_STATUS[m.status].tone}>{MED_STATUS[m.status].label}</Badge>
                  </div>
                  {m.dosageText ? <p className="mt-1 text-sm text-ink">{m.dosageText}</p> : null}
                  <p className="mt-1.5 text-sm text-ink-muted">
                    {m.source === 'prescription' && m.prescriberDisplayName && m.prescribedAt
                      ? `Prescribed by ${m.prescriberDisplayName} on ${formatInstantShort(m.prescribedAt, tz)}`
                      : MED_SOURCE[m.source]}
                  </p>
                  {m.pharmacyName || m.transmissionStatus ? (
                    <p className="mt-1 text-sm text-ink-muted">
                      {m.pharmacyName ? `Pharmacy: ${m.pharmacyName}` : null}
                      {m.pharmacyName && m.transmissionStatus ? ' · ' : null}
                      {m.transmissionStatus ? TRANSMISSION[m.transmissionStatus] : null}
                    </p>
                  ) : null}
                  {extra?.(m)}
                </li>
              ))}
            </ul>
          )
        }
      </AsyncPanel>
    </>
  )
}

function SamplePrescriptionsPage() {
  const api = usePortalApi()
  const data = useResource(() => Promise.all([api.listPrescriptions(), api.getReferenceLists()]), [])
  return (
    <>
      <PageHeader title="Prescriptions" back={{ to: '/', label: 'Home' }} />
      <AsyncPanel resource={data} label="your prescriptions">
        {([list, lists]) => <RefillForm list={list} pharmacies={lists.pharmacies} />}
      </AsyncPanel>
    </>
  )
}

function RefillForm({ list, pharmacies }: { list: Prescription[]; pharmacies: Pharmacy[] }) {
  const api = usePortalApi()
  const { navigate } = useRouter()
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [pharmacyId, setPharmacyId] = useState('')
  const [message, setMessage] = useState('')
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const shown = list.filter((p) => matches(q, p.drug, p.provider.displayName, p.note))
  const paged = usePaged(shown, 5)
  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message

  async function submit(e: FormEvent) {
    e.preventDefault()
    const found: typeof errors = []
    if (!selected.length) found.push({ fieldId: `rx-${paged.rows.find((r) => r.refillable)?.id ?? ''}`, message: 'Please choose at least one prescription' })
    if (!pharmacyId) found.push({ fieldId: 'rx-pharmacy', message: 'Choose your pharmacy' })
    if (!message.trim()) found.push({ fieldId: 'rx-message', message: 'Write a message for your provider' })
    setErrors(found)
    if (found.length) return
    setBusy(true)
    setFailure(null)
    try {
      const req = await api.requestRefill({ prescriptionIds: selected, pharmacyId, message })
      navigate(`/prescriptions/requests/${req.id}`)
    } catch (error) {
      setFailure(problemCopy(toProblem(error)).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form noValidate onSubmit={submit} className="space-y-5">
      <ErrorSummary errors={errors} />
      {failure ? <Alert tone="critical" title="Refill request not sent">{failure}</Alert> : null}
      <SearchBox value={q} onChange={setQ} label="Search here" />
      <div className="overflow-x-auto rounded-2xl border border-(--accent-line) bg-surface-1 shadow-card">
        <table className="w-full min-w-[48rem] text-left text-sm">
          <caption className="sr-only">Prescriptions. Tick the ones you want refilled.</caption>
          <thead className="bg-(--accent-soft) text-xs font-bold tracking-wide text-(--accent-text) uppercase">
            <tr>
              {['Select', 'Prescription', 'Provider', 'Remaining Refill', 'Last Refilled Date', 'Status', 'Notes'].map((h) => (
                <th key={h} scope="col" className="px-3 py-2.5 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.rows.length ? (
              paged.rows.map((p) => {
                const blocked = !p.refillable ? 'Call the clinic to refill this one' : p.requestStatus === 'requested' ? 'Refill already requested' : null
                return (
                  <tr key={p.id} className="border-t border-border-soft hover:bg-surface-2">
                    <td className="px-3 py-2">
                      <input
                        id={`rx-${p.id}`}
                        type="checkbox"
                        className="size-5 accent-primary-600 disabled:opacity-40"
                        disabled={Boolean(blocked)}
                        checked={selected.includes(p.id)}
                        aria-label={`Select ${p.drug}${blocked ? `. ${blocked}` : ''}`}
                        onChange={(e) => setSelected((s) => (e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id)))}
                      />
                    </td>
                    <th scope="row" className="px-3 py-2 font-medium text-ink">{p.drug}</th>
                    <td className="px-3 py-2">{p.provider.displayName}</td>
                    <td className="px-3 py-2 tabular-nums">{p.refillsRemaining}</td>
                    <td className="px-3 py-2">{p.lastRefilledDate ? formatShortDate(p.lastRefilledDate) : '—'}</td>
                    <td className="px-3 py-2">{p.requestStatus === 'none' ? '—' : <Badge tone={STATUS[p.requestStatus].tone}>{STATUS[p.requestStatus].label}</Badge>}</td>
                    <td className="px-3 py-2 text-ink-muted">{blocked && !p.refillable ? blocked : (p.note ?? '—')}</td>
                  </tr>
                )
              })
            ) : (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-ink-muted">
                  No data to display
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager {...paged} />

      <Card>
        <p className="mb-4 text-sm text-ink-muted" aria-live="polite">
          {selected.length ? `${selected.length} prescription${selected.length === 1 ? '' : 's'} selected` : 'Tick the prescriptions you want refilled.'}
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="rx-pharmacy" label="Choose your convenient pharmacy" required error={err('rx-pharmacy')}>
            {(p) => (
              <Select {...p} value={pharmacyId} onChange={(e) => setPharmacyId(e.target.value)}>
                <option value="">Select pharmacy name</option>
                {pharmacies.map((ph) => (
                  <option key={ph.id} value={ph.id}>
                    {ph.displayName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id="rx-message" label="Message for your provider" required error={err('rx-message')}>
            {(p) => (
              <textarea
                {...p}
                rows={3}
                maxLength={500}
                placeholder="Compose your message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface-1 px-3.5 py-2.5 text-sm text-ink aria-invalid:border-critical-fg"
              />
            )}
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button type="submit" size="lg" loading={busy}>
            Send Refill Request
          </Button>
        </div>
      </Card>
    </form>
  )
}

/** The old "Prescription Refill Summary", now with every prescription and the pharmacy actually chosen. */
export function RefillConfirmationPage({ refillRequestId }: { refillRequestId: string }) {
  const tz = useClinicTimeZone()
  const api = usePortalApi()
  const req = useResource(() => api.getRefillRequest(refillRequestId), [refillRequestId])
  return (
    <>
      <PageHeader title="Prescription Refill Summary" back={{ to: '/prescriptions', label: 'Prescriptions' }} />
      <AsyncPanel resource={req} label="your refill request">
        {(r) => (
          <div className="max-w-2xl space-y-4">
            <Alert tone="success" title="Thank you! Your prescription refill request has been sent." />
            <Card>
              <div className="flex items-start gap-3">
                <CheckCircle2 aria-hidden="true" size={22} className="mt-0.5 shrink-0 text-success-fg" />
                <DefinitionList
                  items={[
                    { term: r.prescriptions.length === 1 ? 'Prescription' : 'Prescriptions', value: r.prescriptions.map((p) => p.drug).join(', ') },
                    { term: 'Pharmacy', value: `${r.pharmacy.displayName}, ${r.pharmacy.address}, ${formatPhone(r.pharmacy.phone)}` },
                    { term: 'Your message', value: r.message },
                    { term: 'Sent', value: formatInstantShort(r.requestedAt, tz) },
                  ]}
                />
              </div>
            </Card>
            <p className="text-sm text-ink-muted">Most refills are ready in 2 business days. The status shows on the Prescriptions page.</p>
            <Link to="/prescriptions" className="inline-flex min-h-11 items-center rounded-lg border border-border bg-surface-1 px-4 text-sm font-semibold text-ink hover:bg-surface-2">
              Back to Prescriptions
            </Link>
          </div>
        )}
      </AsyncPanel>
    </>
  )
}

/* ---------- Patient Education ---------- */

const RESOURCES = [
  { id: 'medline', label: 'MedlinePlus', url: (q: string) => `https://vsearch.nlm.nih.gov/vivisimo/cgi-bin/query-meta?v%3Aproject=medlineplus&query=${encodeURIComponent(q)}` },
  { id: 'emedicine', label: 'eMedicine (Medscape)', url: (q: string) => `https://emedicine.medscape.com/search?q=${encodeURIComponent(q)}` },
  { id: 'webmd', label: 'WebMD', url: (q: string) => `https://www.webmd.com/search/search_results/default.aspx?query=${encodeURIComponent(q)}` },
]

/** The old "Web Search - Patient Document Material": choose a resource, search, opens in a new tab. */
export function PatientEducationPage() {
  const [resource, setResource] = useState('')
  const [q, setQ] = useState('')
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([])

  function submit(e: FormEvent) {
    e.preventDefault()
    const found: typeof errors = []
    if (!resource) found.push({ fieldId: 'ed-resource', message: 'Select a patient resource' })
    if (!q.trim()) found.push({ fieldId: 'ed-q', message: 'Enter what you want to search for' })
    setErrors(found)
    const r = RESOURCES.find((x) => x.id === resource)
    if (found.length || !r) return
    window.open(r.url(q.trim()), '_blank', 'noopener,noreferrer')
  }

  return (
    <>
      <PageHeader title="Patient Education" description="Search trusted patient education material." back={{ to: '/', label: 'Home' }} />
      <form noValidate onSubmit={submit} role="search" className="max-w-2xl space-y-4 rounded-2xl border border-(--accent-line) bg-surface-1 p-5 shadow-card">
        <ErrorSummary errors={errors} />
        <div className="grid gap-4 sm:grid-cols-[14rem_1fr]">
          <Field id="ed-resource" label="Patient resource" required error={errors.find((x) => x.fieldId === 'ed-resource')?.message}>
            {(p) => (
              <Select {...p} value={resource} onChange={(e) => setResource(e.target.value)}>
                <option value="">Select a resource</option>
                {RESOURCES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id="ed-q" label="Search" required error={errors.find((x) => x.fieldId === 'ed-q')?.message}>
            {(p) => <TextInput {...p} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="For example high blood pressure" />}
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" icon={<Search aria-hidden="true" size={16} />}>
            Submit<span className="sr-only"> (opens in a new tab)</span>
          </Button>
        </div>
        <p className="text-xs text-ink-subtle">
          These links go to websites run by others. We aren't responsible for their content. Talk to your provider before making changes to your care.
        </p>
      </form>
    </>
  )
}

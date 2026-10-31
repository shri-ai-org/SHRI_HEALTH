import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, etagOf, ifMatch, newIdempotencyKey } from '../../api/client'
import {
  checkPrescriptionSafety,
  createPrescription,
  getPrescription,
  listPharmacies,
  markPrescriptionEnteredInError,
  overrideAlert,
  signAndSendPrescription,
} from '../../api/generated/endpoints/medications/medications'
import { getPatient } from '../../api/generated/endpoints/patients/patients'
import type { CodeMatch, Encounter, Pharmacy, Prescription, PrescriptionCreate, SafetyAlert } from '../../api/generated/model'
import { Badge, Button, ConfirmDialog, Field, formatDateTime, Modal, ProblemAlert, Select, Spinner, Textarea, TextInput, useToast, type BadgeTone, type Problem } from '../../design-system'
import { DrugPicker, NO_DRUG, type DrugChoice } from '../clinical/DrugPicker'
import { catchProblem, Panel } from '../clinical/parts'

// ---- Drafts this tab started -----------------------------------------------------------------

/**
 * The prescriptions started on this visit in this tab, by opaque ID only (D13). The contract has
 * no "prescriptions of an encounter" read yet (asked on #93), so without this a reload would lose
 * sight of an unsigned draft. Signed ones are also on the medication list.
 */
const storageKey = (encounterId: string) => `shri.visit-prescriptions.${encounterId}`

function readIds(encounterId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(storageKey(encounterId)) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeIds(encounterId: string, ids: string[]): void {
  try {
    sessionStorage.setItem(storageKey(encounterId), JSON.stringify(ids))
  } catch {
    // Storage may be unavailable (private mode): the list still works until the page reloads.
  }
}

/** Pharmacy names by ID, for showing where a prescription goes (the prescription carries only the ID). */
type PharmacyNames = Record<string, string>

/**
 * Prescribing on the visit (demo step 9; D97, D99): an RxNorm drug, directions, quantity and the
 * pharmacy; the safety check runs on every saved draft, a `high` alert needs an override with a
 * reason, and sign-and-send signs exactly the version read and queues it for the pharmacy.
 */
export function PrescriptionsSection({ encounter, open }: { encounter: Encounter; open: boolean }) {
  const [ids, setIds] = useState<string[]>(() => readIds(encounter.id))
  const [names, setNames] = useState<PharmacyNames>({})
  const [preferred, setPreferred] = useState<{ id: string; name: string } | null>(null)
  // A prescription just created, so its card needn't read it again.
  const [fresh, setFresh] = useState<Record<string, Loaded>>({})

  useEffect(() => {
    let current = true
    getPatient(encounter.patientId)
      .then((res) => {
        const p = res.status === 200 ? res.data.preferredPharmacy : undefined
        if (!current || !p) return
        setPreferred({ id: p.id, name: p.name })
        setNames((n) => ({ ...n, [p.id]: p.name }))
      })
      // The preferred pharmacy only fills in a default; without it the prescriber searches.
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [encounter.patientId])

  function created(prescription: Prescription, etag: string | null, pharmacyName: string) {
    setFresh((f) => ({ ...f, [prescription.id]: { prescription, etag } }))
    if (prescription.pharmacyId) setNames((n) => ({ ...n, [prescription.pharmacyId!]: pharmacyName }))
    setIds((list) => {
      const next = [prescription.id, ...list.filter((id) => id !== prescription.id)]
      writeIds(encounter.id, next)
      return next
    })
  }

  function forget(id: string) {
    setIds((list) => {
      const next = list.filter((x) => x !== id)
      writeIds(encounter.id, next)
      return next
    })
  }

  return (
    <Panel title="Prescriptions" id="prescriptions-title">
      {ids.length > 0 ? (
        <ul className="space-y-4">
          {ids.map((id) => (
            <li key={id}>
              <PrescriptionCard id={id} initial={fresh[id]} timeZone={encounter.timeZone} names={names} onGone={() => forget(id)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted">No prescriptions started on this visit.</p>
      )}
      {open ? <NewPrescriptionForm encounter={encounter} preferred={preferred} onCreated={created} /> : null}
    </Panel>
  )
}

// ---- A new prescription ----------------------------------------------------------------------

/** A sensible dispense unit from RxNorm's dose form, e.g. "Oral Tablet" → tablet. */
function unitFor(match: CodeMatch | undefined): string {
  const form = match?.drug?.doseForm?.toLowerCase() ?? ''
  if (form.includes('tablet')) return 'tablet'
  if (form.includes('capsule')) return 'capsule'
  if (/solution|suspension|syrup|liquid/.test(form)) return 'mL'
  return ''
}

const pickedMatch = (d: DrugChoice) => d.matches?.find((m) => `${m.system}|${m.code}` === d.picked)

interface RxErrors {
  drug?: string | undefined
  dosageText?: string | undefined
  quantity?: string | undefined
  unit?: string | undefined
  daysSupply?: string | undefined
  refills?: string | undefined
  pharmacy?: string | undefined
}

function wholeNumber(text: string, min: number, max: number): number | null | 'invalid' {
  const t = text.trim()
  if (!t) return null
  if (!/^\d+$/.test(t)) return 'invalid'
  const n = Number(t)
  return n < min || n > max ? 'invalid' : n
}

function NewPrescriptionForm({
  encounter,
  preferred,
  onCreated,
}: {
  encounter: Encounter
  preferred: { id: string; name: string } | null
  onCreated: (p: Prescription, etag: string | null, pharmacyName: string) => void
}) {
  const toast = useToast()
  const [drug, setDrug] = useState<DrugChoice>(NO_DRUG)
  const [dosageText, setDosageText] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState('')
  const [daysSupply, setDaysSupply] = useState('')
  const [refills, setRefills] = useState('0')
  const [substitution, setSubstitution] = useState(true)
  const [note, setNote] = useState('')
  const [pharmacy, setPharmacy] = useState<{ id: string; name: string } | null>(null)
  const [errors, setErrors] = useState<RxErrors>({})
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  // One key per prescription as entered: kept while it is retried, replaced when anything changes.
  const key = useRef<string | null>(null)
  const changed = () => {
    key.current = null
  }

  const chosenPharmacy = pharmacy ?? preferred
  const match = pickedMatch(drug)

  async function save(e: FormEvent) {
    e.preventDefault()
    const found: RxErrors = {}
    if (!match) found.drug = drug.matches ? 'Choose the drug from the RxNorm matches.' : 'Search for the drug and choose it from the RxNorm matches.'
    if (!dosageText.trim()) found.dosageText = 'Write the directions, for example “Take 1 tablet by mouth twice a day”.'
    const qty = Number(quantity.trim())
    if (!quantity.trim() || !Number.isFinite(qty) || qty <= 0 || qty > 100000) found.quantity = 'Enter the amount to dispense.'
    if (!unit.trim()) found.unit = 'Enter the unit, for example tablet.'
    const days = wholeNumber(daysSupply, 1, 365)
    if (days === 'invalid') found.daysSupply = 'Enter a whole number of days from 1 to 365.'
    const refillCount = wholeNumber(refills, 0, 11)
    if (refillCount === 'invalid') found.refills = 'Enter a whole number from 0 to 11.'
    if (!chosenPharmacy) found.pharmacy = 'Choose the pharmacy.'
    setErrors(found)
    if (Object.keys(found).length > 0 || !match || !chosenPharmacy) return

    const body: PrescriptionCreate = {
      patientId: encounter.patientId,
      encounterId: encounter.id,
      medication: { codings: [{ system: match.system, code: match.code, display: match.display }], text: match.display },
      dosageText: dosageText.trim(),
      quantity: { value: qty, unit: unit.trim() },
      ...(typeof days === 'number' ? { daysSupply: days } : {}),
      refills: typeof refillCount === 'number' ? refillCount : 0,
      substitutionAllowed: substitution,
      pharmacyId: chosenPharmacy.id,
      ...(note.trim() ? { noteToPharmacy: note.trim() } : {}),
    }
    key.current ??= newIdempotencyKey()
    setBusy(true)
    setProblem(null)
    try {
      const res = await createPrescription(body, { 'Idempotency-Key': key.current })
      if (res.status === 201) {
        toast.show(`Draft for ${match.display} saved`)
        onCreated(res.data, etagOf(res), chosenPharmacy.name)
        key.current = null
        setDrug(NO_DRUG)
        setDosageText('')
        setQuantity('')
        setUnit('')
        setDaysSupply('')
        setRefills('0')
        setSubstitution(true)
        setNote('')
        setPharmacy(null)
      }
    } catch (error) {
      catchProblem(setProblem)(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void save(e)} noValidate className="space-y-4 border-t border-border pt-4">
      <h3 className="text-base font-semibold text-ink">New prescription</h3>
      {problem ? <ProblemAlert problem={problem} /> : null}
      <DrugPicker
        label="Drug"
        matchLabel="RxNorm match"
        hint="Search by name; the safety check needs the RxNorm drug"
        value={drug}
        error={errors.drug}
        onProblem={setProblem}
        onChange={(next) => {
          setDrug(next)
          setErrors((e) => ({ ...e, drug: undefined }))
          const m = pickedMatch(next)
          if (m && !unit) setUnit(unitFor(m))
          changed()
        }}
      />
      {match?.drug ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          <span>{[match.drug.strength, match.drug.doseForm, match.drug.route].filter(Boolean).join(' · ')}</span>
          {match.drug.controlledSchedule ? <Badge tone="warning">Controlled substance ({match.drug.controlledSchedule})</Badge> : null}
        </p>
      ) : null}
      <Field label="Directions" error={errors.dosageText}>
        {(p) => (
          <Textarea
            {...p}
            value={dosageText}
            limit={500}
            onChange={(e) => {
              setDosageText(e.target.value)
              changed()
            }}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Quantity" error={errors.quantity}>
          {(p) => (
            <TextInput
              {...p}
              inputMode="decimal"
              value={quantity}
              onChange={(e) => {
                setQuantity(e.target.value)
                changed()
              }}
            />
          )}
        </Field>
        <Field label="Unit" hint="For example tablet or mL" error={errors.unit}>
          {(p) => (
            <TextInput
              {...p}
              maxLength={32}
              value={unit}
              onChange={(e) => {
                setUnit(e.target.value)
                changed()
              }}
            />
          )}
        </Field>
        <Field label="Days supply" hint="Optional" error={errors.daysSupply}>
          {(p) => (
            <TextInput
              {...p}
              inputMode="numeric"
              value={daysSupply}
              onChange={(e) => {
                setDaysSupply(e.target.value)
                changed()
              }}
            />
          )}
        </Field>
        <Field label="Refills" error={errors.refills}>
          {(p) => (
            <TextInput
              {...p}
              inputMode="numeric"
              value={refills}
              onChange={(e) => {
                setRefills(e.target.value)
                changed()
              }}
            />
          )}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="size-5 accent-primary-600"
          checked={substitution}
          onChange={(e) => {
            setSubstitution(e.target.checked)
            changed()
          }}
        />
        Generic substitution allowed
      </label>
      <PharmacyChooser
        chosen={chosenPharmacy}
        isPreferred={!pharmacy && Boolean(preferred)}
        error={errors.pharmacy}
        onChoose={(p) => {
          setPharmacy(p)
          setErrors((e) => ({ ...e, pharmacy: undefined }))
          changed()
        }}
        onProblem={setProblem}
      />
      <Field label="Note to the pharmacist" hint="Optional">
        {(p) => (
          <Textarea
            {...p}
            rows={2}
            value={note}
            limit={210}
            onChange={(e) => {
              setNote(e.target.value)
              changed()
            }}
          />
        )}
      </Field>
      <Button type="submit" loading={busy}>
        Save draft and check safety
      </Button>
    </form>
  )
}

function pharmacyLine(p: Pharmacy): string {
  const where = [p.address?.line, p.address?.city, p.address?.state].filter(Boolean).join(', ')
  return `${p.name}${where ? `, ${where}` : ''}${p.mailOrder ? ' (mail order)' : ''}`
}

function PharmacyChooser({
  chosen,
  isPreferred,
  error,
  onChoose,
  onProblem,
}: {
  chosen: { id: string; name: string } | null
  isPreferred: boolean
  error?: string | undefined
  onChoose: (p: { id: string; name: string }) => void
  onProblem: (p: Problem) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Pharmacy[] | null>(null)
  const [tooShort, setTooShort] = useState(false)

  async function search() {
    const q = query.trim()
    setTooShort(q.length < 2)
    if (q.length < 2) return
    try {
      // A pharmacy name or ZIP code: reference data, no patient data (D13).
      const res = await listPharmacies(/^\d{5}$/.test(q) ? { postalCode: q, limit: 10 } : { q, limit: 10 })
      if (res.status === 200) {
        const active = res.data.items.filter((p) => p.active)
        setResults(active)
        if (active[0]) onChoose({ id: active[0].id, name: active[0].name })
      }
    } catch (e) {
      catchProblem(onProblem)(e)
    }
  }

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-ink">Pharmacy</legend>
      <p className="text-ink" aria-live="polite">
        {chosen ? (
          <>
            {chosen.name}
            {isPreferred ? <span className="text-ink-muted"> (the patient’s preferred pharmacy)</span> : null}
          </>
        ) : (
          <span className="text-ink-muted">No pharmacy chosen</span>
        )}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-critical-fg">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <Field label={chosen ? 'Another pharmacy' : 'Find a pharmacy'} hint="A name or a ZIP code" error={tooShort ? 'Enter at least 2 characters.' : undefined}>
            {(p) => (
              <TextInput
                {...p}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setTooShort(false)
                }}
              />
            )}
          </Field>
        </div>
        <Button variant="outline" onClick={() => void search()}>
          Search pharmacies
        </Button>
      </div>
      {results ? (
        results.length === 0 ? (
          <p className="text-sm text-ink-muted">No active pharmacies match.</p>
        ) : (
          <Field label="Matching pharmacies">
            {(p) => (
              <Select
                {...p}
                value={chosen?.id ?? ''}
                onChange={(e) => {
                  const found = results.find((r) => r.id === e.target.value)
                  if (found) onChoose({ id: found.id, name: found.name })
                }}
              >
                {results.map((r) => (
                  <option key={r.id} value={r.id}>
                    {pharmacyLine(r)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )
      ) : null}
    </fieldset>
  )
}

// ---- One prescription ------------------------------------------------------------------------

const SEVERITY: Record<SafetyAlert['severity'], { label: string; tone: BadgeTone }> = {
  high: { label: 'High', tone: 'critical' },
  warning: { label: 'Warning', tone: 'warning' },
  info: { label: 'Info', tone: 'info' },
}

const KIND: Record<string, string> = { allergy: 'Allergy', 'duplicate-medication': 'Duplicate medication' }

const TRANSMISSION: Record<Prescription['transmission']['status'], { label: string; tone: BadgeTone }> = {
  'not-sent': { label: 'Not sent', tone: 'neutral' },
  queued: { label: 'Queued for the pharmacy', tone: 'info' },
  sent: { label: 'Sent to the pharmacy', tone: 'info' },
  accepted: { label: 'Accepted by the pharmacy', tone: 'success' },
  rejected: { label: 'Rejected by the pharmacy', tone: 'critical' },
  error: { label: 'Sending failed', tone: 'critical' },
}

interface Loaded {
  prescription: Prescription
  etag: string | null
}

/** What the sign refusal's errors say, by field and by alert (`/alerts/{i}` indexes the prescription's alerts). */
function signRefusal(problem: Problem | null, rx: Prescription): { stale: boolean; missing: string[]; alerts: Set<string> } {
  const out = { stale: false, missing: [] as string[], alerts: new Set<string>() }
  for (const e of problem?.errors ?? []) {
    const pointer = e.pointer ?? ''
    if (e.code === 'safety-check-stale') out.stale = true
    else if (e.code === 'override-required') {
      const alert = rx.alerts[Number(/^\/alerts\/(\d+)$/.exec(pointer)?.[1] ?? -1)]
      if (alert) out.alerts.add(alert.id)
    } else if (e.code === 'required') out.missing.push({ '/dosageText': 'directions', '/quantity': 'quantity', '/pharmacyId': 'pharmacy' }[pointer] ?? pointer)
  }
  return out
}

function PrescriptionCard({
  id,
  initial,
  timeZone,
  names,
  onGone,
}: {
  id: string
  initial: Loaded | undefined
  timeZone: string
  names: PharmacyNames
  onGone: () => void
}) {
  const toast = useToast()
  const [loaded, setLoaded] = useState<Loaded | null>(initial ?? null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [signProblem, setSignProblem] = useState<Problem | null>(null)
  const [checking, setChecking] = useState(false)
  const [signing, setSigning] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  // One key per sign-and-send of one version: kept while it is retried.
  const signKey = useRef<{ etag: string; key: string } | null>(null)

  async function reload(): Promise<Loaded | null> {
    try {
      const res = await getPrescription(id)
      if (res.status !== 200) return null
      const next = { prescription: res.data, etag: etagOf(res) }
      setLoaded(next)
      return next
    } catch (error) {
      // A prescription that's no longer visible here (another clinic, or gone) leaves the list.
      if (error instanceof ApiError && error.status === 404) onGone()
      else catchProblem(setProblem)(error)
      return null
    }
  }

  async function check() {
    setChecking(true)
    setProblem(null)
    setSignProblem(null)
    try {
      await checkPrescriptionSafety(id)
      // Read it again: the alerts are stored on the draft, with their indexes and `safetyCheckedAt`.
      await reload()
    } catch (error) {
      catchProblem(setProblem)(error)
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    let current = true
    const first: Promise<Loaded | null> = initial
      ? Promise.resolve(initial)
      : getPrescription(id).then((res) => (res.status === 200 ? { prescription: res.data, etag: etagOf(res) } : null))
    first
      .then((l) => {
        if (!current || !l) return
        if (!initial) setLoaded(l)
        // Every saved draft is checked; an open draft already checked shows its alerts as stored.
        if (l.prescription.status === 'draft' && !l.prescription.safetyCheckedAt) void check()
      })
      .catch((error: unknown) => {
        if (!current) return
        if (error instanceof ApiError && error.status === 404) onGone()
        else catchProblem(setProblem)(error)
      })
    return () => {
      current = false
    }
    // Runs once per card: the check and reload are this card's own actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function sign() {
    setConfirm(false)
    if (!loaded?.etag) return
    if (signKey.current?.etag !== loaded.etag) signKey.current = { etag: loaded.etag, key: newIdempotencyKey() }
    setSigning(true)
    setProblem(null)
    setSignProblem(null)
    try {
      const res = await signAndSendPrescription(id, { ...ifMatch(loaded.etag), 'Idempotency-Key': signKey.current.key })
      if (res.status === 200) {
        toast.show('Signed and sent to the pharmacy')
        setLoaded({ prescription: res.data, etag: etagOf(res) })
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) setSignProblem(error.problem)
      else catchProblem(setProblem)(error)
      if (error instanceof ApiError && error.status === 412) void reload()
    } finally {
      setSigning(false)
    }
  }

  if (!loaded) return problem ? <ProblemAlert problem={problem} /> : <Spinner label="Loading the prescription" />
  const rx = loaded.prescription
  const draft = rx.status === 'draft'
  const refusal = signRefusal(signProblem, rx)
  const name = rx.medication.text ?? rx.medication.codings?.[0]?.display ?? 'Prescription'
  const pharmacy = rx.pharmacyId ? (names[rx.pharmacyId] ?? 'The chosen pharmacy') : 'No pharmacy'
  // Alerts count only from a check of this version; a changed draft (no `safetyCheckedAt`) is checked again first.
  const needsOverride = Boolean(rx.safetyCheckedAt) && rx.alerts.some((a) => a.overrideRequired && !a.override)

  return (
    <article aria-label={name} className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-ink">{name}</h3>
        {draft ? <Badge tone="warning">Draft</Badge> : rx.status === 'active' ? <Badge tone="success">Signed</Badge> : <Badge tone="neutral">{rx.status}</Badge>}
        {!draft ? <Badge tone={TRANSMISSION[rx.transmission.status].tone}>{TRANSMISSION[rx.transmission.status].label}</Badge> : null}
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="inline font-semibold text-ink">Directions: </dt>
          <dd className="inline text-ink">{rx.dosageText ?? '—'}</dd>
        </div>
        <div>
          <dt className="inline font-semibold text-ink">Quantity: </dt>
          <dd className="inline text-ink">
            {rx.quantity ? `${rx.quantity.value} ${rx.quantity.unit}` : '—'}
            {rx.daysSupply ? `, ${rx.daysSupply} days` : ''}
            {`, ${rx.refills ?? 0} refill${rx.refills === 1 ? '' : 's'}`}
            {rx.substitutionAllowed === false ? ', no substitution' : ''}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold text-ink">Pharmacy: </dt>
          <dd className="inline text-ink">{pharmacy}</dd>
        </div>
        {rx.signedAt ? (
          <div>
            <dt className="inline font-semibold text-ink">Signed: </dt>
            <dd className="inline text-ink">{formatDateTime(rx.signedAt, timeZone)}</dd>
          </div>
        ) : null}
      </dl>
      {rx.transmission.status === 'rejected' || rx.transmission.status === 'error' ? (
        <p className="text-sm text-critical-fg">{rx.transmission.message ?? 'The pharmacy did not take this prescription. Call the pharmacy, or start a new one.'}</p>
      ) : null}
      {problem ? <ProblemAlert problem={problem} /> : null}

      {draft ? (
        <SafetyAlerts rx={rx} checking={checking} mustOverride={refusal.alerts} onOverridden={() => void reload()} />
      ) : rx.alerts.length > 0 ? (
        <p className="text-sm text-ink-muted">
          Signed with {rx.alerts.length} safety alert{rx.alerts.length === 1 ? '' : 's'} reviewed.
        </p>
      ) : null}

      {signProblem ? (
        <div role="alert" className="rounded-lg border border-critical-fg/40 bg-critical-bg p-3 text-sm text-critical-fg">
          <p className="font-semibold">Not signed yet</p>
          <ul className="mt-1 list-disc pl-5">
            {refusal.stale ? <li>The safety check is out of date for this version. Run it again.</li> : null}
            {refusal.alerts.size > 0 ? <li>Override each high alert with a reason first.</li> : null}
            {refusal.missing.length > 0 ? <li>Add the {refusal.missing.join(', ')}.</li> : null}
            {!refusal.stale && refusal.alerts.size === 0 && refusal.missing.length === 0 ? <li>{signProblem.code === 'idempotency-key-reused' ? 'Try signing again.' : 'Check the prescription and try again.'}</li> : null}
          </ul>
          {signProblem.requestId ? <p className="mt-1 text-xs opacity-80">Reference: {signProblem.requestId}</p> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {draft ? (
          <>
            <Button loading={signing} disabled={checking || needsOverride || !rx.safetyCheckedAt} onClick={() => setConfirm(true)}>
              Sign and send
            </Button>
            <Button variant="outline" loading={checking} onClick={() => void check()}>
              Run safety check again
            </Button>
            <Button variant="ghost" onClick={() => setDiscarding(true)}>
              Discard draft
            </Button>
          </>
        ) : rx.transmission.status === 'queued' || rx.transmission.status === 'sent' ? (
          <Button variant="outline" onClick={() => void reload()}>
            Refresh status
          </Button>
        ) : null}
        {draft && needsOverride ? <span className="text-sm text-ink-muted">Override the high alert to sign.</span> : null}
      </div>

      <ConfirmDialog open={confirm} title="Sign and send this prescription?" confirmLabel="Sign and send" onConfirm={() => void sign()} onCancel={() => setConfirm(false)}>
        <p className="text-ink">
          {name} goes to {pharmacy}. Once signed it can’t be edited; a change or cancellation is a new message to the pharmacy.
        </p>
      </ConfirmDialog>
      {discarding ? (
        <DiscardDialog
          prescription={rx}
          name={name}
          onClose={() => setDiscarding(false)}
          onDiscarded={() => {
            setDiscarding(false)
            onGone()
          }}
        />
      ) : null}
    </article>
  )
}

function SafetyAlerts({ rx, checking, mustOverride, onOverridden }: { rx: Prescription; checking: boolean; mustOverride: Set<string>; onOverridden: () => void }) {
  if (checking) return <Spinner label="Running the safety check" />
  if (!rx.safetyCheckedAt) return <p className="text-sm text-ink-muted">Not checked on this version yet. Run the safety check to sign.</p>
  if (rx.alerts.length === 0) return <p className="text-sm text-success-fg">Safety check passed: no allergy or duplicate-medication alerts.</p>
  return (
    <section aria-label="Safety alerts" className="space-y-2">
      <h4 className="text-sm font-semibold text-ink">Safety alerts</h4>
      <ul className="space-y-2">
        {rx.alerts.map((a) => (
          <li key={a.id} className="space-y-2 rounded-lg border border-border bg-surface-2 p-3">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={SEVERITY[a.severity].tone}>{SEVERITY[a.severity].label}</Badge>
              <span className="font-semibold text-ink">{KIND[a.kind] ?? a.kind}</span>
              <span className="text-ink">{a.message}</span>
            </p>
            {a.override ? (
              <p className="text-sm text-ink-muted">Overridden: {a.override.reason}</p>
            ) : a.overrideRequired ? (
              <OverrideForm alert={a} highlighted={mustOverride.has(a.id)} onOverridden={onOverridden} />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function OverrideForm({ alert, highlighted, onOverridden }: { alert: SafetyAlert; highlighted: boolean; onOverridden: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!reason.trim()) {
      setError('Give the reason for going ahead.')
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const res = await overrideAlert(alert.id, { reason: reason.trim() })
      if (res.status === 200) {
        toast.show('Alert overridden')
        onOverridden()
      }
    } catch (error) {
      catchProblem(setProblem)(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-2">
      {problem ? <ProblemAlert problem={problem} /> : null}
      <Field label="Reason to go ahead" hint="Required for a high alert; it is kept with the prescription" error={error ?? (highlighted ? 'Override this alert before signing.' : undefined)}>
        {(p) => (
          <Textarea
            {...p}
            rows={2}
            value={reason}
            limit={500}
            onChange={(e) => {
              setReason(e.target.value)
              setError(undefined)
            }}
          />
        )}
      </Field>
      <Button type="submit" size="sm" variant="outline" loading={busy}>
        Override alert
      </Button>
    </form>
  )
}

function DiscardDialog({ prescription, name, onClose, onDiscarded }: { prescription: Prescription; name: string; onClose: () => void; onDiscarded: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  async function discard() {
    if (!reason.trim()) {
      setError('Give the reason for discarding it.')
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      const res = await markPrescriptionEnteredInError(prescription.id, { reason: reason.trim() })
      if (res.status === 200) {
        toast.show(`Draft for ${name} discarded`)
        onDiscarded()
      }
    } catch (e) {
      catchProblem(setProblem)(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title="Discard this draft?"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void discard()}>
            Discard draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-ink">The draft for {name} is marked entered in error with your reason. Nothing is deleted, and nothing goes to the pharmacy.</p>
        {problem ? <ProblemAlert problem={problem} /> : null}
        <Field label="Reason" error={error}>
          {(p) => (
            <Textarea
              {...p}
              value={reason}
              limit={500}
              onChange={(e) => {
                setReason(e.target.value)
                setError(undefined)
              }}
            />
          )}
        </Field>
      </div>
    </Modal>
  )
}

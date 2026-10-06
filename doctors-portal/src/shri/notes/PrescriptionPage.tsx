/**
 * S-06-07 · Prescription — `/encounter/:id/rx` (`src/screens/m06/S0607.tsx`):
 * "Prescribing — and the one screen where the AI is visibly overruled."
 *
 * Three things are true in the code, not just in the copy:
 *   1. The hard stop is computed from the allergy record and the drug class.
 *      It does not consult a confidence score, and it fires with the AI off.
 *   2. Sign cannot be reached while a hard stop is outstanding — the gate modal
 *      is not dismissible without a disposition.
 *   3. An override needs a reason AND a second consultant's authentication, and
 *      records both identities.
 *
 * Where the old screen fell short, this one holds the rule it states: an
 * override clears only the line it was signed for; added lines and every
 * change to a line are kept on the prescription, so what is signed is what was
 * shown; a line's completeness gap clears once the line states what it lacks;
 * the override, each hard-stop disposition and the signature are audited; and
 * the AI-206 dose suggestion gates Sign only while the AI is live to show it.
 */

import { ArrowRight, CircleAlert, CircleDot, FileText, Lock, OctagonAlert, Pill as PillIcon, Printer, ShieldAlert, ShieldCheck, Signature, Trash2, Check } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { can, canPrescribe } from '@/atlas/personas'
import { FORMULARY, PENICILLIN_HARD_STOP, type Encounter } from '@/data/clinical'
import { NOW, formatDateTime, formatRupees, formatTime } from '@/data/format'
import type { IcdCode } from '@/data/icd10'
import { STAFF, patient } from '@/data/kit'
import { useOutstanding } from '@/store/ai'
import { useAudit } from '@/store/audit'
import { useClinical, type RxLineEdit } from '@/store/clinical'
import { useCurrentStaff, useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { encounterLabel, maybeEncounter } from '../logic/encounter'
import { useProblemsFor } from '../logic/record'
import { DURATIONS, ROUTE_FREQUENCIES, basketFor, hardStopFor, newLine, proposedBasket, type BasketLine } from '../logic/rx'
import { useAiActive, useForcedState } from '../state/ai'
import { devOpens } from '../state/store'
import { FieldChip, SuggestionCard } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Why } from '../ui/Disclosure'
import { EmptyState } from '../ui/EmptyState'
import { Field, Select, TextInput } from '../ui/forms'
import { DualSignatureGate, HardStopGate, type DualSignature } from '../ui/gates'
import { IcdField } from '../ui/IcdPicker'
import { Card, Diamond, Hairline, Icon, Pill, PillTag, Toggle } from '../ui/primitives'
import { PrintPreview } from '../ui/PrintPreview'
import { LockedBanner, ValidationSummary } from '../ui/states'
import { VoiceField } from '../ui/VoiceField'

import { NoSuchEncounter } from './ConsultationPage'

export function PrescriptionPage() {
  const { id } = useParams()
  const enc = maybeEncounter(id)
  if (!enc) return <NoSuchEncounter id={id} screenId="S-06-07" />
  return <Prescription key={enc.id} enc={enc} />
}

/** The first line the rule still blocks — where a DEV `?open=hardstop` or `override` lands. */
function firstUnresolved(enc: Encounter): string | null {
  const p = patient(enc.patientId)
  const lines = basketFor(proposedBasket(p.id), useClinical.getState().rx(enc.id), p.allergies)
  return lines.find((l) => l.stop && !l.override)?.id ?? null
}

function Prescription({ enc }: { enc: Encounter }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const persona = useSession((s) => s.persona)
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const aiActive = useAiActive()
  const forced = useForcedState()

  const rx = useClinical((s) => s.rx)
  // Subscribing to the prescriptions map re-renders on every change to this encounter's record.
  useClinical((s) => s.prescriptions[enc.id])
  const signRx = useClinical((s) => s.signRx)
  const addRxLine = useClinical((s) => s.addRxLine)
  const editRxLine = useClinical((s) => s.editRxLine)
  const removeRxLine = useClinical((s) => s.removeRxLine)
  const substitute = useClinical((s) => s.substitute)
  const overrideHardStop = useClinical((s) => s.overrideHardStop)

  const p = patient(enc.patientId)
  const problemList = useProblemsFor(p.id)
  const record = rx(enc.id)

  /** The line the hard-stop gate is open for, and the line whose override is being signed. */
  const [gateFor, setGateFor] = useState<string | null>(() => (devOpens('hardstop') ? firstUnresolved(enc) : null))
  const [dualFor, setDualFor] = useState<string | null>(() => (devOpens('override') ? firstUnresolved(enc) : null))
  const [confirmSign, setConfirmSign] = useState(false)
  const [search, setSearch] = useState('')
  const [showValidation, setShowValidation] = useState(false)
  const [printOpen, setPrintOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const mayPrescribe = canPrescribe(persona)
  const mayOverride = can(persona, 'rx.override')
  const locked = record.status === 'signed' || forced === 'LOCKED'

  /** Recomputed from the rule on every render — never cached from the seed. */
  const basket = basketFor(proposedBasket(p.id), record, p.allergies)
  // The patient's open diagnoses, offered as each line's indication; the lines already coded, for the audit.
  const diagnosisChips = problemList.filter((pr) => pr.status === 'Open' && pr.leaf).map((pr) => ({ code: pr.icd10, label: pr.label }))
  const coded = basket.filter((l) => l.indicationCode)
  const unresolved = basket.filter((l) => l.stop && !l.override)
  const overridden = basket.filter((l) => l.stop && l.override)
  const outstandingStop = unresolved.length > 0
  const incomplete = basket.filter((l) => l.gaps.length > 0)

  // G2 — each renal suggestion needs a decision before Sign, while the AI is live to show it.
  // Subscribed, so deciding the last one enables Sign without an unrelated re-render.
  const outstanding = useOutstanding(aiActive ? basket.filter((l) => l.doseAdjustment).map((l) => `${enc.id}:dose:${l.id}`) : [])

  /** Every rule that holds Sign back, in the order they matter. Empty ⇒ Sign may proceed. */
  const problems: { field: string; message: string; target: string }[] = []
  for (const l of unresolved) problems.push({ field: l.drug, message: 'Resolve the hard stop first', target: `${enc.id}:${l.id}` })
  if (outstanding > 0) {
    const first = basket.find((l) => l.doseAdjustment)
    problems.push({
      field: 'Dose',
      message: `${outstanding} dose ${outstanding === 1 ? 'adjustment needs' : 'adjustments need'} a decision`,
      target: `${enc.id}:${first?.id ?? ''}`,
    })
  }
  for (const l of incomplete) for (const g of l.gaps) problems.push({ field: l.drug, message: g, target: `${enc.id}:${l.id}` })
  if (basket.length === 0) {
    problems.push({ field: 'Prescription', message: 'Nothing prescribed yet. Search the formulary on the left and press Enter to add the first item.', target: `${enc.id}:formulary` })
  }
  if (!mayPrescribe) problems.push({ field: 'Signing', message: 'This persona may draft, not sign — controlled classes need a consultant', target: `${enc.id}:formulary` })
  const canSign = !locked && problems.length === 0

  const matches = search.trim() ? FORMULARY.filter((f) => f.drug.toLowerCase().includes(search.trim().toLowerCase())) : FORMULARY.slice(0, 6)
  const gateLine = unresolved.find((l) => l.id === gateFor)
  const dualLine = unresolved.find((l) => l.id === dualFor)
  const note = `/encounter/${enc.id}/note`

  // "`/` focuses search" — the formulary's, on this screen; an open dialog keeps the keyboard.
  useEffect(() => {
    if (locked) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT' || t?.isContentEditable) return
      if (document.querySelector('[role=dialog], [role=alertdialog]')) return
      e.preventDefault()
      e.stopPropagation()
      searchRef.current?.focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [locked])

  function addDrug(drug: string) {
    if (locked) return
    const entry = FORMULARY.find((f) => f.drug === drug)
    const lineId = addRxLine(enc.id, newLine(drug))
    setSearch('')
    if (!lineId) return
    if (hardStopFor(drug, p.allergies)) {
      setGateFor(lineId)
    } else if (entry?.nlem) {
      toast({ tone: 'info', title: `${drug} is on the NLEM`, detail: `DPCO ceiling ${formatRupees(entry.ceilingPrice)}. Substitution is permitted by default.` })
    }
  }

  function takeAlternative(line: BasketLine, drug: string) {
    substitute(enc.id, line.id, drug)
    setGateFor(null)
    audit({ event: 'RX.HARD_STOP_RESOLVED', actor: me.name, actorId: me.id, subject: p.id, detail: `${line.drug} replaced by ${drug} · no beta-lactam cross-reactivity · ${encounterLabel(enc)}` })
    toast({ tone: 'success', title: `${drug} substituted`, detail: 'No beta-lactam cross-reactivity. No override was needed.' })
  }

  function removeLine(line: BasketLine) {
    removeRxLine(enc.id, line.id)
    setGateFor(null)
    // Removing a blocked drug is one of the hard stop's three dispositions, wherever it is pressed.
    if (line.stop && !line.override) {
      audit({ event: 'RX.HARD_STOP_RESOLVED', actor: me.name, actorId: me.id, subject: p.id, detail: `${line.drug} removed from the prescription · ${encounterLabel(enc)}` })
    }
    toast({ tone: 'info', title: `${line.drug} removed from the prescription` })
  }

  function signOverride(line: BasketLine, sig: DualSignature) {
    const auditEvent = line.stop?.auditEvent ?? PENICILLIN_HARD_STOP.auditEvent
    overrideHardStop({ encounterId: enc.id, lineId: line.id, reason: sig.reason, reasonText: sig.reasonText, prescriber: me.name, coSigner: sig.coSigner, auditEvent })
    setDualFor(null)
    audit({
      event: 'AI.SAF.HARD_STOP_OVERRIDDEN',
      actor: me.name,
      actorId: me.id,
      subject: p.id,
      gate: 'G4',
      detail: `${line.drug} · ${sig.reason}: “${sig.reasonText}” · second consultant ${sig.coSigner} · ${encounterLabel(enc)}`,
    })
    toast({ tone: 'critical', title: 'Hard stop overridden', detail: `${auditEvent} emitted. Both identities recorded. Reviewed within 24 hours.` })
  }

  function doSign() {
    setConfirmSign(false)
    // Held to the same rules at the moment of commit.
    if (!canSign) {
      setShowValidation(true)
      return
    }
    signRx({ encounterId: enc.id, by: me.name, registrationNo: me.identifier })
    audit({
      event: 'RX.SIGNED',
      actor: me.name,
      actorId: me.id,
      subject: p.id,
      detail: `${basket.length} ${basket.length === 1 ? 'item' : 'items'} · ${encounterLabel(enc)}${overridden.length > 0 ? ` · ${overridden.length} past a hard stop, dual-signed` : ''}${coded.length > 0 ? ` · indications ICD-10 ${coded.map((l) => `${l.drug}: ${l.indicationCode!.code}`).join('; ')}` : ''}`,
    })
    toast({ tone: 'success', title: 'Prescription signed', detail: `HPR ${me.identifier} printed on it. Now in the pharmacy queue.` })
  }

  const items = `${basket.length} ${basket.length === 1 ? 'item' : 'items'} · ${p.payer}`
  const ceilingLines = basket.filter((l) => l.prn && l.maxDaily.trim() === '')

  return (
    <>
      <ScreenFrame
        screenId="S-06-07"
        patient={p}
        heading="Prescription"
        sub={`${items}${incomplete.length > 0 ? ` · ${incomplete.length} incomplete` : ''}`}
        chips={
          <>
            <PillTag tone={locked ? 'neu' : 'warn'} size="sm" icon={locked ? Lock : PillIcon}>
              {locked ? 'Signed' : 'Draft'}
            </PillTag>
            {outstandingStop && (
              <PillTag tone="crit" size="sm" icon={OctagonAlert}>
                Hard stop outstanding
              </PillTag>
            )}
            {overridden.length > 0 && (
              <PillTag tone="crit" size="sm" icon={ShieldAlert}>
                Overridden · dual signature
              </PillTag>
            )}
          </>
        }
        actions={
          may(note) && (
            <Pill variant="card" size="xl" icon={FileText} iconSize={17} onClick={() => navigate(note)}>
              Back to the note
            </Pill>
          )
        }
        rail={<RxRail encounterId={enc.id} ceilingLines={ceilingLines.length} />}
        railTitle="Checks & suggestions"
        railBadge={aiActive && ceilingLines.length > 0 ? 1 : undefined}
        actionBar={
          locked ? (
            <>
              <span className="flex items-center gap-[8px] text-[13px] tabular-nums text-sh-text-2">
                <Icon icon={Lock} size={14} />
                Signed by {record.signedBy ?? me.name} · {record.registrationNo ?? me.identifier}
                {record.signedAt && ` · ${formatDateTime(new Date(record.signedAt))}`}
              </span>
              <div className="ml-auto flex flex-wrap gap-[8px]">
                <Pill variant="control" size="lg" icon={Printer} onClick={() => setPrintOpen(true)}>
                  Print A5, bilingual
                </Pill>
                <Pill variant="primary" size="lg" icon={ArrowRight} onClick={() => navigate('/')}>
                  Done
                </Pill>
              </div>
            </>
          ) : (
            <>
              <span className="text-[13px] tabular-nums text-sh-text-2">{items}</span>
              <div className="ml-auto flex flex-wrap items-center gap-[12px]">
                {outstandingStop ? (
                  <span className="flex items-center gap-[6px] text-[13px] font-semibold text-sh-crit-fg">
                    <Icon icon={OctagonAlert} size={14} />
                    Resolve the hard stop first
                  </span>
                ) : outstanding > 0 ? (
                  <span className="text-[13px] font-medium text-sh-warn-fg">
                    {outstanding} dose {outstanding === 1 ? 'adjustment needs' : 'adjustments need'} a decision
                  </span>
                ) : incomplete.length > 0 ? (
                  <span className="text-[13px] font-medium text-sh-warn-fg">{incomplete.length} incomplete</span>
                ) : null}
                {!mayPrescribe && <span className="text-[13px] font-medium text-sh-warn-fg">This persona may draft, not sign — controlled classes need a consultant</span>}
                <Pill
                  variant="primary"
                  size="lg"
                  icon={Signature}
                  // Disabled until every rule clears; pressed while disabled-looking it says why, so the reason is never hidden.
                  aria-disabled={!canSign}
                  title={canSign ? undefined : 'No hard stop outstanding, every dose decision made, and every line complete'}
                  className={cn(!canSign && 'opacity-40')}
                  onClick={() => {
                    if (!canSign) {
                      setShowValidation(true)
                      return
                    }
                    setConfirmSign(true)
                  }}
                >
                  Sign prescription
                </Pill>
              </div>
            </>
          )
        }
      >
        {locked && <LockedBanner by={record.signedBy ?? me.name} at={record.signedAt ? formatDateTime(new Date(record.signedAt)) : formatTime(NOW)} reason="signed" />}

        {!locked && (showValidation || forced === 'VALIDATION') && problems.length > 0 && (
          <ValidationSummary problems={problems} onFocusFirst={() => document.getElementById(problems[0].target)?.scrollIntoView({ block: 'center' })} />
        )}

        {/* The one place the block is stated on the page. The gate carries the finding, the rule and the
            alternatives; this line carries the state and the way back into the gate. */}
        {unresolved.map((l) => (
          <Alert
            key={l.id}
            tone="crit"
            role="alert"
            icon={OctagonAlert}
            title={`${l.drug} is blocked for this patient`}
            action={
              !locked && (
                <Pill variant="crit" size="md" icon={OctagonAlert} onClick={() => setGateFor(l.id)}>
                  Resolve
                </Pill>
              )
            }
          >
            Documented allergy. A rule, not a model output{aiActive ? '' : ' — the AI is currently off and it fired anyway'}.
          </Alert>
        ))}

        {overridden.map((l) => (
          <Alert key={l.id} tone="crit" icon={ShieldAlert} title="Hard stop overridden with a dual signature">
            <div className="flex flex-col gap-[2px]">
              <span className="font-semibold text-sh-text">{l.drug}</span>
              <span>Prescriber: {l.override?.prescriber}</span>
              <span>Second consultant: {l.override?.coSigner}</span>
              <span>Reason: {l.override?.reason}</span>
              {l.override?.reasonText && <span>&ldquo;{l.override.reasonText}&rdquo;</span>}
              <span className="tabular-nums">
                <code className="font-mono text-[12px] text-sh-text">{l.override?.auditEvent}</code> · {l.override && formatDateTime(new Date(l.override.at))} · reviewed within 24
                hours
              </span>
            </div>
          </Alert>
        ))}

        {/* ARC-07 — the catalogue and the basket side by side once there is room for both. */}
        <div className="grid grid-cols-1 gap-[16px] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] xl:items-start">
          <Card titleSize="sm" title="Formulary" headerClassName="mb-[4px]" id={`${enc.id}:formulary`}>
            <p className="mb-[12px] text-[12px] text-sh-text-3">
              <kbd className="rounded-[6px] bg-sh-control px-[6px] py-[1px] font-sans text-[11px] font-semibold text-sh-text-2">/</kbd> focuses search · Enter adds to the
              basket
            </p>
            <TextInput
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && matches[0]) {
                  e.preventDefault()
                  addDrug(matches[0].drug)
                }
              }}
              aria-label="Search the formulary"
              placeholder="Search the formulary…"
              autoComplete="off"
              disabled={locked}
            />
            <ul className="mt-[10px] flex flex-col gap-[2px]" aria-label="Formulary matches">
              {matches.length === 0 && <li className="px-[12px] py-[10px] text-[13px] text-sh-text-3">No drug in the formulary matches “{search.trim()}”.</li>}
              {matches.map((f) => {
                const wouldBlock = hardStopFor(f.drug, p.allergies) !== undefined
                const listing = `${f.nlem ? 'NLEM-listed' : 'Not on the NLEM'} · DPCO ceiling ${formatRupees(f.ceilingPrice)}`
                return (
                  <li key={f.drug}>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => addDrug(f.drug)}
                      // The listing and ceiling live on hover (and for a screen reader); the toast repeats them on add.
                      title={listing}
                      className="flex min-h-[44px] w-full items-center gap-[10px] rounded-[12px] px-[12px] py-[8px] text-left transition-colors duration-150 hover:bg-sh-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Icon icon={PillIcon} size={15} className="shrink-0 text-sh-text-3" />
                      <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-sh-text">{f.drug}</span>
                      <span className="sr-only">
                        {' '}
                        · {listing}
                        {wouldBlock ? ' · blocked, contraindicated by a documented allergy' : ''}
                      </span>
                      {wouldBlock && (
                        <PillTag tone="crit" size="xs" icon={OctagonAlert} className="font-semibold" title="Contraindicated by a documented allergy" aria-hidden="true">
                          blocked
                        </PillTag>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
            <Why label="Pricing and substitution" className="mt-[8px]">
              <p>
                An NLEM-listed equivalent is prompted as a substitution, and the DPCO ceiling is shown rather than the sticker price (CMP-DRUG-03). Hover a drug for its listing
                and ceiling.
              </p>
            </Why>
          </Card>

          <Card titleSize="sm" title="Prescription" headerClassName="mb-[4px]">
            <p className="mb-[12px] text-[12px] tabular-nums text-sh-text-3">{[p.name, p.weightKg !== undefined && `${p.weightKg} kg`, p.payer].filter(Boolean).join(' · ')}</p>
            {basket.length === 0 ? (
              <EmptyState icon={PillIcon} why="Nothing prescribed yet. Search the formulary on the left and press Enter to add the first item." />
            ) : (
              <>
                <ul className="flex flex-col gap-[12px]">
                  {basket.map((line) => (
                    <RxLineCard
                      key={line.id}
                      line={line}
                      encounterId={enc.id}
                      weightKg={p.weightKg}
                      locked={locked}
                      diagnoses={diagnosisChips}
                      onEdit={(patch) => editRxLine(enc.id, line.id, patch)}
                      onRemove={() => removeLine(line)}
                    />
                  ))}
                </ul>
                {/* AI-305's caveat, once for the basket rather than once per line. */}
                {incomplete.length > 0 && (
                  <p className="mt-[12px] flex items-start gap-[8px] px-[4px] text-[12px]/[1.5] text-sh-text-3">
                    {aiActive && <Diamond className="mt-[3px] shrink-0" />}
                    Completeness checks come from static dose tables and run with the model off. Sign enables once every line is complete.
                  </p>
                )}
              </>
            )}
          </Card>
        </div>
      </ScreenFrame>

      {/* AIP-09 — not dismissible without a disposition. */}
      <HardStopGate
        open={gateLine !== undefined}
        capabilityId="AI-205"
        drug={gateLine?.drug ?? ''}
        rule={gateLine?.stop?.rule ?? PENICILLIN_HARD_STOP.rule}
        finding={gateLine?.stop?.finding ?? PENICILLIN_HARD_STOP.finding}
        documentedAt={gateLine?.stop?.documentedAt ?? PENICILLIN_HARD_STOP.documentedAt}
        documentedBy={gateLine?.stop?.documentedBy ?? PENICILLIN_HARD_STOP.documentedBy}
        alternatives={gateLine?.stop?.alternatives ?? PENICILLIN_HARD_STOP.alternatives}
        overrideBlocked={mayOverride ? undefined : 'Overriding a hard stop needs the rx.override capability, which this role does not hold. Choose an alternative or remove the drug.'}
        onAcceptAlternative={(drug) => gateLine && takeAlternative(gateLine, drug)}
        onOverride={() => {
          if (!gateLine || !mayOverride) return
          setGateFor(null)
          setDualFor(gateLine.id)
        }}
        onCancel={() => gateLine && removeLine(gateLine)}
      />

      {/* G4 — reason AND a second consultant, both identities recorded. */}
      <DualSignatureGate
        open={dualLine !== undefined && mayOverride}
        what={`You are prescribing ${dualLine?.drug ?? 'a contraindicated drug'} to a patient with a documented penicillin allergy.`}
        auditEvent={dualLine?.stop?.auditEvent ?? PENICILLIN_HARD_STOP.auditEvent}
        prescriber={me.name}
        coSignerOptions={STAFF.filter((s) => s.identifierKind === 'HPR').map((s) => ({ name: s.name, identifier: s.identifier }))}
        onCancel={() => {
          setDualFor(null)
          if (dualLine) setGateFor(dualLine.id)
        }}
        onConfirm={(sig) => dualLine && signOverride(dualLine, sig)}
      />

      <ConfirmDialog
        open={confirmSign}
        title="Sign this prescription?"
        consequence={`Signing is irreversible. The prescription is committed with your name and ${me.identifierKind} ${me.identifier}, printed bilingually on A5, sent to the pharmacy dispensing queue, and queued to publish to ABDM.`}
        confirmLabel="Sign prescription"
        onConfirm={doSign}
        onCancel={() => setConfirmSign(false)}
      />

      <PrintPreview
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        title="Prescription"
        patient={p}
        paper="A5"
        meta={`${encounterLabel(enc)} · ${record.signedBy ?? me.name} · ${me.identifierKind} ${record.registrationNo ?? me.identifier}${record.signedAt ? ` · ${formatDateTime(new Date(record.signedAt))}` : ''}`}
        sections={[
          ...basket.map((l, i) => ({
            heading: `${i + 1}. ${l.drug}`,
            body: [
              [
                l.dose,
                l.routeFrequency,
                `${l.durationDays} days`,
                l.prn && l.maxDaily.trim() && `at most ${l.maxDaily.trim()} in 24 hours`,
                l.substitutionAllowed ? 'Substitution allowed' : 'Substitution not allowed',
              ]
                .filter(Boolean)
                .join(' · '),
              l.indication ? `For ${l.indication}` : '',
              l.instructions ?? '',
            ]
              .filter((s) => s.trim() !== '')
              .join('\n\n'),
          })),
          // English only, with the limitation stated on the document, is the fallback (S-06-08's rule).
          { heading: 'Language', body: 'Printed in English only. A translation of these instructions is not available, and a partial translation is never printed.' },
        ]}
      />
    </>
  )
}

/** One basket line, with AI-206's dose adjustment and AI-305's completeness gap. */
function RxLineCard({
  line,
  encounterId,
  weightKg,
  locked,
  diagnoses,
  onEdit,
  onRemove,
}: {
  line: BasketLine
  encounterId: string
  weightKg?: number
  locked: boolean
  /** The patient's diagnoses, offered as the line's indication. */
  diagnoses: IcdCode[]
  onEdit: (patch: RxLineEdit) => void
  onRemove: () => void
}) {
  const base = `${encounterId}:${line.id}`
  const touchpointId = `${encounterId}:dose:${line.id}`
  const blockedNow = line.stop !== undefined && line.override === undefined
  const weight = weightKg !== undefined ? `${weightKg} kg` : 'no weight recorded'
  const routeOptions = [...new Set([line.proposedRouteFrequency, ...ROUTE_FREQUENCIES])]
  const adjustment = line.doseAdjustment

  return (
    <li
      id={base}
      className={cn(
        'rounded-[18px] p-[16px]',
        blockedNow ? 'inset-ring-2 inset-ring-sh-crit' : line.override ? 'inset-ring-1 inset-ring-sh-crit' : 'inset-ring-1 inset-ring-sh-line-strong',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-[8px]">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-[8px] text-[15px] font-semibold text-sh-text">
            <Icon icon={PillIcon} size={15} className="text-sh-text-3" />
            {line.drug}
            {blockedNow && (
              <PillTag tone="crit" size="xs" icon={OctagonAlert} className="font-semibold">
                Blocked
              </PillTag>
            )}
            {line.override && (
              <PillTag tone="crit" size="xs" icon={ShieldAlert} className="font-semibold">
                Overridden
              </PillTag>
            )}
          </p>
          {line.indication && !line.indicationCode && <p className="mt-[2px] text-[13px] text-sh-text-3">for {line.indication}</p>}
        </div>
        {/* Resolve lives on the page alert above — one way in, not two. */}
        <Pill variant="ghost" size="md" icon={Trash2} disabled={locked} aria-label={`Remove ${line.drug}`} className="disabled:opacity-40" onClick={onRemove}>
          Remove
        </Pill>
      </div>

      <Hairline className="my-[12px]" />

      <div className="flex flex-col gap-[12px]">
        <Field
          label="Dose"
          htmlFor={`${base}:dose`}
          required
          hint={`Per-kg doses show the weight and its capture time · ${weight}`}
          aside={
            adjustment && (
              <FieldChip
                touchpointId={touchpointId}
                capabilityId="AI-206"
                suggestion={adjustment.proposed}
                band={adjustment.band}
                score={adjustment.confidence}
                gate="G2"
                locked={locked}
                onAccept={() => onEdit({ dose: adjustment.proposed })}
                onUndo={() => onEdit({ dose: undefined })}
                explain={{
                  touchpointId,
                  capabilityId: 'AI-206',
                  claim: `The dose should be reduced to ${adjustment.proposed} for renal function.`,
                  confidence: adjustment.confidence,
                  band: adjustment.band,
                  computedAt: formatTime(NOW),
                  inputs: [
                    { label: 'Serum creatinine 212 µmol/L, 21-Sep-2026', source: 'Result R-88405' },
                    { label: `Weight ${weight}`, source: 'Vitals, most recent set' },
                    { label: 'Drug renal-dosing table', source: 'Drug knowledge base' },
                  ],
                  evidence: [adjustment.reason],
                  model: 'renal-dose v2.1.4',
                  limits: [
                    'Uses the most recent creatinine. It does not know if the patient is still deteriorating.',
                    'The printed dosing reference remains the fallback.',
                    'Does not cover dialysis or continuous renal replacement.',
                  ],
                }}
              />
            )
          }
        >
          <TextInput id={`${base}:dose`} value={line.dose} disabled={locked} onChange={(e) => onEdit({ dose: e.target.value })} />
        </Field>

        <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2">
          <Field label="Route & frequency" htmlFor={`${base}:route`} required>
            <Select id={`${base}:route`} value={line.routeFrequency} disabled={locked} onChange={(e) => onEdit({ routeFrequency: e.target.value })}>
              {routeOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Duration" htmlFor={`${base}:duration`} required>
            <Select id={`${base}:duration`} value={String(line.durationDays)} disabled={locked} onChange={(e) => onEdit({ durationDays: Number(e.target.value) })}>
              {!(line.durationDays > 0) && <option value="0">Not stated</option>}
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {/* A PRN line states its ceiling — the field AI-305's finding asks for (the old screen had none to give). */}
        {line.prn && (
          <Field label="24-hour ceiling" htmlFor={`${base}:ceiling`} required>
            <TextInput id={`${base}:ceiling`} value={line.maxDaily} disabled={locked} placeholder="Maximum in 24 hours" onChange={(e) => onEdit({ maxDaily: e.target.value })} />
          </Field>
        )}
      </div>

      {/* AI-305 completeness — the gap on the line it concerns; the caveat once, under the basket. */}
      {line.gaps.map((g) => (
        <p key={g} className="mt-[12px] flex items-start gap-[8px] rounded-[12px] bg-sh-warn-bg px-[12px] py-[8px] text-[13px] font-medium text-sh-warn-fg">
          <Icon icon={CircleAlert} size={14} className="mt-[2px] shrink-0" />
          {g}
        </p>
      ))}

      <label className="mt-[12px] flex flex-wrap items-center gap-x-[10px] gap-y-[4px] text-[13px]">
        <Toggle checked={line.substitutionAllowed} disabled={locked} onChange={(v) => onEdit({ substitutionAllowed: v })} label="Substitution allowed" />
        <span className="text-sh-text">Substitution allowed</span>
        <span className="text-sh-text-3">— drives pharmacy dispensing</span>
      </label>

      <IcdField
        id={`${base}:indication`}
        label="Indication (ICD-10, optional)"
        value={line.indicationCode ? [line.indicationCode] : []}
        onChange={(v) => onEdit({ indication: v[0] ?? null })}
        suggestions={diagnoses}
        disabled={locked}
        className="mt-[12px]"
      />

      <VoiceField
        id={`${base}:instructions`}
        label="Instructions for the patient"
        className="mt-[12px]"
        rows={2}
        disabled={locked}
        value={line.instructions ?? ''}
        onChange={(v) => onEdit({ instructions: v })}
        placeholder="How to take it, and what to avoid…"
        hint="Printed bilingually — English plus the patient's language"
      />
    </li>
  )
}

/** Z6 — the checks, with what survives the AI being off stated plainly. */
function RxRail({ encounterId, ceilingLines }: { encounterId: string; ceilingLines: number }) {
  const aiActive = useAiActive()
  const rows: [string, ReactNode][] = [
    [
      'Allergy & interaction',
      <>
        <Icon icon={ShieldCheck} size={14} className="text-sh-norm-fg" />
        Deterministic
      </>,
    ],
    [
      'Dose range',
      <>
        <Icon icon={ShieldCheck} size={14} className="text-sh-norm-fg" />
        Static tables
      </>,
    ],
    [
      'Renal adjustment',
      aiActive ? (
        <>
          <Diamond />
          Model live
        </>
      ) : (
        <>
          <Icon icon={CircleDot} size={14} className="text-sh-text-3" />
          Printed reference
        </>
      ),
    ],
  ]
  const count = ceilingLines === 1 ? 'One line is' : ceilingLines === 2 ? 'Two lines are' : `${ceilingLines} lines are`

  return (
    <div className="flex flex-col gap-[12px]">
      <Card titleSize="sm" title="Safety checks">
        <dl className="flex flex-col">
          {rows.map(([label, value], i) => (
            <div key={label} className={cn('flex flex-wrap items-center justify-between gap-[8px] py-[10px]', i > 0 && 'border-t border-sh-line', i === 0 && 'pt-0')}>
              <dt className="text-[13px] text-sh-text-2">{label}</dt>
              <dd className="flex items-center gap-[6px] text-[13px] font-medium text-sh-text">{value}</dd>
            </div>
          ))}
        </dl>
        <Why className="mt-[8px]">
          <p>The first two never switch off. Safety on this screen does not depend on a model being up — which is why the block still fires with the AI off.</p>
          <p>A hard stop has no confidence band, because it is not a prediction. It is the allergy record and the drug class, and nothing else.</p>
          <div>
            <p className="font-medium text-sh-text">On signing</p>
            <ul className="mt-[4px] flex flex-col gap-[4px]">
              {[
                'Printed A5, bilingual, with your HPR number on it',
                'Sent to the pharmacy dispensing queue',
                'Queued to publish to ABDM as a Prescription record',
                'No PHI goes out in any SMS — only a pointer back in',
              ].map((t) => (
                <li key={t} className="flex gap-[8px]">
                  <Icon icon={Check} size={13} className="mt-[4px] shrink-0 text-sh-norm-fg" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </Why>
      </Card>

      {ceilingLines > 0 && (
        <SuggestionCard
          touchpointId={`${encounterId}:stewardship`}
          capabilityId="AI-305"
          title={`${count} missing a stated ceiling`}
          evidence="A PRN analgesic without a 24-hour maximum is the commonest documentation gap found at NABH audit."
          band="HIGH"
          score={0.91}
          gate="G2"
          explain={{
            touchpointId: `${encounterId}:stewardship`,
            capabilityId: 'AI-305',
            claim: 'The prescription is incomplete: a PRN line has no maximum daily dose.',
            confidence: 0.91,
            band: 'HIGH',
            computedAt: formatTime(NOW),
            inputs: [{ label: 'Prescription lines in the basket', source: `Note ${encounterId}` }],
            evidence: ['CMP-NABH-05 requires orders to be legible and complete.'],
            model: 'rx-complete v1.8.0',
            limits: ['Checks structure and dose ranges, not clinical appropriateness.', 'The static dose-range tables remain when the model is unavailable.'],
          }}
        />
      )}
    </div>
  )
}

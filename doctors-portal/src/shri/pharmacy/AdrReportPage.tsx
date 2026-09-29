/**
 * S-16-08 · ADR reporting (PvPI) — `/pharmacy/adr` (`src/screens/m16/
 * S1608.tsx`): "Reporting an adverse drug reaction to PvPI."
 *
 * AI-815 detects a signal at G1 and the fallback is clinician-initiated
 * reporting — which is how essentially all pharmacovigilance works, and why
 * the detection is worth having: the reaction that never gets reported is the
 * one nobody had time to write up. The signal is an offer with Accept/Reject;
 * the form is PvPI Form 1; submitting needs a narrative and the attestation.
 */

import { ChevronDown, ChevronRight, Check, Save, Send, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { NOW, formatDate, formatTime } from '@/data/format'
import { DRUGS, PATIENTS } from '@/data/kit'
import { useAI } from '@/store/ai'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useAiActive } from '../state/ai'
import { AIActionBar } from '../ui/ai'
import { Why } from '../ui/Disclosure'
import { CheckboxRow, Field, Select, TextInput } from '../ui/forms'
import { Card, Diamond, Icon, Pill, PillTag } from '../ui/primitives'
import { VoiceField } from '../ui/VoiceField'

/** The signal AI-815 has found in this session's data. */
const SIGNAL = {
  drug: 'Co-amoxiclav 1.2g IV',
  reaction: 'Urticaria with facial swelling',
  detail: 'Three patients at this facility have had a urticarial reaction within two hours of a first co-amoxiclav dose in the last 90 days. Two were not reported to PvPI.',
  confidence: 0.72,
  band: 'MED' as const,
}

const SEVERITY = ['Mild', 'Moderate', 'Severe', 'Life-threatening', 'Fatal']
const OUTCOMES = ['Recovered', 'Recovering', 'Not recovered', 'Recovered with sequelae', 'Fatal', 'Unknown']
const CAUSALITY = ['Certain', 'Probable', 'Possible', 'Unlikely', 'Unclassified', 'Unassessable']

function Group({ title, span, children }: { title: string; span?: boolean; children: ReactNode }) {
  return (
    <Card title={title} titleSize="sm" className={cn('gap-[14px]', span && 'lg:col-span-2')}>
      <div className="flex flex-col gap-[14px]">{children}</div>
    </Card>
  )
}

export function AdrReportPage() {
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const aiActive = useAiActive()
  const signalActioned = useAI((s) => s.dispositions['adr:signal'])

  const [patientId, setPatientId] = useState('SD-P-03')
  const [drug, setDrug] = useState<string>(SIGNAL.drug)
  const [reaction, setReaction] = useState(SIGNAL.reaction)
  const [severity, setSeverity] = useState('Moderate')
  const [outcome, setOutcome] = useState('Recovered')
  const [causality, setCausality] = useState('Probable')
  const [narrative, setNarrative] = useState('')
  const [rechallenge, setRechallenge] = useState(false)
  const [attested, setAttested] = useState(false)
  const [detailExpanded, setDetailExpanded] = useState(false)

  const ready = reaction.trim().length > 3 && narrative.trim().length >= 20 && attested

  return (
    <ScreenFrame
      screenId="S-16-08"
      sub="PvPI Form 1"
      chips={
        aiActive &&
        !signalActioned && (
          <PillTag tone="warn" size="sm" icon={TriangleAlert}>
            1 signal detected
          </PillTag>
        )
      }
      rail={
        <Why label="Why reporting matters">
          <p>A reaction recorded in the chart protects this patient. A reaction reported to PvPI protects everyone else&rsquo;s. They are different acts, and only the second one needs this form.</p>
          <p>
            Suspected is enough — a report does not assert causation. &ldquo;Possible&rdquo; is a valid causality assessment and a useful report; waiting for certainty is how signals
            get missed.
          </p>
          <ul className="flex flex-col gap-[6px]">
            {['The allergy is added to the patient record immediately', 'Prescribing this drug for them becomes a hard stop', 'The report goes to the ADR monitoring centre', 'A serious reaction is escalated within 15 days'].map((t) => (
              <li key={t} className="flex gap-[8px]">
                <Icon icon={Check} size={13} className="mt-[3px] text-sh-norm-fg" />
                {t}
              </li>
            ))}
          </ul>
          <p className="text-sh-text-3">CMP-DRUG-04 · ADR reporting.</p>
        </Why>
      }
      railTitle="PvPI"
      actionBar={
        <>
          <Pill variant="control" size="bar" icon={Save} onClick={() => toast({ tone: 'info', title: 'Draft saved', detail: 'The ADR report stays a draft on this device until you submit it to PvPI.' })}>
            Save draft
          </Pill>
          <span className="text-[13px] text-sh-text-3">{ready ? 'Ready to submit' : 'A narrative and the attestation are required'}</span>
          <Pill
            variant="primary"
            size="bar"
            icon={Send}
            className="ml-auto"
            disabled={!ready}
            onClick={() =>
              toast({ tone: 'success', title: 'ADR reported to PvPI', detail: `${drug} · ${reaction}. The allergy is on the patient record and prescribing it is now a hard stop.` })
            }
          >
            Submit the report
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[16px]">
        {aiActive && !signalActioned && (
          <Card className="border-l-[3px] border-sh-warn">
            <h2 className="flex items-center gap-[8px] font-semibold text-sh-warn-fg">
              <Diamond />A signal has been detected
            </h2>
            <p className="mt-[8px] font-medium">
              {SIGNAL.drug} → {SIGNAL.reaction}
            </p>
            <p className={cn('mt-[6px] text-sh-text-2', !detailExpanded && 'sh-clamp-2')}>{SIGNAL.detail}</p>
            <button
              type="button"
              aria-expanded={detailExpanded}
              onClick={() => setDetailExpanded((v) => !v)}
              className="mt-[4px] inline-flex min-h-[36px] items-center gap-[4px] self-start rounded-full px-[6px] text-[13px] font-medium text-sh-text-3 transition-colors duration-150 hover:bg-sh-hover hover:text-sh-text-2"
            >
              {detailExpanded ? 'Show less' : 'Read more'}
              <Icon icon={detailExpanded ? ChevronDown : ChevronRight} size={12} />
            </button>
            <AIActionBar
              className="mt-[12px]"
              touchpointId="adr:signal"
              capabilityId="AI-815"
              gate="G1"
              band={SIGNAL.band}
              score={SIGNAL.confidence}
              onAccept={() => {
                setDrug(SIGNAL.drug)
                setReaction(SIGNAL.reaction)
                toast({ tone: 'info', title: 'Form pre-filled from the signal', detail: 'Check every field before submitting.' })
              }}
              explain={{
                touchpointId: 'adr:signal',
                capabilityId: 'AI-815',
                claim: 'A cluster of urticarial reactions following first-dose co-amoxiclav has been detected at this facility.',
                confidence: SIGNAL.confidence,
                band: SIGNAL.band,
                computedAt: formatTime(NOW),
                inputs: [
                  { label: 'Administration records, 90 days', source: 'eMAR' },
                  { label: 'New allergy entries, 90 days', source: 'Allergy records' },
                  { label: 'PvPI reports already filed', source: 'ADR register' },
                ],
                evidence: ['Three reactions within two hours of a first dose.', 'Two of the three were never reported to PvPI.'],
                model: 'adr-signal v1.4.0',
                limits: [
                  'Detects temporal association, not causation. Three cases is a signal, not a finding.',
                  'It cannot see a reaction that was never charted.',
                  'Clinician-initiated reporting remains the fallback and the main route.',
                ],
              }}
            />
          </Card>
        )}

        <div className="grid gap-[16px] lg:grid-cols-2">
          <Group title="Patient">
            <Field label="Patient" required htmlFor="adr-patient">
              <Select id="adr-patient" value={patientId} onChange={(e) => setPatientId(e.target.value)}>
                {PATIENTS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.uhid} · {p.age}/{p.sex}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date of the reaction" required htmlFor="adr-date">
              <TextInput id="adr-date" type="date" defaultValue="2026-09-21" />
            </Field>
          </Group>

          <Group title="Suspected drug">
            <Field label="Drug" required htmlFor="adr-drug">
              <Select id="adr-drug" value={drug} onChange={(e) => setDrug(e.target.value)}>
                {DRUGS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Dose, route and frequency" htmlFor="adr-dose">
              <TextInput id="adr-dose" defaultValue="1.2 g IV, first dose" />
            </Field>
            <CheckboxRow checked={rechallenge} onChange={setRechallenge}>
              <span>
                Rechallenge was attempted
                <span className="block text-[13px] text-sh-text-3">Rarely appropriate, and it strengthens the causality assessment when it happened.</span>
              </span>
            </CheckboxRow>
          </Group>

          <Group title="The reaction" span>
            <div className="grid gap-[16px] lg:grid-cols-3">
              <Field label="Reaction" required htmlFor="adr-reaction">
                <TextInput id="adr-reaction" value={reaction} onChange={(e) => setReaction(e.target.value)} />
              </Field>
              <Field label="Severity" required htmlFor="adr-severity">
                <Select id="adr-severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
                  {SEVERITY.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Outcome" required htmlFor="adr-outcome">
                <Select id="adr-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                  {OUTCOMES.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Causality assessment" required htmlFor="adr-causality" hint="WHO-UMC scale. Possible is a valid and useful answer.">
              <Select id="adr-causality" value={causality} onChange={(e) => setCausality(e.target.value)}>
                {CAUSALITY.map((cz) => (
                  <option key={cz}>{cz}</option>
                ))}
              </Select>
            </Field>
            <VoiceField
              id="adr-narrative"
              label="Narrative"
              required
              rows={4}
              value={narrative}
              onChange={setNarrative}
              placeholder="Developed an urticarial rash over the trunk with periorbital swelling within 90 minutes of the first dose. The infusion was stopped, chlorphenamine and hydrocortisone were given, and the rash settled over four hours…"
              hint="What happened, in what order, and what was done about it — at least twenty characters"
            />
          </Group>

          <Group title="Reporter" span>
            <div className="rounded-[14px] bg-sh-inner px-[16px] py-[12px]">
              <p className="font-medium">{me.name}</p>
              <p className="text-[13px] tabular-nums text-sh-text-3">
                {me.identifierKind} {me.identifier} · {me.personaLabel}
              </p>
              <p className="mt-[4px] text-[13px] tabular-nums text-sh-text-3">{formatDate(NOW)}</p>
            </div>
            <CheckboxRow checked={attested} onChange={setAttested}>
              <span>
                The information above is accurate to the best of my knowledge.
                <span className="block text-[13px] text-sh-text-3">Submitting also adds the allergy to the patient record, which makes prescribing this drug for them a hard stop.</span>
              </span>
            </CheckboxRow>
          </Group>
        </div>
      </div>
    </ScreenFrame>
  )
}

/**
 * S-09-05 · Result detail — `/results/:id` (`src/screens/m09/S0905.tsx`):
 * "One result, its trend and what it means alongside it."
 *
 * AI-212's guardrail is why the numbers come first: "REFERENCE RANGES AND
 * PRIOR VALUE SHOWN" is the fallback, so the screen is built that way and the
 * interpretation sits beside it rather than in front of it. AI-109 drafts the
 * narrative at G3 — attest, not merely confirm — because a released report
 * enters the legal record; the bar carries G3's fixed checkbox and signature.
 *
 * Where the old screen fell short: an unacknowledged critical value is
 * acknowledged from here (the old one said so and offered no way to), and
 * AI-212's reasoning in the rail goes with the AI.
 */

import { CircleCheck, FlaskConical, PenLine, SearchX, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { BAND_SPECS } from '@/atlas/confidence'
import { RESULT_TRENDS, encounterForPatient, maybeResult, type ResultRow } from '@/data/clinical'
import { NOW, formatDateTime, formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { useClinical } from '@/store/clinical'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { ClinicalFlag } from '../record/bits'
import { TrendCard } from '../record/TrendCard'
import { useAiActive } from '../state/ai'
import { AIActionBar } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { Why } from '../ui/Disclosure'
import { EmptyState } from '../ui/EmptyState'
import { Card, ConfidenceMark, Diamond, Pill, PillTag } from '../ui/primitives'

import { CriticalAck } from './CriticalAck'

export function ResultDetailPage() {
  const { id } = useParams()
  const r = maybeResult(id)
  if (!r) return <ResultNotFound id={id} />
  return <ResultDetail key={r.id} r={r} />
}

/** An address that names no result says so, rather than showing somebody else's. */
function ResultNotFound({ id }: { id?: string }) {
  const navigate = useNavigate()
  return (
    <ScreenFrame
      screenId="S-09-05"
      sub="No result at this address."
      actions={
        <Pill variant="primary" size="xl" icon={FlaskConical} iconSize={17} onClick={() => navigate('/results/inbox')}>
          Test results
        </Pill>
      }
    >
      <Card className="max-w-[640px]">
        <EmptyState icon={SearchX} why={`There is no result “${id ?? ''}” on the record. The results list has every result released for your patients.`} />
      </Card>
    </ScreenFrame>
  )
}

function Fact({ label, children, first }: { label: string; children: ReactNode; first?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-[8px] py-[9px] ${first ? 'pt-0' : 'border-t border-sh-line'}`}>
      <dt className="text-[13px] text-sh-text-2">{label}</dt>
      <dd className="text-[13px] font-medium tabular-nums text-sh-text">{children}</dd>
    </div>
  )
}

function ResultDetail({ r }: { r: ResultRow }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const aiActive = useAiActive()
  const acknowledgements = useClinical((s) => s.acknowledgements)
  const reassigned = useClinical((s) => s.reassignedResults[r.id])
  const [acking, setAcking] = useState(false)

  const p = patient(r.patientId)
  const enc = encounterForPatient(p.id)
  const acked = r.acknowledged || acknowledgements[r.id] !== undefined
  const series = RESULT_TRENDS[r.id] ?? []
  const notePath = enc ? (enc.type === 'IP' ? `/ip/encounter/${enc.id}/note` : `/encounter/${enc.id}/note`) : undefined

  return (
    <>
      <ScreenFrame
        screenId="S-09-05"
        patient={p}
        heading={r.test}
        sub={`${r.value} ${r.unit} · reference ${r.refRange} · reported ${formatTime(r.reportedAt)}`}
        chips={
          <>
            <ClinicalFlag flag={r.flag} />
            {r.critical && (
              <PillTag tone={acked ? 'norm' : 'crit'} size="sm" icon={acked ? CircleCheck : TriangleAlert} className="font-semibold">
                {acked ? 'Acknowledged' : 'Unacknowledged'}
              </PillTag>
            )}
          </>
        }
        actions={
          notePath &&
          may(notePath) && (
            <Pill variant="primary" size="xl" icon={PenLine} iconSize={17} onClick={() => navigate(notePath)}>
              Document the action
            </Pill>
          )
        }
        rail={
          <div className="flex flex-col gap-[12px]">
            <Card titleSize="sm" title="The numbers">
              <dl className="flex flex-col">
                <Fact label="Result" first>
                  <span className="font-semibold">
                    {r.value} {r.unit}
                  </span>
                </Fact>
                <Fact label="Reference">{r.refRange}</Fact>
                {r.priorValue && <Fact label="Prior">{r.priorValue}</Fact>}
                {r.delta && <Fact label="Delta">{r.delta}</Fact>}
                <Fact label="Reported">{formatDateTime(r.reportedAt)}</Fact>
              </dl>
              <p className="mt-[10px] text-[12px] text-sh-text-3">These are the fallback and the authority — enough to act on without the interpretation.</p>
            </Card>
            {/* AI-212's reasoning is the model's, so it goes with the AI; the numbers above never do. */}
            {aiActive && (
              <Why label="Why this result was ranked where it was">
                <p>{r.aiReason}</p>
                <p className="flex flex-wrap items-center gap-[8px] text-sh-text-3">
                  <Diamond />
                  AI-212 · ranks and shows the delta at G1. The chronological order in the inbox is one click away.
                </p>
                <span aria-label={`Confidence: ${BAND_SPECS[r.band].label}`}>
                  <ConfidenceMark band={r.band} />
                </span>
              </Why>
            )}
          </div>
        }
        railTitle="Result"
      >
        {r.critical && !acked && (
          <Alert
            tone="crit"
            role="alert"
            icon={TriangleAlert}
            title="This critical value has not been acknowledged"
            action={
              <Pill variant="crit" size="md" icon={TriangleAlert} onClick={() => setAcking(true)}>
                Acknowledge
              </Pill>
            }
          >
            Acknowledgement is recorded against a named clinician and stops the escalation clock. It is separate from documenting what you did.
            {reassigned && ` Reassigned to ${reassigned.to} — still unacknowledged.`}
          </Alert>
        )}

        {series.length > 1 ? (
          <TrendCard series={[r]} showOpen={false} />
        ) : (
          <Card>
            <div className="py-[24px] text-center">
              <p className="text-[15px] font-medium text-sh-text">No prior values to trend</p>
              <p className="mx-auto mt-[6px] max-w-[520px] text-[13px] text-sh-text-2">
                This is the first result of its kind for this patient, so there is nothing to compare it against — which is also why the delta column is empty rather than zero.
              </p>
            </div>
          </Card>
        )}

        {/* AI-109's narrative, at G3 — attest, not merely confirm. */}
        {aiActive && r.narrative && (
          <Card className="border-l-[3px] border-sh-ai">
            <h2 className="flex items-center gap-[8px] text-[15px] font-semibold text-sh-text">
              <Diamond />
              Drafted interpretation
            </h2>
            <div className="mt-[10px] flex flex-col gap-[8px] text-[14px]/[1.6] text-sh-text-2">
              {r.narrative.map((para) => (
                <p key={para}>{para}</p>
              ))}
            </div>
            <AIActionBar
              className="mt-[12px]"
              touchpointId={`result:${r.id}:narrative`}
              capabilityId="AI-109"
              gate="G3"
              band={r.band}
              score={0.84}
              subject={p.id}
              explain={{
                touchpointId: `result:${r.id}:narrative`,
                capabilityId: 'AI-109',
                claim: 'A drafted interpretation of this result in its clinical context, for attestation before it enters the record.',
                confidence: 0.84,
                band: r.band,
                computedAt: formatTime(NOW),
                inputs: [
                  { label: `${r.test} ${r.value} ${r.unit}`, source: `Result ${r.id}` },
                  ...(r.priorValue ? [{ label: `Prior ${r.priorValue}`, source: 'Previous result' }] : []),
                  { label: 'Active problem list', source: `Problems for ${p.id}` },
                  { label: 'Active prescriptions', source: 'Medication record' },
                ],
                evidence: [r.aiReason],
                model: 'lab-narrative v2.3.1',
                limits: [
                  'Interprets one analyte in the context of the structured record.',
                  'It cannot know whether the sample was haemolysed or taken from the wrong arm.',
                  'At G3 it does not enter the record until a clinician attests to it by name.',
                  'Numeric results with reference ranges remain the fallback.',
                ],
              }}
            />
            {/* 12px clear of the bar, so the controls above keep their 44px targets. */}
            <Why label="What attesting to this means" className="mt-[12px]">
              <p>
                A G3 touchpoint needs your signature, not just your click — anything entering the legal record does. Until you attest, this draft is not in the record and nobody
                else can see it.
              </p>
            </Why>
          </Card>
        )}

        <Why label="Why there is one measure on this chart">
          <p>One measure, one axis. A second analyte on a second scale would be a separate chart — a dual axis makes two unrelated trends look like they are tracking each other.</p>
        </Why>
      </ScreenFrame>

      {/* S-09-06, from where the value is read. */}
      <CriticalAck result={acking ? r : null} onClose={() => setAcking(false)} />
    </>
  )
}

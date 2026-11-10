/**
 * S-06-05 · Problems and coding — `/encounter/:id/problems` (`src/screens/m06/
 * S0605.tsx`): the problem list, coded properly the first time. Two AI
 * touchpoints with opposite jobs: AI-501 proposes a code and BLOCKS
 * PARENT-ONLY ONES (manual search never goes away); AI-204 checks the other
 * direction — whether the charted evidence supports a coded diagnosis — and
 * flags, never blocks. Each problem is confirmed, then the list.
 *
 * Gaps closed from the old screen: a problem added here is added — to the
 * patient's list everywhere it is shown, with an audit row — where the old
 * screen only said so in a toast; confirmations are kept, not lost with the
 * page; and confirming the list is on the audit trail.
 */

import { Ban, Check, Pencil, TriangleAlert } from 'lucide-react'
import { useParams } from 'react-router-dom'

import { CODE_SUGGESTIONS } from '@/data/clinical'
import { NOW, formatTime } from '@/data/format'
import { DIAGNOSES, patient } from '@/data/kit'
import { useAudit } from '@/store/audit'
import { useClinical } from '@/store/clinical'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { encounterLabel, maybeEncounter } from '../logic/encounter'
import { useProblemsFor } from '../logic/record'
import { FieldChip, SuggestionCard } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { Why } from '../ui/Disclosure'
import { IcdPicker } from '../ui/IcdPicker'
import { Card, Chip, CountBubble, Pill, PillTag } from '../ui/primitives'

import { NoSuchEncounter } from './ConsultationPage'

export function ProblemsPage() {
  const { id } = useParams()
  const enc = maybeEncounter(id)
  if (!enc) return <NoSuchEncounter id={id} screenId="S-06-05" />
  return <Problems encounterId={enc.id} />
}

function Problems({ encounterId }: { encounterId: string }) {
  const enc = maybeEncounter(encounterId)!
  const p = patient(enc.patientId)
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const addProblem = useClinical((s) => s.addProblem)
  const confirmations = useClinical((s) => s.problemConfirmations)
  const confirmProblem = useClinical((s) => s.confirmProblem)
  const listConfirmed = useClinical((s) => s.problemListConfirmed[enc.id])
  const confirmProblemList = useClinical((s) => s.confirmProblemList)

  const problems = useProblemsFor(p.id)
  const flagged = problems.filter((pr) => pr.consistencyFlag)
  const confirmed = problems.filter((pr) => confirmations[pr.id] !== undefined)
  const confirm = (problemId: string) => confirmProblem(problemId, me.name, NOW.toISOString())

  function add(d: { label: string; icd10: string }) {
    // One entry per code: a code the list already holds, seeded or added, adds nothing.
    if (problems.some((pr) => pr.icd10 === d.icd10) || !addProblem(p.id, d, me.name, NOW.toISOString())) {
      toast({ tone: 'info', title: `${d.label} is already on the list`, detail: `Coded ${d.icd10}` })
      return
    }
    audit({ event: 'PROBLEM.ADDED', actor: me.name, actorId: me.id, subject: p.id, detail: `${d.label} · ICD-10 ${d.icd10} · ${encounterLabel(enc)}` })
    toast({ tone: 'success', title: `${d.label} added`, detail: `Coded ${d.icd10}` })
  }

  function confirmList() {
    const codes = problems.map((pr) => pr.icd10)
    confirmProblemList(enc.id, codes, me.name, NOW.toISOString())
    audit({ event: 'PROBLEM_LIST.CONFIRMED', actor: me.name, actorId: me.id, subject: p.id, detail: `${codes.length} problems · ${codes.join(', ')} · ${encounterLabel(enc)}` })
    toast({ tone: 'success', title: 'Problem list confirmed' })
  }

  const rail =
    flagged.length > 0 ? (
      <div className="flex flex-col gap-[12px]">
        {flagged.map((pr) => (
          <SuggestionCard
            key={pr.id}
            touchpointId={`${enc.id}:consistency:${pr.id}`}
            capabilityId="AI-204"
            title={`${pr.label} may not be supported`}
            evidence={pr.consistencyFlag!}
            band={pr.band ?? 'MED'}
            score={pr.confidence}
            gate="G1"
            explain={{
              touchpointId: `${enc.id}:consistency:${pr.id}`,
              capabilityId: 'AI-204',
              claim: `The charted evidence does not clearly support ${pr.label} (${pr.icd10}).`,
              confidence: pr.confidence ?? 0.6,
              band: pr.band ?? 'MED',
              computedAt: formatTime(NOW),
              inputs: [
                { label: 'Charted vitals and flowsheet', source: 'Flowsheet, last 24h' },
                { label: 'Laboratory results', source: 'Results, last 48h' },
                { label: 'Coding rule for this diagnosis', source: 'ICD-10 coding guidance' },
              ],
              evidence: [pr.consistencyFlag!],
              model: 'dx-consistency v1.6.2',
              limits: [
                'Checks whether the charted evidence supports the code, not whether the diagnosis is right.',
                'A missing observation looks the same as an absent finding to this check.',
                'The coder review queue catches what this misses.',
              ],
            }}
          />
        ))}
      </div>
    ) : undefined

  return (
    <ScreenFrame
      screenId="S-06-05"
      patient={p}
      heading="Problems and coding"
      sub={
        <>
          {problems.length} {problems.length === 1 ? 'problem' : 'problems'} · {confirmed.length} confirmed
          {flagged.length > 0 && (
            <>
              {' · '}
              <span className="font-semibold text-sh-warn-fg">
                {flagged.length} {flagged.length === 1 ? 'needs' : 'need'} evidence
              </span>
            </>
          )}
        </>
      }
      chips={<Chip word={enc.encounterNo} tone="neu" />}
      rail={rail}
      railTitle="Checks"
      railBadge={flagged.length || undefined}
      actionBar={
        <>
          <span className="text-[13px] tabular-nums text-sh-text-2">
            {confirmed.length} of {problems.length} confirmed
            {listConfirmed && ` · list confirmed ${formatTime(new Date(listConfirmed.at))} by ${listConfirmed.by}`}
          </span>
          <Pill variant="primary" size="lg" icon={Check} className="ml-auto disabled:opacity-40" disabled={confirmed.length < problems.length} onClick={confirmList}>
            Confirm the problem list
          </Pill>
        </>
      }
    >
      {/* The one place "flags, does not block" is said. */}
      {flagged.length > 0 && (
        <Alert tone="warn" title={`${flagged.length} coded ${flagged.length === 1 ? 'problem needs' : 'problems need'} evidence`}>
          The supporting evidence is not charted. Coding it anyway is permitted — the flag is a prompt, not a block — but it will surface again at coder review.
        </Alert>
      )}

      <Card
        titleSize="sm"
        title={
          <span className="inline-flex items-center gap-[10px]">
            Problem list
            <CountBubble className="bg-sh-control">{problems.length}</CountBubble>
          </span>
        }
      >
        <ul className="flex flex-col gap-[4px]">
          {problems.map((pr) => {
            const isConfirmed = confirmations[pr.id] !== undefined
            return (
              <li key={pr.id} className={cn('flex min-h-[44px] flex-wrap items-center gap-x-[12px] gap-y-[8px] rounded-[14px] px-[10px] py-[8px]', pr.consistencyFlag && 'bg-sh-warn-bg')}>
                <span className="min-w-0 flex-1 basis-[200px]">
                  <span className="flex flex-wrap items-center gap-[8px] text-[14px] font-medium text-sh-text">
                    {pr.label}
                    {pr.consistencyFlag && (
                      <PillTag tone="warn" size="xs" icon={TriangleAlert}>
                        evidence
                      </PillTag>
                    )}
                  </span>
                  {/* On the amber flagged row the quiet grey would fall below AA, so it takes the stronger one. */}
                  <span className={cn('block text-[12px] tabular-nums', pr.consistencyFlag ? 'text-sh-text-2' : 'text-sh-text-3')}>
                    onset {pr.onset} · {pr.icd10} · SNOMED {pr.snomed}
                  </span>
                </span>
                <span className="flex flex-wrap items-center justify-end gap-[8px]">
                  {pr.leaf ? (
                    <PillTag tone="norm" size="xs" icon={Check}>
                      leaf
                    </PillTag>
                  ) : (
                    <PillTag tone="crit" size="xs" icon={Ban}>
                      parent
                    </PillTag>
                  )}
                  {pr.aiSuggested ? (
                    <FieldChip
                      touchpointId={`${enc.id}:code:${pr.id}`}
                      capabilityId="AI-501"
                      suggestion={pr.icd10}
                      band={pr.band ?? 'HIGH'}
                      score={pr.confidence}
                      gate="G2"
                      onAccept={() => confirm(pr.id)}
                      explain={{
                        touchpointId: `${enc.id}:code:${pr.id}`,
                        capabilityId: 'AI-501',
                        claim: `${pr.icd10} is the most specific code supported for ${pr.label}.`,
                        confidence: pr.confidence ?? 0.85,
                        band: pr.band ?? 'HIGH',
                        computedAt: formatTime(NOW),
                        inputs: [
                          { label: `Problem: ${pr.label}`, source: `SNOMED ${pr.snomed}` },
                          { label: 'Note assessment section', source: encounterLabel(enc) },
                        ],
                        evidence: ['Leaf codes only; parent categories are blocked at the field.'],
                        model: 'code-assist v3.2.0',
                        limits: ['Suggests from the note and the problem list.', 'Does not apply reimbursement optimisation.', 'Manual ICD-10 search is always available.'],
                      }}
                    />
                  ) : (
                    <PillTag tone="neu" size="xs" icon={Pencil}>
                      coded manually
                    </PillTag>
                  )}
                  <Pill variant={isConfirmed ? 'control' : 'primary'} size="md" icon={isConfirmed ? Check : undefined} aria-pressed={isConfirmed} onClick={() => confirm(pr.id)}>
                    {isConfirmed ? 'Confirmed' : 'Confirm'}
                  </Pill>
                </span>
              </li>
            )
          })}
        </ul>
      </Card>

      <Card titleSize="sm" title="Add a problem" headerClassName="mb-[4px]">
        <p className="mb-[12px] text-[12px] text-sh-text-3">Search ICD-10 by code, diagnosis or the words you would use (stroke, TB, CKD…)</p>
        <label htmlFor="dx-search" className="mb-[6px] block text-[13px] font-medium text-sh-text-2">
          Search
        </label>
        <IcdPicker
          id="dx-search"
          extra={DIAGNOSES.map((d) => ({ code: d.icd10, label: d.label, leaf: true }))}
          selected={problems.map((pr) => pr.icd10)}
          onPick={(e) => add({ label: e.label, icd10: e.code })}
          placeholder="pneumonia · J18.9 · stroke…"
          ariaLabel="Search ICD-10 to add a problem"
        />

        {/* AI-501's rule and its worked example, folded together. */}
        <Why label="Why a parent code is refused" className="mt-[12px]">
          <p>
            A parent category will not group for a claim and will not satisfy a coder audit, so the field refuses it and says why. The suggestion list shows
            both, so the refusal is legible rather than mysterious. The manual path is never removed.
          </p>
          <ul className="flex flex-col gap-[8px]">
            {CODE_SUGGESTIONS.map((s) => (
              <li key={s.icd10} className={cn('flex flex-wrap items-center justify-between gap-[8px] rounded-[14px] px-[12px] py-[10px]', s.leaf ? 'bg-sh-inner' : 'bg-sh-crit-bg')}>
                <span className="min-w-0">
                  <span className="font-medium tabular-nums text-sh-text">{s.icd10}</span>
                  <span className="ml-[8px] text-sh-text-2">{s.label}</span>
                </span>
                {s.leaf ? (
                  <PillTag tone="norm" size="xs" icon={Check}>
                    selectable
                  </PillTag>
                ) : (
                  <PillTag tone="crit" size="xs" icon={Ban}>
                    parent-only — blocked
                  </PillTag>
                )}
              </li>
            ))}
          </ul>
        </Why>
      </Card>
    </ScreenFrame>
  )
}

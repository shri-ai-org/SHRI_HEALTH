/**
 * S-18-14 · Imaging triage — `/stroke/case/:id/imaging` (`src/screens/m18/
 * S1814.tsx`): "LVO found, and on the neurologist's phone four minutes later."
 *
 * Its drawing notes are hard requirements: phone-first (the on-call is at home
 * at 02:00); the card names MODEL@VERSION, because a finding with no
 * provenance is not actionable clinically or legally; G3 — it PRIORITISES AND
 * NOTIFIES, IT NEVER DIAGNOSES, said on the frame; ICH shown as an explicit
 * NO, because that negative is what unlocks thrombolysis. Break-glass is the
 * normal path: a remote on-call has no care relationship with a patient at
 * another site, so the screen asks for it and never refuses.
 *
 * A case that is not a large-vessel occlusion gets its own card (`NotLvo`).
 *
 * Changed from the old screen: the schematic slice is the case's real NCCT
 * (the viewer S-18-21 uses), its overlay switch the viewer's own. Break-glass
 * writes an `ACCESS.BREAK_GLASS` audit row, and the amber strip is the patient
 * banner's — no second banner. Fixed: "confirmed" showed after ANY decision
 * on the finding, a rejection included, and gave the time of viewing as the
 * time of confirmation.
 */

import { Activity, Check, Cpu, Grid2x2, PhoneCall, ShieldAlert, Syringe, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { IMAGING_TRIAGE, type StrokeCase } from '@/data/stroke'
import { overlaysFor, studyFor } from '@/data/strokeai'
import { useAI } from '@/store/ai'
import { useAudit } from '@/store/audit'
import { useCurrentStaff, useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useCaseClock } from '../logic/caseClock'
import { useStrokeCaseParam } from '../logic/strokeCase'
import { useAiActive } from '../state/ai'
import { AIActionBar } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Why } from '../ui/Disclosure'
import { KeyValue } from '../ui/KeyValue'
import { NcctViewer } from '../ui/NcctViewer'
import { Card, ConfidenceMark, Diamond, Icon, Pill, PillTag } from '../ui/primitives'

import { CaseClockStrip } from './CaseClockStrip'
import { NoCase, NonLvoTriage } from './NotLvo'

const BREAK_GLASS_REASON = 'On-call stroke neurologist reviewing a spoke-site activation'

/** The index case's LVO frame for an occlusion; its own card for anything else. */
export function ImagingTriagePage() {
  const { id, strokeCase: c } = useStrokeCaseParam()
  if (!c) return <NoCase screenId="S-18-14" id={id} />
  return c.imaging.lvo ? <LvoView key={c.id} c={c} /> : <NonLvoTriage key={c.id} c={c} />
}

function LvoView({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const audit = useAudit((s) => s.record)
  const aiActive = useAiActive()
  const touchpointId = `imaging:${c.id}:lvo`
  const decision = useAI((s) => s.dispositions[touchpointId])
  const grantBreakGlass = useSession((s) => s.grantBreakGlass)
  const p = patient(c.patientId)
  const glass = useSession((s) => s.breakGlassPatients[p.id])
  useCaseClock()
  const [calling, setCalling] = useState<'neuro-interventionist' | 'radiologist' | null>(null)

  const confirmed = decision?.disposition === 'Accepted' || decision?.disposition === 'Accepted with edits' ? decision : undefined
  const rejected = decision && !confirmed ? decision : undefined
  const minsFromRecon = Math.round((IMAGING_TRIAGE.deliveredAt.getTime() - IMAGING_TRIAGE.reconstructedAt.getTime()) / 60000)
  const study = studyFor(c.id)
  const overlays = study && aiActive ? overlaysFor(study.key, c) : []
  const first = overlays[0]
  const to = { aspects: `/stroke/case/${c.id}/aspects`, perfusion: `/stroke/case/${c.id}/perfusion`, eligibility: `/stroke/case/${c.id}/thrombolysis` }

  return (
    <ScreenFrame
      screenId="S-18-14"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="Imaging triage"
      sub={`${IMAGING_TRIAGE.study} · delivered ${formatTime(IMAGING_TRIAGE.deliveredAt)}, ${minsFromRecon} min after reconstruction`}
      chips={
        confirmed ? (
          <PillTag tone="norm" size="sm" icon={Check}>
            confirmed
          </PillTag>
        ) : rejected ? (
          <PillTag tone="warn" size="sm" icon={X}>
            {rejected.disposition.toLowerCase()}
          </PillTag>
        ) : (
          <PillTag tone="warn" size="sm" icon={ShieldAlert}>
            confirm required
          </PillTag>
        )
      }
      actions={
        <>
          {may(to.aspects) && (
            <Pill variant="card" size="xl" icon={Grid2x2} iconSize={17} onClick={() => navigate(to.aspects)}>
              ASPECTS
            </Pill>
          )}
          {may(to.perfusion) && (
            <Pill variant="card" size="xl" icon={Activity} iconSize={17} onClick={() => navigate(to.perfusion)}>
              Perfusion
            </Pill>
          )}
        </>
      }
      railTitle="Provenance"
      rail={
        <div className="flex flex-col gap-[12px]">
          <Card titleSize="sm" title="Provenance">
            <dl className="flex flex-col divide-y divide-sh-line">
              <KeyValue label="Study">
                <span className="tabular-nums">{IMAGING_TRIAGE.studyId}</span>
              </KeyValue>
              <KeyValue label="Acquired">
                <span className="tabular-nums">{formatTime(IMAGING_TRIAGE.acquiredAt)}</span>
              </KeyValue>
              <KeyValue label="Reconstructed">
                <span className="tabular-nums">{formatTime(IMAGING_TRIAGE.reconstructedAt)}</span>
              </KeyValue>
            </dl>
          </Card>
          <Why label="How to read this card">
            <p>
              A finding with no model and no version is not actionable, clinically or legally. That is why the card names both on its face rather than in a drawer, and why what
              the model does not do is listed in full behind Why? on the finding itself.
            </p>
            <p>The overlay is drawn on a copy. The unmarked image is always one tap away, and nothing the model draws is burned into the study.</p>
          </Why>
        </div>
      }
      actionBar={
        <>
          <span className="text-[13px] text-sh-text-3">
            {confirmed ? `Confirmed by ${confirmed.by}` : rejected ? `${rejected.disposition} by ${rejected.by}` : 'A G3 finding needs a named clinician to confirm it'}
          </span>
          <div className="ml-auto flex flex-wrap gap-[8px]">
            <Pill variant="control" size="bar" icon={PhoneCall} onClick={() => setCalling('neuro-interventionist')}>
              Escalate to the neuro-interventionist
            </Pill>
            {may(to.eligibility) && (
              <Pill variant="primary" size="bar" icon={Syringe} onClick={() => navigate(to.eligibility)}>
                Go to eligibility
              </Pill>
            )}
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-[20px]">
        {/* Break-glass is the normal path for a remote on-call. Once granted, the banner's amber strip says so — once. */}
        {!glass && (
          <Alert
            tone="warn"
            title="You have no care relationship with this patient"
            action={
              <Pill
                variant="primary"
                size="lg"
                icon={ShieldAlert}
                onClick={() => {
                  grantBreakGlass(p.id, BREAK_GLASS_REASON)
                  audit({ event: 'ACCESS.BREAK_GLASS', actor: me.name, actorId: me.id, subject: p.id, detail: `${BREAK_GLASS_REASON} · ${c.caseNo} · S-18-14` })
                  toast({ tone: 'caution', title: 'Break-glass access granted', detail: 'Logged and reviewed within 24 hours. An amber banner stays up while you are in the record.' })
                }}
              >
                Break glass
              </Pill>
            }
          >
            {p.name} is at {c.originFacility} and you are the hub on-call. You are not refused — state a reason and proceed. An authorization model that can block a code stroke is
            the wrong model.
          </Alert>
        )}

        {/* Phone-first: a single column on a phone; the image and the findings side by side from lg. */}
        <div className="mx-auto grid w-full max-w-[448px] grid-cols-1 gap-[16px] lg:max-w-none lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-[20px]">
          <Card className="min-w-0" title={<span className="text-[15px] font-semibold tabular-nums">{`${p.name} · ${p.age}/${p.sex}`}</span>} titleSize="sm">
            {study ? (
              <NcctViewer key={c.id} study={study} overlays={overlays} initialSlice={first ? Math.round((first.from + first.to) / 2) : undefined} />
            ) : (
              <p className="text-[14px] text-sh-text-2">No study has been imported for this case.</p>
            )}
          </Card>

          <div className="flex min-w-0 flex-col gap-[16px]">
            <Card titleSize="sm" title={<span className="flex items-center gap-[8px]">{aiActive && <Diamond />}{aiActive ? 'AI findings' : 'Awaiting a radiologist read'}</span>}>
              {aiActive ? (
                <>
                  <dl className="flex flex-col divide-y divide-sh-line">
                    {IMAGING_TRIAGE.findings.map((f) => (
                      <div key={f.label} className="flex flex-wrap items-center justify-between gap-[8px] py-[10px]">
                        <dt className="text-[14px] text-sh-text-2">{f.label}</dt>
                        <dd className="flex flex-wrap items-center gap-[8px]">
                          <span className={cn('font-bold tabular-nums', f.emphasisNegative ? 'text-[18px] text-sh-norm-fg' : 'text-[16px] text-sh-text')}>{f.value}</span>
                          {f.emphasisNegative && (
                            <PillTag tone="norm" size="sm" icon={Check}>
                              unlocks thrombolysis
                            </PillTag>
                          )}
                          {f.band && <ConfidenceMark band={f.band} score={f.confidence} />}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {/* The one place model@version is named. */}
                  <p className="mt-[12px] flex flex-wrap items-center gap-[8px] rounded-[12px] bg-sh-inner px-[12px] py-[8px] text-[13px] tabular-nums text-sh-text-2">
                    <Icon icon={Cpu} size={13} />
                    {IMAGING_TRIAGE.model}
                  </p>
                  <AIActionBar
                    className="mt-[12px]"
                    touchpointId={touchpointId}
                    capabilityId="AI-404"
                    gate="G3"
                    band="HIGH"
                    score={0.94}
                    subject={p.id}
                    explain={{
                      touchpointId,
                      capabilityId: 'AI-404',
                      claim: 'A large-vessel occlusion is detected in the left M1 segment. This is a prioritisation and notification finding, not a diagnosis.',
                      confidence: 0.94,
                      band: 'HIGH',
                      computedAt: formatTime(IMAGING_TRIAGE.deliveredAt),
                      inputs: [
                        { label: `${IMAGING_TRIAGE.study}, ${IMAGING_TRIAGE.studyId}`, source: `Acquired ${formatTime(IMAGING_TRIAGE.acquiredAt)}` },
                        { label: 'Hyperdense vessel sign on the NCCT', source: 'Axial series, slice 14' },
                        { label: 'CTA vessel run-off', source: 'Arterial phase' },
                      ],
                      evidence: ['Abrupt calibre change at the left M1 origin with no distal opacification.', 'Asymmetry of the insular ribbon on the same side.'],
                      model: IMAGING_TRIAGE.model,
                      limits: IMAGING_TRIAGE.limits,
                    }}
                  />
                  <p className="mt-[12px] rounded-[12px] bg-sh-warn-bg px-[12px] py-[10px] text-[14px] font-medium text-sh-warn-fg">
                    G3 · this prioritises and notifies. <strong>It never diagnoses.</strong> The finding does not enter the record until a named clinician confirms it.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[14px] text-sh-text-2">The AI is off, so no automated finding is shown. The study is in the radiologist’s worklist in the normal, unprioritised order.</p>
                  <p className="mt-[8px] text-[13px] text-sh-text-3">That is the documented fallback for AI-404: a radiologist or neurologist read. The clock keeps running either way.</p>
                  <div>
                    <Pill variant="control" size="lg" icon={PhoneCall} className="mt-[12px]" onClick={() => setCalling('radiologist')}>
                      Call the radiologist on call
                    </Pill>
                  </div>
                </>
              )}
            </Card>

            {confirmed && (
              <Alert tone="info" icon={Check} title="Finding confirmed">
                {confirmed.by} confirmed the LVO at {formatTime(confirmed.at)}. It is now part of the case record and the thrombectomy pathway is live.
              </Alert>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={calling !== null}
        title={calling === 'radiologist' ? 'Call the radiologist on call?' : 'Escalate to the neuro-interventionist?'}
        consequence={
          calling === 'radiologist'
            ? 'Rings the on-call radiologist for an immediate read. The request and the time are logged against the case.'
            : 'Rings Dr. Rajsrinivas and pages the cath lab. The escalation and the time are logged against the case.'
        }
        confirmLabel="Call now"
        onConfirm={() => {
          const who = calling === 'radiologist' ? 'the radiologist on call' : 'Dr. Rajsrinivas'
          setCalling(null)
          toast({ tone: 'info', title: `Calling ${who}`, detail: `Logged against case ${c.caseNo}.` })
        }}
        onCancel={() => setCalling(null)}
      />
    </ScreenFrame>
  )
}

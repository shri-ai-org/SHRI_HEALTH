/**
 * S-18-16 · Perfusion — `/stroke/case/:id/perfusion` (`src/screens/m18/
 * S1816.tsx`): "Core, penumbra and whether there is tissue worth saving."
 *
 * Two quantities of the same kind, so one chart with one axis: a split bar,
 * both segments directly labelled — core and penumbra on separate scales would
 * make the mismatch ratio meaningless. The interpretation is written once, on
 * the quantification card; each threshold once, on the tile it judges. With
 * the AI off you lose the numbers, not the images, and the screen says so. A
 * case that is not an occlusion under reperfusion assessment is told why it
 * does not apply (`NotLvo`).
 *
 * The maps are the old schematic, drawn in theme tokens.
 */

import { Ban, Check, Grid2x2, Route } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { PERFUSION, type StrokeCase } from '@/data/stroke'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { useCaseClock } from '../logic/caseClock'
import { useStrokeCaseParam } from '../logic/strokeCase'
import { useAiActive } from '../state/ai'
import { AIActionBar } from '../ui/ai'
import { Alert } from '../ui/Alert'
import { Why } from '../ui/Disclosure'
import { Card, ConfidenceMark, Diamond, Pill, PillTag } from '../ui/primitives'

import { CaseClockStrip } from './CaseClockStrip'
import { SplitBar } from './charts'
import { NoCase, NotApplicable } from './NotLvo'

/** Each threshold is stated once, on the tile it judges. */
const MEASURES = [
  { label: 'Core', value: `${PERFUSION.coreMl} mL`, threshold: '< 70 mL', ok: PERFUSION.coreMl < 70 },
  { label: 'Penumbra', value: `${PERFUSION.penumbraMl} mL`, threshold: '> 15 mL', ok: PERFUSION.penumbraMl > 15 },
  { label: 'Mismatch ratio', value: String(PERFUSION.mismatchRatio), threshold: '> 1.8', ok: PERFUSION.mismatchRatio > 1.8 },
  { label: 'Hypoperfusion index', value: String(PERFUSION.hypoperfusionIndex), threshold: '< 0.4 favours collaterals', ok: PERFUSION.hypoperfusionIndex < 0.4 },
]

const MAPS = [
  { title: 'Core — rCBF < 30%', fill: 'var(--crit-solid)', size: 24 },
  { title: 'Penumbra — Tmax > 6s', fill: 'var(--pend-fg)', size: 46 },
]

/** Drawn for an occlusion under reperfusion assessment; anything else is told why it does not apply. */
export function PerfusionPage() {
  const { id, strokeCase: c } = useStrokeCaseParam()
  if (!c) return <NoCase screenId="S-18-16" id={id} />
  return c.imaging.lvo ? <LvoView key={c.id} c={c} /> : <NotApplicable key={c.id} c={c} screenId="S-18-16" heading="Perfusion" what="CT perfusion" />
}

function LvoView({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const aiActive = useAiActive()
  const caseNow = useCaseClock()
  const p = patient(c.patientId)
  const to = { aspects: `/stroke/case/${c.id}/aspects`, evt: `/stroke/case/${c.id}/evt` }

  return (
    <ScreenFrame
      screenId="S-18-16"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="Perfusion"
      sub={`core ${PERFUSION.coreMl} mL · penumbra ${PERFUSION.penumbraMl} mL · ratio ${PERFUSION.mismatchRatio} · ${PERFUSION.targetMismatch ? 'target mismatch' : 'no target mismatch'}`}
      actions={
        <>
          {may(to.aspects) && (
            <Pill variant="card" size="xl" icon={Grid2x2} iconSize={17} onClick={() => navigate(to.aspects)}>
              ASPECTS
            </Pill>
          )}
          {may(to.evt) && (
            <Pill variant="primary" size="xl" icon={Route} iconSize={17} onClick={() => navigate(to.evt)}>
              EVT decision
            </Pill>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-[20px]">
        {/* The documented fallback: you lose the numbers, not the images. */}
        {!aiActive && (
          <Alert tone="warn" title="Quantification is unavailable">
            The vendor perfusion maps are still on the workstation and can be read manually. That is the documented fallback for AI-406 — you lose the numbers, not the images.
          </Alert>
        )}

        <Card titleSize="sm" title="Volumes" right={<span className="text-[13px] text-sh-text-3">millilitres of brain — one measure, one axis</span>}>
          <SplitBar
            unit="mL"
            parts={[
              { label: 'Ischaemic core — already lost', value: PERFUSION.coreMl, slot: 1 },
              { label: 'Penumbra — salvageable', value: PERFUSION.penumbraMl, slot: 2 },
            ]}
            caption={`mismatch ratio ${PERFUSION.mismatchRatio}`}
          />
          <dl className="mt-[20px] grid gap-[12px] sm:grid-cols-2 xl:grid-cols-4">
            {MEASURES.map((m) => (
              <div key={m.label} className="rounded-[14px] bg-sh-inner px-[14px] py-[12px]">
                <dt className="text-[12px] uppercase tracking-[0.06em] text-sh-text-3">{m.label}</dt>
                <dd className="mt-[4px] text-[20px] font-semibold tabular-nums text-sh-text">{m.value}</dd>
                <PillTag tone={m.ok ? 'norm' : 'crit'} size="sm" icon={m.ok ? Check : Ban} className="mt-[6px] tabular-nums">
                  {m.threshold}
                </PillTag>
              </div>
            ))}
          </dl>
        </Card>

        {/* The one place the interpretation is written. */}
        {aiActive && (
          <Card className="border-l-[3px] border-sh-ai">
            <div className="flex flex-wrap items-start justify-between gap-[8px]">
              <h2 className="flex items-center gap-[8px] text-[17px] font-medium text-sh-text">
                <Diamond />
                Quantification
              </h2>
              <ConfidenceMark band="HIGH" score={PERFUSION.confidence} />
            </div>
            <p className="mt-[8px] text-[14px]/[1.6] text-sh-text-2">{PERFUSION.interpretation}</p>
            <AIActionBar
              className="mt-[12px]"
              touchpointId={`perfusion:${c.id}`}
              capabilityId="AI-406"
              gate="G2"
              band="HIGH"
              score={PERFUSION.confidence}
              subject={p.id}
              explain={{
                touchpointId: `perfusion:${c.id}`,
                capabilityId: 'AI-406',
                claim: `Core ${PERFUSION.coreMl} mL and penumbra ${PERFUSION.penumbraMl} mL, a mismatch ratio of ${PERFUSION.mismatchRatio}. This is a target mismatch profile.`,
                confidence: PERFUSION.confidence,
                band: 'HIGH',
                computedAt: formatTime(caseNow),
                inputs: [
                  { label: 'CT perfusion source series', source: 'Study ST-9914, perfusion phase' },
                  { label: 'Arterial input function', source: 'Automatically selected, MCA' },
                  { label: 'rCBF < 30% threshold for core', source: 'Vendor algorithm default' },
                  { label: 'Tmax > 6s threshold for penumbra', source: 'Vendor algorithm default' },
                ],
                evidence: ['Core defined at rCBF below 30% of the contralateral side.', 'Penumbra defined at Tmax above 6 seconds.'],
                model: PERFUSION.model,
                limits: [
                  'Thresholds are vendor defaults and are a convention, not a physical boundary.',
                  'Motion during acquisition inflates the core volume.',
                  'A poorly chosen arterial input function shifts both volumes in the same direction.',
                  'The vendor maps remain readable manually if this is unavailable.',
                ],
              }}
            />
          </Card>
        )}

        {/* The maps, schematically. */}
        <Card titleSize="sm" title="Maps" right={<span className="text-[13px] text-sh-text-3">the same slice, side by side</span>}>
          <div className="grid gap-[16px] sm:grid-cols-2">
            {MAPS.map((m) => (
              <figure key={m.title} className="m-0 overflow-hidden rounded-[14px] bg-sh-inner">
                <figcaption className="px-[12px] py-[10px] text-[13px] font-semibold text-sh-text">{m.title}</figcaption>
                <div className="aspect-square w-full p-[16px]">
                  <svg viewBox="0 0 200 200" className="size-full" role="img" aria-label={m.title}>
                    <ellipse cx="100" cy="100" rx="76" ry="90" fill="var(--card)" stroke="var(--line-strong)" strokeWidth="4" />
                    <ellipse cx="100" cy="100" rx="66" ry="80" fill="var(--control)" />
                    <path d="M100 18 L100 182" stroke="var(--line-strong)" strokeWidth="2" />
                    <ellipse cx="130" cy="96" rx={m.size} ry={m.size * 1.25} fill={m.fill} opacity="0.85" />
                    <text x="150" y="190" fontSize="8" fill="var(--text-2)">
                      left
                    </text>
                  </svg>
                </div>
              </figure>
            ))}
          </div>
        </Card>

        <Why label="Why one axis, and what these volumes do not decide">
          <p>Core and penumbra are the same quantity — millilitres of brain. Plotted on two scales, the mismatch ratio stops meaning anything. One bar, one axis, both segments labelled.</p>
          <p>The volumes decide whether there is tissue worth reperfusing. They do not decide whether to do it — that is the EVT selection screen, under its own gate.</p>
        </Why>
      </div>
    </ScreenFrame>
  )
}

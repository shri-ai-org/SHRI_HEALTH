/**
 * S-18-21 · Stroke-AI Console — `/stroke/ai-console` (`src/screens/m18/
 * S1821.tsx`): "The scan, the reading, and the decision it unlocks — on one
 * surface."
 *
 * A real non-contrast head CT beside the model's reading of it, the clinical
 * report underneath, and a clinician's signature between the reading and any
 * treatment. Load-bearing, not styling:
 *   THE PIXELS ARE REAL — an imported head-CT study, windowed W 80 / L 40; the
 *     findings come from that study's own labels, so a study with blood in it
 *     reports haemorrhage and flips the thrombolysis card without a word of
 *     copy changing;
 *   THE UNMARKED IMAGE IS ONE CONTROL AWAY (AIP-04);
 *   G3 — AI-404 prioritises and notifies. It never diagnoses, and the reading
 *     enters the record only over a clinician's signature.
 *
 * `?case=` opens a named case — how a record and the imaging viewer deep-link
 * here; without it, the first active case. Where the old console fell short:
 * switching case kept the last case's slice, zoom and overlay switch (here
 * each case's scan opens afresh, on its finding).
 */

import { BookOpen, Brain, Check, CircleSlash, Cpu, Network, Siren } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { IMAGING_TRIAGE } from '@/data/stroke'
import { DECISION_SUPPORT_NOTICE, casesWithImaging, ncctFindings, overlaysFor, studyFor, triageVerdict } from '@/data/strokeai'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { NCCT_MODEL } from '../logic/imaging'
import { useAiActive, useForcedState } from '../state/ai'
import { AIActionBar } from '../ui/ai'
import { Disclosure, Why } from '../ui/Disclosure'
import { NcctViewer } from '../ui/NcctViewer'
import { Card, ConfidenceMark, CountBubble, Icon, Pill, PillTag } from '../ui/primitives'

import { StrokeAIReport } from './StrokeAIReport'

const VERDICT_PILL = { critical: 'bg-sh-crit-solid text-sh-on-crit-solid', caution: 'bg-sh-warn text-sh-text', normal: 'bg-sh-norm-bg text-sh-norm-fg' } as const

export function AiConsolePage() {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const aiActive = useAiActive()
  const forced = useForcedState()
  const cases = casesWithImaging()
  const [params, setParams] = useSearchParams()
  const asked = params.get('case')
  const selectedId = (asked && cases.some((c) => c.id === asked) ? asked : undefined) ?? cases.find((c) => c.status === 'active')?.id ?? cases[0]?.id
  const select = (id: string) => {
    const next = new URLSearchParams(params)
    next.set('case', id)
    setParams(next, { replace: true })
  }

  const current = cases.find((c) => c.id === selectedId) ?? cases[0]
  const study = current ? studyFor(current.id) : undefined
  const truth = study?.truth
  const findings = truth && current ? ncctFindings(truth, current) : []
  const verdict = truth && current ? triageVerdict(truth, current) : undefined
  const active = cases.filter((c) => c.status === 'active').length

  if (!current || !study || !truth || !verdict) {
    return (
      <ScreenFrame screenId="S-18-21" heading="Stroke-AI Console" sub="No imaged case is open.">
        <Card titleSize="sm" title="Nothing to read">
          <p className="text-[14px] text-sh-text-2">No stroke case currently has an imported study. A code stroke with a completed scan appears here within seconds of reconstruction.</p>
        </Card>
      </ScreenFrame>
    )
  }

  const p = patient(current.patientId)
  const img = current.imaging
  // Scan to reading, as a clinician would say it: "4 min 00 s".
  const readSeconds = Math.round((img.deliveredAt.getTime() - img.acquiredAt.getTime()) / 1000)
  const readTime = `${Math.floor(readSeconds / 60)} min ${String(readSeconds % 60).padStart(2, '0')} s`
  const model = img.lvo ? IMAGING_TRIAGE.model : NCCT_MODEL
  const band = forced === 'AI-LOW' ? ('LOW' as const) : ('HIGH' as const)
  const overlays = aiActive ? overlaysFor(study.key, current) : []
  const first = overlays[0]
  const record = `/patient/${p.uhid}`
  const wall = '/stroke/wall'
  const touchpointId = `strokeai:${current.id}:ncct`

  return (
    <ScreenFrame
      screenId="S-18-21"
      heading="Stroke-AI Console"
      sub={`${cases.length} imaged ${cases.length === 1 ? 'case' : 'cases'} · ${active} active · ${current.caseNo} read at ${formatTime(img.deliveredAt)}`}
      actions={
        <>
          {may(record) && (
            <Pill variant="card" size="xl" icon={BookOpen} iconSize={17} onClick={() => navigate(record)}>
              Patient record
            </Pill>
          )}
          {may(wall) && (
            <Pill variant="card" size="xl" icon={Network} iconSize={17} onClick={() => navigate(wall)}>
              Command wall
            </Pill>
          )}
        </>
      }
    >
      <div className="grid min-w-0 grid-cols-1 items-start gap-[20px] lg:grid-cols-[minmax(0,4fr)_minmax(0,9fr)]">
        {/* The cases with a study behind them. Active first. */}
        <Card titleSize="sm" title="Cases" right={<CountBubble className={active > 0 ? 'bg-sh-crit-bg text-sh-crit-fg' : 'bg-sh-inner'}>{`${active} active`}</CountBubble>}>
          <ul aria-label="Imaged stroke cases" className="flex flex-col">
            {cases.map((c, i) => {
              const cp = patient(c.patientId)
              const open = c.id === current.id
              const live = c.status === 'active'
              return (
                <li key={c.id} className={cn(i > 0 && 'border-t border-sh-line')}>
                  <button
                    type="button"
                    onClick={() => select(c.id)}
                    aria-current={open ? true : undefined}
                    className={cn('flex min-h-[64px] w-full items-center gap-[12px] rounded-[14px] px-[10px] py-[10px] text-left transition-colors duration-150', open ? 'bg-sh-hover-strong' : 'hover:bg-sh-hover')}
                  >
                    <span className={cn('grid size-[36px] shrink-0 place-items-center rounded-[12px]', live ? 'bg-sh-crit-bg text-sh-crit-fg' : 'bg-sh-inner text-sh-text-2')}>
                      <Icon icon={Brain} size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold text-sh-text">{cp.name}</span>
                      <span className="block truncate text-[12px] tabular-nums text-sh-text-2">
                        {c.id} · {cp.age}/{cp.sex} · NIHSS {c.nihss}
                      </span>
                    </span>
                    <PillTag tone={live ? 'crit' : 'neu'} size="xs" icon={live ? Siren : c.status === 'closed' ? Check : CircleSlash} className="font-semibold">
                      {live ? 'Active' : c.status === 'closed' ? 'Closed' : 'Stood down'}
                    </PillTag>
                  </button>
                </li>
              )
            })}
          </ul>
        </Card>

        <div className="flex min-w-0 flex-col gap-[20px]">
          {/* The verdict, stated once and in one line. */}
          <Card
            titleSize="sm"
            title="AI triage verdict"
            right={<span className={cn('inline-flex min-h-[24px] items-center rounded-full px-[10px] text-[12px] font-bold tabular-nums', VERDICT_PILL[verdict.tone])}>{`${verdict.priority} · ${verdict.priorityWord}`}</span>}
            className={cn(verdict.tone === 'critical' && 'shadow-[inset_4px_0_0_var(--crit)]', verdict.tone === 'caution' && 'shadow-[inset_4px_0_0_var(--warn)]')}
          >
            <p className="text-[18px] font-bold tracking-[-0.01em] text-sh-text">{verdict.headline}</p>
            <p className="mt-[4px] text-[14px] text-sh-text-2">{verdict.detail}</p>
            <div className="mt-[10px] flex flex-wrap gap-[6px]">
              {verdict.chips.map((c) => (
                <PillTag key={c} tone={c.includes('NEGATIVE') || c.includes('NO ') ? 'norm' : 'crit'} size="xs" className="font-semibold">
                  {c}
                </PillTag>
              ))}
            </div>
          </Card>

          {/* The scan and its reading, side by side. */}
          <Card titleSize="sm" title="Non-contrast CT" right={<span className="text-[12px] tabular-nums text-sh-text-2">{`${p.name} · acquired ${formatTime(img.acquiredAt)}`}</span>}>
            <div className="grid min-w-0 grid-cols-1 gap-[20px] xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
              {/* Each case's scan opens afresh, on its finding. */}
              <NcctViewer key={current.id} study={study} overlays={overlays} initialSlice={first ? Math.round((first.from + first.to) / 2) : undefined} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-[8px]">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">AI findings</h3>
                  <span className="text-[12px] tabular-nums text-sh-text-2">read in {readTime}</span>
                </div>
                {aiActive ? (
                  <>
                    <ul className="mt-[8px] divide-y divide-(--line)">
                      {findings.map((f) => (
                        <li key={f.label} className="py-[10px]">
                          <div className="flex flex-wrap items-baseline justify-between gap-x-[12px] gap-y-[4px]">
                            <span className="min-w-0 text-[14px] font-medium text-sh-text">{f.label}</span>
                            <span className={cn('font-bold tabular-nums', f.critical ? 'text-sh-crit-fg' : f.reassuring ? 'text-sh-norm-fg' : 'text-sh-text')}>{f.value}</span>
                          </div>
                          <div className="mt-[2px] flex flex-wrap items-center gap-x-[8px] gap-y-[4px] text-[12px] text-sh-text-2">
                            <span className="min-w-0">{f.gloss}</span>
                            <ConfidenceMark band={f.band} score={f.confidence} />
                            {f.concordant && (
                              <span className="text-sh-norm-fg" title="The reporting radiologist agreed">
                                radiologist agrees
                              </span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-[8px] flex items-center gap-[8px] rounded-[12px] bg-sh-inner px-[12px] py-[8px] text-[12px] tabular-nums text-sh-text-2">
                      <Icon icon={Cpu} size={13} />
                      {model} · study {study.sourcePatientId} · {study.seriesTotal} images
                    </p>
                    <AIActionBar
                      className="mt-[12px]"
                      touchpointId={touchpointId}
                      capabilityId="AI-404"
                      gate="G3"
                      band={band}
                      score={band === 'LOW' ? undefined : 0.94}
                      subject={p.id}
                      explain={{
                        touchpointId,
                        capabilityId: 'AI-404',
                        claim: `${verdict.headline}. ${verdict.detail}`,
                        confidence: 0.94,
                        band,
                        computedAt: formatTime(img.deliveredAt),
                        inputs: [
                          { label: `Non-contrast CT head, ${study.seriesTotal} images`, source: `${study.seriesDescription} · ${study.sliceThickness} mm` },
                          ...(img.lvo ? [{ label: 'CT angiogram, arch to vertex', source: IMAGING_TRIAGE.study }] : []),
                          { label: 'Last known well and NIHSS', source: `Case ${current.caseNo}` },
                        ],
                        evidence: [
                          `Haemorrhage classifier ${truth.ich ? 'positive' : 'negative'} at 0.97 across all five subtypes.`,
                          img.lvo
                            ? 'Hyperdense left MCA on the source images, with M1 cut-off on the angiogram.'
                            : img.lesion
                              ? `${img.lesion.site}${img.lesion.volumeMl ? `, about ${img.lesion.volumeMl} mL` : ''}${img.lesion.shiftMm ? `, ${img.lesion.shiftMm} mm midline shift` : ''}.`
                              : 'No focal abnormality marked on the source images.',
                        ],
                        model,
                        limits: IMAGING_TRIAGE.limits,
                      }}
                    />
                    <Why label="What this reading is, and is not" className="mt-[12px]">
                      <p>{DECISION_SUPPORT_NOTICE}</p>
                      <p className="mt-[8px]">G3 — AI-404 prioritises the study and notifies a named clinician. It does not diagnose, and nothing it reports enters the record until you sign for it.</p>
                    </Why>
                  </>
                ) : (
                  <p className="mt-[8px] rounded-[12px] bg-sh-inner px-[12px] py-[12px] text-[14px] text-sh-text-2">
                    Automated reading is off. The study is unchanged and the radiologist worklist is the route — unprioritised, in arrival order. The clock keeps running.
                  </p>
                )}
              </div>
            </div>
          </Card>

          {/* The full report, folded — it is a document, not a dashboard. */}
          <Card titleSize="sm" title="Clinical report" right={<span className="text-[12px] text-sh-text-2">{current.caseNo}</span>}>
            <Disclosure label="the full Stroke-AI report">
              <StrokeAIReport strokeCase={current} study={study} />
            </Disclosure>
          </Card>
        </div>
      </div>
    </ScreenFrame>
  )
}

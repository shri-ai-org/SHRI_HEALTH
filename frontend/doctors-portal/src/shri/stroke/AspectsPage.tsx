/**
 * S-18-15 · ASPECTS — `/stroke/case/:id/aspects` (`src/screens/m18/
 * S1815.tsx`): "ASPECTS scored by the model and adjusted by the human, both
 * kept."
 *
 * Both kept is the design. The model's score and the human's adjusted score
 * sit side by side in the record — overwriting the model score would erase the
 * disagreement, and the disagreement is the most useful thing on the screen
 * for whoever audits the model later. The regions that lost a point are the
 * surface; the normal ones fold behind one line and stay editable. A case that
 * is not an occlusion under reperfusion assessment is told why it does not
 * apply (`NotLvo`).
 *
 * The region map is a schematic, drawn in the theme's own tokens rather than
 * the old fixed greys, so it reads in both themes.
 */

import { Activity, Check, Scan } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { ASPECTS_REGIONS, type StrokeCase } from '@/data/stroke'
import { useCurrentStaff } from '@/store/session'
import { useStroke } from '@/store/stroke'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useCaseClock } from '../logic/caseClock'
import { useStrokeCaseParam } from '../logic/strokeCase'
import { useAiActive } from '../state/ai'
import { Alert } from '../ui/Alert'
import { Disclosure, Why } from '../ui/Disclosure'
import { KeyValue } from '../ui/KeyValue'
import { Card, ConfidenceMark, Diamond, Pill } from '../ui/primitives'

import { CaseClockStrip } from './CaseClockStrip'
import { NoCase, NotApplicable } from './NotLvo'

type Region = (typeof ASPECTS_REGIONS)[number]

/** Drawn for an occlusion under reperfusion assessment; anything else is told why it does not apply. */
export function AspectsPage() {
  const { id, strokeCase: c } = useStrokeCaseParam()
  if (!c) return <NoCase screenId="S-18-15" id={id} />
  return c.imaging.lvo ? <LvoView key={c.id} c={c} /> : <NotApplicable key={c.id} c={c} screenId="S-18-15" heading="ASPECTS" what="ASPECTS" />
}

function LvoView({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const aiActive = useAiActive()
  const caseNow = useCaseClock()
  const aspectsHuman = useStroke((s) => s.aspectsHuman)
  const setAspectsRegion = useStroke((s) => s.setAspectsRegion)
  const p = patient(c.patientId)
  const [recorded, setRecorded] = useState(false)

  const modelScore = 10 - ASPECTS_REGIONS.filter((r) => r.aiAffected).length
  const humanAffected = (r: Region) => aspectsHuman[r.key] ?? r.aiAffected
  const humanScore = 10 - ASPECTS_REGIONS.filter(humanAffected).length
  const disagreements = ASPECTS_REGIONS.filter((r) => humanAffected(r) !== r.aiAffected)
  /** The regions that cost a point — or that you moved — are the ones in view. */
  const inView = ASPECTS_REGIONS.filter((r) => humanAffected(r) || r.aiAffected)
  const normal = ASPECTS_REGIONS.filter((r) => !inView.includes(r))
  const to = { triage: `/stroke/case/${c.id}/imaging`, perfusion: `/stroke/case/${c.id}/perfusion` }

  /** One region. Affected regions carry the model's own verdict inline. */
  const regionRow = (r: Region, full: boolean) => {
    const affected = humanAffected(r)
    const changed = affected !== r.aiAffected
    return (
      <li key={r.key} className={cn('flex flex-wrap items-center justify-between gap-[8px] rounded-[12px] px-[12px]', full ? 'py-[10px]' : 'py-[8px]', changed && 'bg-sh-warn-bg')}>
        <span className="min-w-0">
          <span className={cn('block font-medium', full ? 'text-[14px] text-sh-text' : 'text-[14px] text-sh-text-2')}>{r.label}</span>
          {full && aiActive && (
            <span className="flex items-center gap-[6px] text-[12px] text-sh-text-3">
              <Diamond />
              model: {r.aiAffected ? 'affected' : 'normal'}
              {changed && <span className="font-semibold text-sh-warn-fg">· you changed it</span>}
            </span>
          )}
        </span>
        <span role="group" aria-label={r.label} className="flex items-center gap-[6px]">
          <Pill variant={affected ? 'control' : 'primary'} size="lg" aria-pressed={!affected} onClick={() => setAspectsRegion(r.key, false)}>
            Normal
          </Pill>
          <Pill variant={affected ? 'crit' : 'control'} size="lg" aria-pressed={affected} onClick={() => setAspectsRegion(r.key, true)}>
            Affected
          </Pill>
        </span>
      </li>
    )
  }

  return (
    <ScreenFrame
      screenId="S-18-15"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="ASPECTS"
      sub={`ASPECTS ${humanScore} of 10 · ${inView.length} region${inView.length === 1 ? '' : 's'} affected${disagreements.length > 0 ? ` · ${disagreements.length} changed from the model` : ''}`}
      actions={
        <>
          {may(to.triage) && (
            <Pill variant="card" size="xl" icon={Scan} iconSize={17} onClick={() => navigate(to.triage)}>
              Triage card
            </Pill>
          )}
          {may(to.perfusion) && (
            <Pill variant="card" size="xl" icon={Activity} iconSize={17} onClick={() => navigate(to.perfusion)}>
              Perfusion
            </Pill>
          )}
        </>
      }
      railTitle="Scoring"
      rail={
        <div className="flex flex-col gap-[12px]">
          <Card titleSize="sm" title="Both scores are kept">
            <dl className="flex flex-col divide-y divide-sh-line">
              <KeyValue label="Adjusted by you">
                <span className="font-semibold tabular-nums">{humanScore}/10</span>
              </KeyValue>
              <KeyValue label="Examiner">{me.name}</KeyValue>
            </dl>
          </Card>
          <Why label="What ASPECTS decides">
            <p>A score of 6 or above keeps thrombectomy on the table. Below 6, the established core is large enough that reperfusion is less likely to help and more likely to bleed.</p>
            <p className="text-sh-text-3">One point is one region. At the margin, one region changes the decision.</p>
          </Why>
        </div>
      }
      actionBar={
        <>
          <span className="text-[13px] text-sh-text-3">{humanScore >= 6 ? 'Thrombectomy remains on the table at this score' : 'Below 6 — reperfusion is less likely to help'}</span>
          <Pill
            variant="primary"
            size="bar"
            icon={Check}
            className="ml-auto"
            disabled={recorded}
            onClick={() => {
              setRecorded(true)
              toast({
                tone: 'success',
                title: `ASPECTS ${humanScore} recorded`,
                detail: aiActive
                  ? `Model scored ${modelScore}. Both are kept, with ${disagreements.length} region${disagreements.length === 1 ? '' : 's'} changed by you.`
                  : `Scored manually by ${me.name}.`,
              })
            }}
          >
            {recorded ? 'Recorded' : 'Record both scores'}
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[20px]">
        {disagreements.length > 0 && (
          <Alert tone="warn" title={`You have changed ${disagreements.length} region${disagreements.length === 1 ? '' : 's'}`}>
            {disagreements.map((d) => d.label).join(', ')} — recorded as your adjustment alongside the model’s original. Neither replaces the other.
          </Alert>
        )}

        <div className="grid gap-[20px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          {/* The ten regions, schematically. */}
          <Card className="p-[12px]">
            <div className="aspect-square w-full rounded-[14px] bg-sh-inner p-[16px]">
              <svg
                viewBox="0 0 200 200"
                className="size-full"
                role="img"
                aria-label="ASPECTS region map, left hemisphere. A filled region is scored as affected; a dashed amber outline marks a disagreement with the model."
              >
                <ellipse cx="100" cy="100" rx="78" ry="92" fill="var(--card)" stroke="var(--line-strong)" strokeWidth="4" />
                <path d="M100 14 L100 186" stroke="var(--line-strong)" strokeWidth="2" />
                {ASPECTS_REGIONS.map((r, i) => {
                  const affected = humanAffected(r)
                  const differs = r.aiAffected !== affected
                  const x = 112 + (i % 2) * 34
                  const y = 44 + Math.floor(i / 2) * 28
                  return (
                    <g key={r.key}>
                      <rect
                        x={x}
                        y={y}
                        width={30}
                        height={24}
                        rx={4}
                        fill={affected ? 'var(--crit-solid)' : 'var(--control)'}
                        stroke={differs ? 'var(--warn)' : 'var(--line-strong)'}
                        strokeWidth={differs ? 2.5 : 1}
                        strokeDasharray={differs ? '4 3' : undefined}
                      />
                      <text x={x + 15} y={y + 15} textAnchor="middle" fontSize="8" fontWeight="700" fill={affected ? 'var(--on-crit-solid)' : 'var(--text)'}>
                        {r.label.split(' ')[0].slice(0, 4)}
                      </text>
                    </g>
                  )
                })}
                <text x="20" y="190" fontSize="8" fill="var(--text-2)">
                  right
                </text>
                <text x="140" y="190" fontSize="8" fill="var(--text-2)">
                  left — affected side
                </text>
              </svg>
            </div>
          </Card>

          {/* The regions that lost a point; the normal ones fold. */}
          <Card titleSize="sm" title="Regions" right={<span className="text-[13px] text-sh-text-3">one point each</span>}>
            <ul aria-label="Regions in view" className="flex flex-col divide-y divide-sh-line">
              {inView.map((r) => regionRow(r, true))}
            </ul>
            {normal.length > 0 && (
              <Disclosure label="normal regions" count={normal.length} className="mt-[4px]">
                <ul aria-label="Normal regions" className="flex flex-col divide-y divide-sh-line">
                  {normal.map((r) => regionRow(r, false))}
                </ul>
              </Disclosure>
            )}
            {/* The one place the model's score is named. */}
            <div className="mt-[4px] flex flex-wrap items-center justify-between gap-[8px] rounded-[12px] bg-sh-inner px-[12px] py-[12px]">
              <span className="font-semibold text-sh-text">Total</span>
              <span className="flex items-center gap-[12px]">
                {aiActive && (
                  <span className="flex items-center gap-[6px] tabular-nums text-sh-text-3">
                    <Diamond />
                    model {modelScore}/10
                  </span>
                )}
                <span className="text-[20px] font-bold tabular-nums text-sh-text">{humanScore}/10</span>
              </span>
            </div>
          </Card>
        </div>

        <Why label="How this score is produced, and how it is recorded">
          <p>A filled region on the map is scored as affected. A dashed amber outline marks where you and the model disagree.</p>
          <p>Your adjustment does not overwrite the model score. Both go into the record, and the difference is what tells model governance where the model is wrong.</p>
          {aiActive && (
            <>
              <p className="flex flex-wrap items-center gap-[8px] font-semibold text-sh-text-3">
                <Diamond />
                AI-405 · ASPECTS auto-scoring
                <ConfidenceMark band="HIGH" score={0.86} />
              </p>
              <p>
                Scored from the non-contrast CT. It is less reliable in the first hour, when early ischaemic change is subtle, and it does not distinguish an old infarct from a new
                one — which is the commonest reason a human overrules it. Manual region-by-region scoring is the fallback.
              </p>
            </>
          )}
          <p className="tabular-nums text-sh-text-3">
            Scored {formatTime(caseNow)} by {me.name} · {me.identifierKind} {me.identifier}
          </p>
        </Why>
      </div>
    </ScreenFrame>
  )
}

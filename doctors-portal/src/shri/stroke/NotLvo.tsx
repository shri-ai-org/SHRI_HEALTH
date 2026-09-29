/**
 * The stroke-case screens for a case they were not drawn for — ported from
 * `src/screens/m18/NotLvo.tsx`, plus the two frames every case screen needs.
 *
 * S-18-14's triage card, S-18-15's ASPECTS map and S-18-16's perfusion maps
 * were drawn for one case: a left M1 occlusion. A haemorrhage, a late infarct
 * or a stood-down mimic opening those screens used to inherit that case's
 * findings, which is the one thing a clinical screen must never do. So a
 * non-LVO case gets its own triage card — its real scan, its own findings,
 * its own verdict — and the screens that do not apply say plainly why, and
 * where to go instead.
 *
 * Added here, for the same reason: `NoCase` (an address naming no stroke case
 * said nothing in the old build — it threw), and `NotRecordedHere`, for the
 * screens whose checklists belong to the index case (thrombolysis, EVT,
 * transfer): another case sees its OWN rule-based eligibility, computed from
 * its own scan (`eligibility` in `@/data/strokeai`), and nothing to give.
 */

import { Brain, Check, CircleSlash, Scan, SearchX, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatDateTime, formatTime } from '@/data/format'
import { IMAGING_STUDIES } from '@/data/imaging'
import { patient } from '@/data/kit'
import type { StrokeCase } from '@/data/stroke'
import { eligibility, ncctFindings, overlaysFor, studyFor, triageVerdict } from '@/data/strokeai'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { caseStatusWord } from '../logic/strokeCase'
import { RecordDoors } from '../record/RecordDoors'
import { useAiActive } from '../state/ai'
import { EmptyState } from '../ui/EmptyState'
import { NcctViewer } from '../ui/NcctViewer'
import { Card, ConfidenceMark, Diamond, Icon, Pill, PillTag } from '../ui/primitives'

import { CaseClockStrip } from './CaseClockStrip'

const VERDICT_PILL = { critical: 'bg-sh-crit-solid text-sh-on-crit-solid', caution: 'bg-sh-warn text-sh-text', normal: 'bg-sh-norm-bg text-sh-norm-fg' } as const

function studyIdFor(c: StrokeCase): string | undefined {
  return IMAGING_STUDIES.find((s) => s.ncctKey === c.id)?.id
}

/** The two doors out of a case screen that does not apply: its triage card and the console. */
function CaseDoors({ c, triage = true }: { c: StrokeCase; triage?: boolean }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const imaging = `/stroke/case/${c.id}/imaging`
  const consolePath = `/stroke/ai-console?case=${c.id}`
  return (
    <>
      {triage && may(imaging) && (
        <Pill variant="card" size="xl" icon={Scan} iconSize={17} onClick={() => navigate(imaging)}>
          Imaging triage
        </Pill>
      )}
      {may(consolePath) && (
        <Pill variant="primary" size="xl" icon={Brain} iconSize={17} onClick={() => navigate(consolePath)}>
          Stroke-AI console
        </Pill>
      )}
    </>
  )
}

/** An address naming no stroke case. */
export function NoCase({ screenId, id }: { screenId: string; id?: string }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  return (
    <ScreenFrame screenId={screenId} sub="No stroke case at this address.">
      <Card className="max-w-[672px]">
        <EmptyState
          icon={SearchX}
          why={`There is no stroke case with the id “${id ?? ''}” here. Open one from the command wall or the Stroke-AI console.`}
          action={
            may('/stroke/ai-console') ? (
              <Pill variant="control" size="lg" icon={Brain} onClick={() => navigate('/stroke/ai-console')}>
                Stroke-AI console
              </Pill>
            ) : undefined
          }
        />
      </Card>
    </ScreenFrame>
  )
}

/** S-18-14 for a haemorrhage, a late infarct or a mimic. */
export function NonLvoTriage({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const aiActive = useAiActive()
  const p = patient(c.patientId)
  const study = studyFor(c.id)
  const studyId = studyIdFor(c)
  const verdict = study ? triageVerdict(study.truth, c) : undefined
  const findings = study ? ncctFindings(study.truth, c) : []
  const overlays = study && aiActive ? overlaysFor(study.key, c) : []
  const first = overlays[0]
  const viewer = studyId ? `/radiology/study/${studyId}/view` : undefined

  return (
    <ScreenFrame
      screenId="S-18-14"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="Imaging triage"
      sub={`${c.caseNo} · NCCT head · delivered ${formatTime(c.imaging.deliveredAt)} · ${caseStatusWord(c)}`}
      actions={
        <>
          {viewer && may(viewer) && (
            <Pill variant="card" size="xl" icon={Scan} iconSize={17} onClick={() => navigate(viewer)}>
              Open in the viewer
            </Pill>
          )}
          <CaseDoors c={c} triage={false} />
        </>
      }
    >
      <div className="flex flex-col gap-[20px]">
        {verdict && aiActive && (
          <Card
            titleSize="sm"
            title="AI triage verdict"
            right={<span className={cn('inline-flex min-h-[24px] items-center rounded-full px-[10px] text-[12px] font-bold tabular-nums', VERDICT_PILL[verdict.tone])}>{`${verdict.priority} · ${verdict.priorityWord}`}</span>}
            className={cn(verdict.tone === 'critical' && 'shadow-[inset_4px_0_0_var(--crit)]', verdict.tone === 'caution' && 'shadow-[inset_4px_0_0_var(--warn)]')}
          >
            <p className="text-[18px] font-bold tracking-[-0.01em] text-sh-text">{verdict.headline}</p>
            <p className="mt-[4px] text-[14px] text-sh-text-2">{verdict.detail}</p>
            <div className="mt-[10px] flex flex-wrap gap-[6px]">
              {verdict.chips.map((chip) => (
                <PillTag key={chip} tone={chip.includes('NEGATIVE') || chip.includes('NO ') ? 'norm' : 'crit'} size="xs" className="font-semibold">
                  {chip}
                </PillTag>
              ))}
            </div>
          </Card>
        )}

        {study && (
          <div className="grid min-w-0 grid-cols-1 gap-[20px] xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <Card className="min-w-0">
              <NcctViewer key={c.id} study={study} overlays={overlays} initialSlice={first ? Math.round((first.from + first.to) / 2) : undefined} />
            </Card>
            <Card
              titleSize="sm"
              title={
                <span className="flex items-center gap-[8px]">
                  <Diamond /> {aiActive ? 'AI findings' : 'Findings'}
                </span>
              }
              right={<span className="text-[12px] tabular-nums text-sh-text-2">acquired {formatDateTime(c.imaging.acquiredAt)}</span>}
            >
              {aiActive ? (
                <ul className="divide-y divide-(--line)">
                  {findings.map((f) => (
                    <li key={f.label} className="flex min-h-[44px] flex-wrap items-center justify-between gap-[8px] py-[10px]">
                      <span className="min-w-0">
                        <span className="block text-[14px] font-medium text-sh-text">{f.label}</span>
                        <span className="block text-[12px] text-sh-text-2">{f.gloss}</span>
                      </span>
                      <span className="flex items-center gap-[8px]">
                        <span className={cn('font-semibold tabular-nums', f.reassuring && 'text-sh-norm-fg', f.critical && 'text-sh-crit-fg')}>{f.value}</span>
                        <ConfidenceMark band={f.band} score={f.confidence} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-[12px] bg-sh-inner px-[12px] py-[12px] text-[14px] text-sh-text-2">
                  Automated reading is off. The study is unchanged and the radiologist worklist is the route — unprioritised, in arrival order. The clock keeps running.
                </p>
              )}
              <p className="mt-[10px] rounded-[12px] bg-sh-pend-bg px-[14px] py-[10px] text-[14px] font-medium text-sh-pend-fg">{c.imaging.recommendation}</p>
            </Card>
          </div>
        )}

        <RecordDoors patient={p} exclude={['stroke']} />
      </div>
    </ScreenFrame>
  )
}

/** S-18-15 and S-18-16 for a case they do not apply to. */
export function NotApplicable({ c, screenId, heading, what }: { c: StrokeCase; screenId: 'S-18-15' | 'S-18-16'; heading: string; what: string }) {
  const p = patient(c.patientId)
  const bleed = studyFor(c.id)?.truth.ich
  const reason = bleed
    ? `${c.caseNo} is a haemorrhage. ${what} is scored for an ischaemic stroke being considered for reperfusion, so it does not apply here.`
    : c.status === 'de-activated'
      ? `${c.caseNo} was stood down as a stroke mimic. There is no infarct to score.`
      : `${c.caseNo} was not a large-vessel occlusion under reperfusion assessment. ${c.imaging.notPerformed ?? ''}`

  return (
    <ScreenFrame screenId={screenId} patient={p} bannerExtra={<CaseClockStrip caseId={c.id} />} heading={heading} sub={`${c.caseNo} · not applicable to this case`} actions={<CaseDoors c={c} />}>
      <Card className="max-w-[672px]">
        <p className="text-[18px] font-semibold tracking-[-0.01em] text-sh-text">{heading} does not apply to this case</p>
        <p className="mt-[8px] text-[14px]/[1.6] text-sh-text-2">{reason.trim()}</p>
        {c.imaging.aspects !== null && screenId === 'S-18-15' && <p className="mt-[8px] text-[14px] tabular-nums text-sh-text-2">The NCCT read records ASPECTS {c.imaging.aspects} / 10 for completeness.</p>}
        <p className="mt-[12px] rounded-[12px] bg-sh-pend-bg px-[14px] py-[10px] text-[14px] font-medium text-sh-pend-fg">{c.imaging.recommendation}</p>
      </Card>
    </ScreenFrame>
  )
}

/**
 * S-18-17, S-18-18 and S-18-19 for a case other than the index case: the
 * checklist, dose and reservation on those screens are the index case's, so
 * another case sees what is recorded for IT — the rule-based eligibility from
 * its own scan, its next step and where it goes — and no act to perform.
 */
export function NotRecordedHere({
  c,
  screenId,
  heading,
  pathwayKey,
  children,
}: {
  c: StrokeCase
  screenId: 'S-18-17' | 'S-18-18' | 'S-18-19'
  heading: string
  /** Which rule set to list; none for the transfer screen. */
  pathwayKey?: 'thrombolysis' | 'thrombectomy'
  children?: ReactNode
}) {
  const p = patient(c.patientId)
  const truth = studyFor(c.id)?.truth
  const rules = truth && pathwayKey ? eligibility(truth, c)[pathwayKey] : undefined

  return (
    <ScreenFrame screenId={screenId} patient={p} bannerExtra={<CaseClockStrip caseId={c.id} />} heading={heading} sub={`${c.caseNo} · ${caseStatusWord(c)}`} actions={<CaseDoors c={c} />}>
      <Card className="max-w-[720px]">
        <p className="text-[18px] font-semibold tracking-[-0.01em] text-sh-text">
          {rules ? (rules.eligible ? `${c.caseNo} meets the rule-based criteria` : `${c.caseNo} is not eligible on the rule-based criteria`) : `Nothing is recorded on this screen for ${c.caseNo}`}
        </p>
        {rules && (
          <>
            <ul className="mt-[10px] flex flex-col divide-y divide-(--line)">
              {rules.criteria.map((r) => (
                <li key={r.text} className="flex min-h-[44px] items-center gap-[10px] py-[8px] text-[14px] text-sh-text">
                  <PillTag tone={r.met ? 'norm' : 'crit'} size="xs" icon={r.met ? Check : X} className="font-semibold">
                    {r.met ? 'Met' : 'Not met'}
                  </PillTag>
                  <span className="min-w-0">{r.text}</span>
                </li>
              ))}
            </ul>
            <p className="mt-[8px] text-[12px] text-sh-text-3">Rule-based, computed from this case’s own scan and record — never a model decision.</p>
          </>
        )}
        {children}
        {c.outcome && (
          <p className="mt-[12px] flex items-start gap-[8px] text-[14px] text-sh-text-2">
            <Icon icon={CircleSlash} size={15} className="mt-[3px] text-sh-text-3" />
            {c.outcome}
          </p>
        )}
        <p className="mt-[12px] rounded-[12px] bg-sh-pend-bg px-[14px] py-[10px] text-[14px] font-medium text-sh-pend-fg">{c.imaging.recommendation}</p>
        <p className="mt-[8px] text-[13px] text-sh-text-2">Receiving: {c.imaging.receiving}</p>
      </Card>
    </ScreenFrame>
  )
}

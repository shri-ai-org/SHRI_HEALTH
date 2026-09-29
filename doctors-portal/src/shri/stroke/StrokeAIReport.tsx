/**
 * The Stroke-AI clinical report — ported from `src/screens/m18/
 * StrokeAIReport.tsx`, the document the Stroke-AI Console (S-18-21) and the
 * imaging study (S-15-04) produce.
 *
 * It is a REPORT, not a dashboard: it reads top to bottom, every number
 * carries its confidence, and it ends in three named signatures and a
 * disclaimer that is not small print. Every finding comes from the imported
 * study's ground truth or the stroke kit; none of it is authored here.
 * Eligibility is rule-based on AI inputs — the model reports, the rules
 * decide, and a clinician signs; the card states which criterion each tick
 * belongs to.
 *
 * Kept, as the plan decided: the per-vessel occlusion probabilities with their
 * confidence — they describe the scan in front of the reader, not the future.
 */

import { Ban, Check, X } from 'lucide-react'
import type { ReactNode } from 'react'

import { formatDateLong, formatTime } from '@/data/format'
import { facility, patient } from '@/data/kit'
import type { NcctStudy } from '@/data/ncct.generated'
import { PERFUSION, type StrokeCase } from '@/data/stroke'
import { CTA_ANALYSIS, CTP_ANALYSIS, DECISION_SUPPORT_NOTICE, OCCLUSION_PROBABILITY, eligibility, ncctFindings, pathway, triageVerdict } from '@/data/strokeai'

import { cn } from '../lib/cn'
import { Icon, PillTag } from '../ui/primitives'

const VERDICT_BG = { critical: 'bg-sh-crit-bg', caution: 'bg-sh-warn-bg', normal: 'bg-sh-norm-bg' } as const
const VERDICT_PILL = { critical: 'bg-sh-crit-solid text-sh-on-crit-solid', caution: 'bg-sh-warn text-sh-text', normal: 'bg-sh-norm-bg text-sh-norm-fg' } as const

function Block({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0', className)}>
      <h3 className="mb-[8px] rounded-[10px] bg-sh-inner px-[12px] py-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, value, confidence }: { label: string; value: string; confidence?: number | null }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-[12px] gap-y-[2px] border-t border-sh-line py-[6px] first:border-t-0">
      <span className="min-w-0 text-[13px] text-sh-text-2">{label}</span>
      <span className="flex items-baseline gap-[8px]">
        <span className="text-[14px] font-semibold tabular-nums text-sh-text">{value}</span>
        {confidence !== undefined && confidence !== null && <span className="text-[12px] tabular-nums text-sh-text-2">{confidence.toFixed(2)}</span>}
      </span>
    </div>
  )
}

/** Core and penumbra side by side, each labelled directly — never colour alone. */
function CorePenumbra({ core, penumbra, caption }: { core: number; penumbra: number; caption: string }) {
  const total = core + penumbra || 1
  const parts = [
    { label: `Core ${core} mL`, value: core, color: 'var(--crit)' },
    { label: `Penumbra ${penumbra} mL`, value: penumbra, color: 'var(--warn)' },
  ]
  return (
    <figure className="m-0">
      <div className="flex h-[16px] w-full gap-[2px] overflow-hidden rounded-full" aria-hidden="true">
        {parts.map((p) => (
          <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, backgroundColor: p.color }} />
        ))}
      </div>
      <figcaption className="mt-[8px] flex flex-wrap gap-x-[16px] gap-y-[4px] text-[13px]">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-[6px]">
            <span aria-hidden="true" className="block size-[10px] rounded-[2px]" style={{ backgroundColor: p.color }} />
            <span className="text-sh-text-2">{p.label}</span>
          </span>
        ))}
        <span className="text-[12px] text-sh-text-2">{caption}</span>
      </figcaption>
    </figure>
  )
}

export function StrokeAIReport({ strokeCase, study }: { strokeCase: StrokeCase; study: NcctStudy }) {
  const p = patient(strokeCase.patientId)
  const truth = study.truth
  const verdict = triageVerdict(truth, strokeCase)
  const findings = ncctFindings(truth, strokeCase)
  const img = strokeCase.imaging
  const el = eligibility(truth, strokeCase)
  const steps = pathway(strokeCase)

  return (
    <article className="flex min-w-0 flex-col gap-[20px] pb-[8px]">
      {/* Masthead */}
      <header className="rounded-sh-card bg-sh-primary px-[16px] py-[12px] text-sh-on-primary">
        <p className="text-[16px] font-semibold tracking-[-0.01em]">Stroke-AI · acute stroke imaging and triage report</p>
        <p className="mt-[2px] text-[13px] opacity-80">{img.lvo ? 'AI-assisted NCCT · CT angiogram · CT perfusion' : 'AI-assisted NCCT'} — hub-and-spoke emergency pathway</p>
      </header>

      <div className="grid min-w-0 gap-[20px] lg:grid-cols-2">
        <Block title="Patient and event">
          <Row label="Case" value={strokeCase.caseNo} />
          <Row label="Patient" value={`${p.name} · ${p.age}/${p.sex}`} />
          <Row label="UHID" value={p.uhid} />
          <Row label="Last known well" value={`${formatTime(strokeCase.lkw)} · ${formatDateLong(strokeCase.lkw)}`} />
          <Row label="Presenting NIHSS" value={String(strokeCase.nihss)} />
          <Row label="Activated by" value={`${strokeCase.activatedBy} · ${formatTime(strokeCase.activatedAt)}`} />
          <Row label="Scanned at" value={facility(strokeCase.originFacility).name} />
          <Row label="Receiving hub" value={facility(strokeCase.destinationFacility).name} />
          <Row label="Payer" value={strokeCase.payer} />
        </Block>

        <Block title="Golden-hour timeline">
          <ol className="flex flex-col gap-[8px]">
            {steps.map((s, i) => (
              <li key={s.label} className="flex items-center gap-[12px]">
                <span className={cn('grid size-[28px] shrink-0 place-items-center rounded-full text-[12px] font-bold', i === steps.length - 1 ? 'bg-sh-norm-bg text-sh-norm-fg' : 'bg-sh-primary text-sh-on-primary')}>{i + 1}</span>
                <span className="min-w-0 flex-1 text-[14px] font-medium text-sh-text">{s.label}</span>
                <span className="text-[13px] tabular-nums text-sh-text-2">{formatTime(s.at)}</span>
                <span className="w-[64px] text-right text-[13px] font-semibold tabular-nums text-sh-text">+{s.offset} min</span>
              </li>
            ))}
          </ol>
          <p className={cn('mt-[12px] rounded-[12px] px-[12px] py-[8px] text-center text-[13px] font-semibold tabular-nums', el.inWindow ? 'bg-sh-norm-bg text-sh-norm-fg' : 'bg-sh-warn-bg text-sh-warn-fg')}>
            {el.minutesFromOnset} min from onset — {el.inWindow ? 'within the 4.5 h thrombolysis window' : 'outside the 4.5 h window'}
          </p>
        </Block>
      </div>

      {/* The verdict */}
      <section className={cn('rounded-sh-card px-[16px] py-[14px]', VERDICT_BG[verdict.tone])}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">AI triage verdict — decision support</p>
        <p className="mt-[4px] text-[19px] font-bold tracking-[-0.01em] text-sh-text">{verdict.headline}</p>
        <p className="mt-[4px] text-[14px] text-sh-text-2">{verdict.detail}</p>
        <div className="mt-[8px] flex flex-wrap items-center gap-[6px]">
          {verdict.chips.map((c) => (
            <PillTag key={c} tone={c.includes('NEGATIVE') || c.includes('NO ') ? 'norm' : 'crit'} size="xs" className="font-semibold">
              {c}
            </PillTag>
          ))}
          <span className={cn('ml-auto inline-flex min-h-[28px] items-center rounded-full px-[12px] text-[13px] font-bold tabular-nums', VERDICT_PILL[verdict.tone])}>
            {verdict.priority} · {verdict.priorityWord}
          </span>
        </div>
      </section>

      <Block title="Non-contrast CT (NCCT) — AI analysis">
        {findings.map((f) => (
          <div key={f.label} className="flex flex-wrap items-baseline justify-between gap-x-[12px] gap-y-[2px] border-t border-sh-line py-[8px] first:border-t-0">
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-sh-text">{f.label}</span>
              <span className="block text-[12px] text-sh-text-2">{f.gloss}</span>
            </span>
            <span className={cn('text-[14px] font-bold tabular-nums', f.critical ? 'text-sh-crit-fg' : f.reassuring ? 'text-sh-norm-fg' : 'text-sh-text')}>{f.value}</span>
            <span className="w-[48px] text-right text-[12px] tabular-nums text-sh-text-2">{f.confidence.toFixed(2)}</span>
            <span className="w-[96px] text-right text-[12px] text-sh-norm-fg">{f.concordant ? 'Concordant' : '—'}</span>
          </div>
        ))}
      </Block>

      {img.lesion && (
        <Block title={truth.ich ? 'Haemorrhage — characterisation' : 'Lesion — characterisation'}>
          <Row label="Lesion site" value={img.lesion.site} />
          {img.lesion.volumeMl !== undefined && <Row label="Volume (ABC/2)" value={`about ${img.lesion.volumeMl} mL`} confidence={0.86} />}
          {img.lesion.shiftMm !== undefined && <Row label="Midline shift" value={`${img.lesion.shiftMm} mm`} confidence={0.9} />}
          {img.lesion.extension && <Row label="Extension / mass effect" value={img.lesion.extension} />}
          {img.ichScore !== undefined && <Row label="ICH score" value={`${img.ichScore} / 6`} />}
          {img.anticoagulant && <Row label="Anticoagulant" value={img.anticoagulant} />}
          <Row label="Blood pressure at scan" value={img.bp} />
        </Block>
      )}

      {img.lvo ? (
        <>
          <div className="grid min-w-0 gap-[20px] lg:grid-cols-2">
            <Block title="CT angiography (CTA) — AI analysis">
              {CTA_ANALYSIS.map((r) => (
                <Row key={r.label} label={r.label} value={r.value} confidence={r.confidence} />
              ))}
            </Block>
            <Block title="CT perfusion (CTP) — AI analysis">
              <div className="mb-[12px]">
                <CorePenumbra
                  core={PERFUSION.coreMl}
                  penumbra={PERFUSION.penumbraMl}
                  caption={`Infarct core rCBF < 30% · penumbra at risk Tmax > 6 s — ${PERFUSION.coreMl + PERFUSION.penumbraMl} mL hypoperfused in total`}
                />
              </div>
              {CTP_ANALYSIS.map((r) => (
                <Row key={r.label} label={r.label} value={r.value} confidence={r.confidence} />
              ))}
            </Block>
          </div>
          <Block title="Occlusion site probability (CTA model)">
            <ul className="flex flex-col gap-[6px] pt-[4px]">
              {OCCLUSION_PROBABILITY.map((o) => (
                <li key={o.label} className="flex items-center gap-[12px]">
                  <span className="w-[160px] shrink-0 truncate text-[13px] text-sh-text">{o.label}</span>
                  <span className="h-[10px] min-w-0 flex-1 overflow-hidden rounded-full bg-sh-inner" aria-hidden="true">
                    <span style={{ width: `${o.value * 100}%` }} className={cn('block h-full rounded-full', o.value > 0.5 ? 'bg-sh-crit' : 'bg-sh-accent')} />
                  </span>
                  <span className="w-[48px] text-right text-[13px] font-semibold tabular-nums text-sh-text">{Math.round(o.value * 100)}%</span>
                </li>
              ))}
            </ul>
            <p className="mt-[8px] text-[12px] text-sh-text-2">Per-vessel independent probabilities — they do not sum to 100%.</p>
          </Block>
        </>
      ) : (
        <Block title="CT angiography and perfusion">
          <p className="rounded-[12px] bg-sh-inner px-[14px] py-[12px] text-[14px] text-sh-text-2">{img.notPerformed ?? 'Not performed for this case.'}</p>
        </Block>
      )}

      <Block title="Next step">
        <p className="rounded-[12px] border-l-[4px] border-sh-primary bg-sh-inner px-[14px] py-[12px] text-[14px] font-medium text-sh-text">{img.recommendation}</p>
        {strokeCase.outcome && <p className="mt-[8px] text-[13px] text-sh-text-2">{strokeCase.outcome}</p>}
      </Block>

      <Block title="Treatment eligibility — rule-based, computed on AI inputs">
        <div className="grid min-w-0 gap-[16px] lg:grid-cols-2">
          {[
            { name: 'IV thrombolysis (tenecteplase)', d: el.thrombolysis },
            { name: 'Mechanical thrombectomy (EVT)', d: el.thrombectomy },
          ].map(({ name, d }) => (
            <div key={name} className={cn('rounded-[12px] border-l-[4px] px-[14px] py-[12px]', d.eligible ? 'border-(--norm) bg-sh-norm-bg' : 'border-(--crit) bg-sh-crit-bg')}>
              <p className="flex flex-wrap items-center justify-between gap-[8px]">
                <span className="text-[14px] font-semibold text-sh-text">{name}</span>
                <PillTag tone={d.eligible ? 'norm' : 'crit'} size="xs" icon={d.eligible ? Check : Ban} className="font-semibold">
                  {d.eligible ? 'Eligible' : 'Not eligible'}
                </PillTag>
              </p>
              <ul className="mt-[8px] flex flex-col gap-[4px]">
                {d.criteria.map((c) => (
                  <li key={c.text} className="flex items-start gap-[8px] text-[13px] text-sh-text-2">
                    <Icon icon={c.met ? Check : X} size={13} className={cn('mt-[3px] shrink-0', c.met ? 'text-sh-norm-fg' : 'text-sh-crit-fg')} />
                    <span className="min-w-0">
                      <span className="sr-only">{c.met ? 'Met: ' : 'Not met: '}</span>
                      {c.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Block>

      {/* Signatures — a report without a named human is not a report. */}
      <div className="grid min-w-0 gap-[12px] sm:grid-cols-3">
        {[
          { role: 'Reporting radiologist', who: 'Dr. Anitha Venkatesan', detail: `Reviewed ${formatTime(img.deliveredAt)}` },
          { role: 'Treating clinician', who: strokeCase.activatedBy, detail: `Authorised ${formatTime(strokeCase.activatedAt)}` },
          { role: 'Receiving team', who: facility(strokeCase.destinationFacility).name, detail: img.receiving },
        ].map((s) => (
          <div key={s.role} className="rounded-[12px] bg-sh-inner px-[14px] py-[12px]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">{s.role}</p>
            <p className="mt-[4px] text-[14px] font-semibold text-sh-text">{s.who}</p>
            <p className="text-[12px] tabular-nums text-sh-text-2">{s.detail}</p>
          </div>
        ))}
      </div>

      <p className="rounded-[12px] border-l-[4px] border-(--crit) bg-sh-crit-bg px-[14px] py-[12px] text-[13px] text-sh-text-2">
        <strong className="font-bold text-sh-crit-fg">Clinical decision support — not an autonomous diagnosis.</strong> {DECISION_SUPPORT_NOTICE.replace('Clinical decision support — not an autonomous diagnosis. ', '')}
      </p>
    </article>
  )
}

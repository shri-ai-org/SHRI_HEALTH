// ported from src/screens/m06/record/overview.ts: what the record Overview's
// AI insights card says — the flags, each with its confidence, in the old
// build's words, each opening the same four-panel explanation
// (`useUI.openExplain`). The card now always stands, so the layout helpers
// (`hasViewer`, `hasTrend`) that decided whether it did are gone.

import type { ConfidenceBand } from '@/atlas/confidence'
import { RISK_STRIPS, resultsFor } from '@/data/clinical'
import { formatDate, formatDateTime, formatTime } from '@/data/format'
import { ncctFor, viewableStudyFor } from '@/data/imaging'
import type { Patient } from '@/data/kit'
import { conditionFor } from '@/data/record'
import { IMAGING_TRIAGE, maybeStrokeCase } from '@/data/stroke'
import { ncctFindings, triageVerdict } from '@/data/strokeai'
import type { ExplainTarget } from '@/store/ui'

export interface Reading {
  key: string
  label: string
  text: string
  band: ConfidenceBand
  score?: number
  /** The model could not score — said in words, never as a low confidence (§4.5). */
  abstain?: boolean
  explain: ExplainTarget
}

/** The same string the reading room prints for a study with no stroke case. */
const NCCT_MODEL = 'ncct-ich v3.1.0'

const bandScore = (band: ConfidenceBand) => (band === 'HIGH' ? 0.9 : band === 'MED' ? 0.72 : 0.45)

/**
 * The card's rows — the flags, each with its confidence and its Why. No lead
 * sentence and no suggested orders: the record shows recorded facts and
 * existing flags, never an AI narrative summary or an order it would place.
 */
export function readingsFor(p: Patient): Reading[] {
  const out: Reading[] = []

  // AI-201 first: whether this patient is getting worse is the reading that cannot wait.
  const risk = RISK_STRIPS[p.id]
  if (risk) {
    const limits = [
      'Derived from charted vitals only. It does not see the nursing narrative or the family’s concern.',
      'Abstains below the vitals-recency floor rather than scoring on stale observations.',
      'Validated on adult inpatients. Not validated for paediatric or obstetric admissions.',
    ]
    if (risk.band === 'ABSTAIN') {
      const why = risk.abstainReason ?? 'Not enough charted data to score.'
      out.push({
        key: 'risk',
        label: 'Risk',
        text: `Deterioration cannot be scored — ${why.charAt(0).toLowerCase()}${why.slice(1)}`,
        band: 'LOW',
        abstain: true,
        explain: {
          touchpointId: `risk-${p.id}`,
          capabilityId: 'AI-201',
          claim: `AI-201 did not score this patient: ${why}`,
          confidence: 0,
          band: 'LOW',
          computedAt: formatTime(risk.computedAt),
          inputs: [{ label: 'Charted observations', source: 'Flowsheet, most recent set' }],
          evidence: [why],
          model: risk.modelVersion,
          limits,
        },
      })
    } else {
      out.push({
        key: 'risk',
        label: 'Risk',
        text: `Deterioration ${risk.band} · ${risk.score}, ${risk.trend} — ${risk.drivers
          .slice(0, 3)
          .map((d) => `${d.direction === 'up' ? '↑' : '↓'} ${d.label}`)
          .join(' · ')}`,
        band: 'HIGH',
        score: 0.88,
        explain: {
          touchpointId: `risk-${p.id}`,
          capabilityId: 'AI-201',
          claim: `Deterioration risk is ${risk.band} — ${risk.score}, ${risk.trend}. This is a risk of clinical deterioration in the next 24 hours, not a diagnosis.`,
          confidence: 0.88,
          band: 'HIGH',
          computedAt: formatTime(risk.computedAt),
          inputs: risk.drivers.map((d) => ({ label: d.label, source: 'Flowsheet, most recent set' })),
          drivers: risk.drivers,
          model: risk.modelVersion,
          limits,
        },
      })
    }
  }

  const c = conditionFor(p.id)
  if (c) {
    out.push({
      key: 'condition',
      label: 'Condition',
      text: c.ai.drivers.join(' · '),
      band: c.ai.band,
      explain: {
        touchpointId: `condition-${p.id}`,
        capabilityId: 'AI-105',
        claim: c.ai.text,
        confidence: bandScore(c.ai.band),
        band: c.ai.band,
        computedAt: formatTime(c.updatedAt),
        inputs: [{ label: 'Results, observations and notes on the record', source: `${p.uhid} record` }],
        evidence: c.ai.drivers,
        model: c.ai.model,
        limits: [
          'Summarises what is charted — anything not written down is invisible to it.',
          'It describes the record; the clinical judgement is yours.',
        ],
      },
    })
  }

  const study = viewableStudyFor(p.id)
  const series = study ? ncctFor(study) : undefined
  if (study && series) {
    const sc = maybeStrokeCase(series.strokeCaseId)
    const verdict = triageVerdict(series.truth, sc)
    const findings = ncctFindings(series.truth, sc)
    const lead = findings[0]
    const model = sc?.imaging.lvo ? IMAGING_TRIAGE.model : NCCT_MODEL
    const deliveredAt = sc?.imaging.deliveredAt ?? new Date(study.acquiredAt.getTime() + 4 * 60000)
    out.push({
      key: 'scan',
      label: 'Scan',
      text: `${study.description} ${formatDate(study.acquiredAt)} — ${verdict.detail}`,
      band: lead?.band ?? 'MED',
      score: lead?.confidence,
      explain: {
        /* The same touchpoint the reading room signs, so one attestation is one attestation. */
        touchpointId: `imaging:${study.id}:report`,
        capabilityId: 'AI-404',
        claim: verdict.detail,
        confidence: lead?.confidence ?? bandScore('MED'),
        band: lead?.band ?? 'MED',
        computedAt: formatTime(deliveredAt),
        inputs: [
          { label: `Study ${study.id}, ${series.slices} slices`, source: `Acquired ${formatDateTime(study.acquiredAt)}` },
          { label: 'Ground-truth labels of the imported series', source: series.sourcePatientId },
        ],
        evidence: findings.map((f) => `${f.label}: ${f.value} — ${f.gloss}`),
        model,
        limits: IMAGING_TRIAGE.limits,
      },
    })
  }

  const results = resultsFor(p.id)
  const r = results.find((x) => !x.acknowledged && x.flag !== 'Normal') ?? results[0]
  if (r) {
    out.push({
      key: 'results',
      label: 'Results',
      text: `${r.test} ${r.value}${r.unit ? ` ${r.unit}` : ''} — ${r.aiReason}`,
      band: r.band,
      explain: {
        touchpointId: `result:${r.id}:delta`,
        capabilityId: 'AI-212',
        claim: r.aiReason,
        confidence: bandScore(r.band),
        band: r.band,
        computedAt: formatTime(r.reportedAt),
        inputs: [
          { label: `${r.test} ${r.value} ${r.unit}`, source: `Result ${r.id}` },
          ...(r.priorValue ? [{ label: `Prior ${r.priorValue}${r.delta ? ` (${r.delta})` : ''}`, source: 'Previous result' }] : []),
        ],
        evidence: [r.aiReason],
        model: 'result-delta v1.2.0',
        limits: [
          'Compares one analyte with its prior and its reference range.',
          'Reference ranges and the prior value are always shown without it.',
        ],
      },
    })
  }

  return out
}

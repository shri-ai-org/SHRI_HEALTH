/**
 * S-18-12 · NIHSS — `/stroke/case/:id/nihss` (`src/screens/m18/S1812.tsx`):
 * "A 15-item NIHSS scored over video, with the examiner recorded."
 *
 * The one rule that makes this safe: an untested item is blank, not zero.
 * Zero means normal on this scale, so defaulting an untestable item to zero
 * understates the deficit — the direction that costs a patient treatment. It
 * is said once, in the action bar, where the consequence is; the score cannot
 * be recorded until at least eight items are scored (the old gate, unchanged).
 *
 * Where the old screen fell short: AI-112's extracted scores were the index
 * case's on every case. Here they are offered only on the case whose session
 * they were spoken in; any other case is scored by hand. After recording, the
 * decision screen is opened only for a persona who may open it.
 */

import { ArrowUp, Check, CircleHelp, Video } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatTime } from '@/data/format'
import { patient } from '@/data/kit'
import { NIHSS_ITEMS, type StrokeCase } from '@/data/stroke'
import { useCurrentStaff } from '@/store/session'
import { useUI } from '@/store/ui'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useCaseClock } from '../logic/caseClock'
import { isIndexCase, useStrokeCaseParam } from '../logic/strokeCase'
import { useAiActive } from '../state/ai'
import { FieldChip } from '../ui/ai'
import { Why } from '../ui/Disclosure'
import { Select } from '../ui/forms'
import { KeyValue } from '../ui/KeyValue'
import { Card, Diamond, Pill, PillTag } from '../ui/primitives'

import { CaseClockStrip } from './CaseClockStrip'
import { NoCase } from './NotLvo'

export function NihssPage() {
  const { id, strokeCase: c } = useStrokeCaseParam()
  if (!c) return <NoCase screenId="S-18-12" id={id} />
  return <Nihss key={c.id} c={c} />
}

function Nihss({ c }: { c: StrokeCase }) {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const me = useCurrentStaff()
  const toast = useUI((s) => s.toast)
  const aiActive = useAiActive()
  const caseNow = useCaseClock()
  const p = patient(c.patientId)

  /** null means not tested. It is distinct from 0, which means normal. */
  const [scores, setScores] = useState<Record<string, number | null>>(() => Object.fromEntries(NIHSS_ITEMS.map((i) => [i.key, null])))

  const tested = NIHSS_ITEMS.filter((i) => scores[i.key] !== null)
  const total = tested.reduce((s, i) => s + (scores[i.key] ?? 0), 0)
  const untested = NIHSS_ITEMS.length - tested.length
  // The extraction came from the index case's session transcript; no other case was spoken aloud.
  const extractable = isIndexCase(c) ? NIHSS_ITEMS.filter((x) => x.aiExtracted) : []
  const pendingExtracted = extractable.filter((x) => scores[x.key] === null)
  const accept = (key: string, value: number) => setScores((s) => ({ ...s, [key]: value }))
  const session = `/stroke/case/${c.id}/telestroke`
  const decision = `/stroke/case/${c.id}/thrombolysis`

  return (
    <ScreenFrame
      screenId="S-18-12"
      patient={p}
      bannerExtra={<CaseClockStrip caseId={c.id} />}
      heading="NIHSS"
      sub={`NIHSS ${total} · ${tested.length} of ${NIHSS_ITEMS.length} scored · ${untested} not tested`}
      chips={
        <PillTag tone="neu" size="sm" icon={Video}>
          over video
        </PillTag>
      }
      actions={
        may(session) && (
          <Pill variant="card" size="xl" icon={Video} iconSize={17} onClick={() => navigate(session)}>
            Back to the session
          </Pill>
        )
      }
      railTitle="NIHSS"
      rail={
        <div className="flex flex-col gap-[12px]">
          {/* The stamp: a remote NIHSS carries the name of whoever did it. */}
          <Card titleSize="sm" title="Examiner">
            <p className="text-[15px] font-medium text-sh-text">{me.name}</p>
            <p className="text-[13px] tabular-nums text-sh-text-3">
              {me.identifierKind} {me.identifier}
            </p>
            <p className="mt-[6px] text-[13px] text-sh-text-2">Recorded against this score.</p>
          </Card>
          <Why label="How the score is banded, and why a remote examination counts">
            <dl className="flex flex-col divide-y divide-sh-line">
              <KeyValue label="0">No stroke symptoms</KeyValue>
              <KeyValue label="1–4">Minor</KeyValue>
              <KeyValue label="5–15">Moderate</KeyValue>
              <KeyValue label="16–20">Moderate to severe</KeyValue>
              <KeyValue label="21–42">Severe</KeyValue>
            </dl>
            <p>
              A remote NIHSS is valid, and the atlas treats it as such. What makes it defensible is the record: who examined, over what link, at what time, and which items they
              could not test.
            </p>
          </Why>
        </div>
      }
      actionBar={
        <>
          {/* The one statement of the rule, at the point where it has a consequence. */}
          <span className="text-[13px] text-sh-text-3">
            {untested > 0 ? `${untested} item${untested === 1 ? '' : 's'} not tested — excluded from the total, never counted as zero` : 'All fifteen items scored'}
          </span>
          <Pill
            variant="primary"
            size="bar"
            icon={Check}
            className="ml-auto"
            disabled={tested.length < 8}
            title={tested.length < 8 ? 'Score at least eight items before recording' : undefined}
            onClick={() => {
              toast({ tone: 'success', title: `NIHSS ${total} recorded`, detail: `${tested.length} of ${NIHSS_ITEMS.length} items, examined by ${me.name} at ${formatTime(caseNow)}.` })
              if (may(decision)) navigate(decision)
            }}
          >
            Record the score
          </Pill>
        </>
      }
    >
      <div className="flex flex-col gap-[20px]">
        {aiActive && pendingExtracted.length > 0 && (
          <Card className="border-l-[3px] border-sh-ai p-[16px]">
            <p className="flex items-center gap-[8px] text-[15px] font-semibold text-sh-text">
              <Diamond />
              {extractable.length} items were scored aloud during the examination
            </p>
            <p className="mt-[6px] text-[14px] text-sh-text-2">
              Extracted from the session transcript. Each one still needs your disposition, and the items you did not test are left blank rather than filled in.
            </p>
            <div>
              <Pill
                variant="accent"
                size="lg"
                icon={Check}
                className="mt-[12px]"
                onClick={() => {
                  for (const i of extractable) accept(i.key, i.score)
                  toast({ tone: 'info', title: 'Extracted items accepted', detail: 'The untested items remain blank. Score them or leave them as not tested.' })
                }}
              >
                Accept all {extractable.length} extracted items
              </Pill>
            </div>
          </Card>
        )}

        <Card titleSize="sm" title="The fifteen items" right={<span className="text-[13px] tabular-nums text-sh-text-3">total {total}</span>}>
          <ul aria-label="NIHSS items" className="flex flex-col divide-y divide-sh-line">
            {NIHSS_ITEMS.map((item) => {
              const value = scores[item.key]
              return (
                <li key={item.key} className={cn('rounded-[12px] px-[12px] py-[12px]', value === null && 'bg-sh-warn-bg/40')}>
                  <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[8px]">
                    <div className="min-w-0 flex-1 basis-[220px]">
                      <p className="text-[14px] font-medium text-sh-text">
                        <span className="mr-[8px] tabular-nums text-sh-text-3">{item.key}</span>
                        {item.label}
                      </p>
                      <p className="text-[13px] text-sh-text-3">
                        0 to {item.max}
                        {item.note && <span className="text-sh-text-2"> · {item.note}</span>}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-[8px]">
                      {aiActive && item.aiExtracted && isIndexCase(c) && value === null && (
                        <FieldChip
                          touchpointId={`nihss:${c.id}:${item.key}`}
                          capabilityId="AI-112"
                          suggestion={String(item.score)}
                          band="MED"
                          score={0.78}
                          gate="G2"
                          onAccept={() => accept(item.key, item.score)}
                          explain={{
                            touchpointId: `nihss:${c.id}:${item.key}`,
                            capabilityId: 'AI-112',
                            claim: `Item ${item.key} (${item.label}) was scored ${item.score} aloud during the examination.`,
                            confidence: 0.78,
                            band: 'MED',
                            computedAt: formatTime(caseNow),
                            inputs: [{ label: 'Session transcript', source: 'Telestroke session recording' }],
                            evidence: [item.note ?? 'Scored aloud by the examining neurologist.'],
                            model: 'extract v4.1.0',
                            limits: ['Extracts only what was spoken. A silently examined item is not captured.', 'It never fills in an item that was not tested.', 'Manual scoring is the fallback and the authority.'],
                          }}
                        />
                      )}
                      <Select
                        value={value === null ? 'nt' : String(value)}
                        onChange={(e) => setScores((s) => ({ ...s, [item.key]: e.target.value === 'nt' ? null : Number(e.target.value) }))}
                        aria-label={`Score for ${item.label}`}
                        className="h-[44px] w-auto"
                      >
                        <option value="nt">Not tested</option>
                        {Array.from({ length: item.max + 1 }, (_, n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </Select>
                      {value === null ? (
                        <PillTag tone="warn" size="sm" icon={CircleHelp}>
                          not tested
                        </PillTag>
                      ) : (
                        <PillTag tone={value === 0 ? 'norm' : 'crit'} size="sm" icon={value === 0 ? Check : ArrowUp}>
                          {value === 0 ? 'normal' : `${value} point${value === 1 ? '' : 's'}`}
                        </PillTag>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </Card>
      </div>
    </ScreenFrame>
  )
}

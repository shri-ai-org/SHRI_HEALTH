/**
 * SHRI_HEALTH: the assistant on the API — chart questions and answers (D70; listSuggestedQuestions,
 * createChartQuestion, getChartAnswer). It asks about the patient in view: on a visit's pages the
 * visit is named too (consultation, prescribing), on the record the chart. Every statement links to
 * the record it comes from; when the chart doesn't hold the answer it says "Not in the chart" and
 * nothing else. Answers are AI-generated and labelled so; they never change the chart. With the AI
 * off, unavailable or over budget the assistant stays open and says "AI is unavailable right now"
 * on that question; nothing else on the screen changes. A render failure inside the assistant is
 * caught here and said the same way, so the drawer never closes or takes the page down.
 */

import { ArrowUp, CircleHelp, CornerDownRight, RotateCcw, Sparkles } from 'lucide-react'
import { Component, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import type { ChartAnswer, ChartQuestionPageType } from '../../../../src/api/generated/model'
import { askChart, suggestedQuestions } from '../../../shri-health/aiChart'
import { aiSourceLabel, routeForAiSource } from '../../../shri-health/aiSources'
import { maybeEncounter } from '../../../shri-health/encounter'
import { Icon, PillTag, RoundButton } from '../ui/primitives'

export interface ChartContext {
  patientId?: string
  encounterId?: string
  pageType: ChartQuestionPageType
}

/** What the assistant asks about, from the address: a visit's pages, or a patient's record. */
export function useChartContext(): ChartContext {
  const { pathname } = useLocation()
  const visit = /^\/encounter\/([^/]+)(?:\/([^/]+))?/.exec(pathname)
  const encounterId = visit?.[1]
  const fromVisit = maybeEncounter(encounterId)?.patientId
  if (visit) return { encounterId, patientId: fromVisit, pageType: visit[2] === 'rx' ? 'prescribing' : 'consultation' }
  const record = /^\/patient\/([^/]+)/.exec(pathname)
  return { patientId: record?.[1], pageType: 'chart' }
}

interface Turn {
  id: number
  patientId: string
  q: string
  answer?: ChartAnswer
  error?: string
}

/** Said on a question the AI couldn't answer, whatever the reason (off, down, over budget, offline). */
export const AI_UNAVAILABLE = 'AI is unavailable right now.'

/** Keeps a render failure inside the assistant: it says so in place and the drawer stays open. */
class AssistantBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex flex-col items-start gap-[8px] px-[18px] py-[12px]">
        <p role="alert" className="text-[14px] text-sh-warn-fg">
          {AI_UNAVAILABLE}
        </p>
        <button
          type="button"
          onClick={() => this.setState({ failed: false })}
          className="inline-flex min-h-[36px] items-center gap-[6px] rounded-full px-[8px] text-[13px] font-medium text-sh-ai transition-colors duration-150 hover:bg-sh-hover"
        >
          <Icon icon={RotateCcw} size={13} />
          Try again
        </button>
      </div>
    )
  }
}

/** The conversation, the starters and the composer; the drawer and the page frame it. */
export function RealAssistantBody(props: { onSourceOpened?: () => void }) {
  return (
    <AssistantBoundary>
      <Conversation {...props} />
    </AssistantBoundary>
  )
}

function Conversation({ onSourceOpened }: { onSourceOpened?: () => void }) {
  const ctx = useChartContext()
  const navigate = useNavigate()
  const [turns, setTurns] = useState<Turn[]>([])
  const [starters, setStarters] = useState<string[]>([])
  const [text, setText] = useState('')
  const latest = useRef<HTMLLIElement>(null)

  useEffect(() => {
    let live = true
    suggestedQuestions(ctx.pageType)
      .then((qs) => live && setStarters(qs.slice(0, 4)))
      // Without suggestions the composer still works; a refusal shows on the question asked.
      .catch(() => live && setStarters([]))
    return () => {
      live = false
    }
  }, [ctx.pageType])

  // The conversation belongs to one patient: opening another chart starts a new one.
  useEffect(() => {
    setTurns([])
  }, [ctx.patientId])

  useEffect(() => {
    if (turns.length > 0) latest.current?.scrollIntoView({ block: 'start' })
  }, [turns.length])

  function ask(q: string) {
    const question = q.trim()
    if (question.length < 3 || !ctx.patientId) return
    const id = Date.now()
    const patientId = ctx.patientId
    setTurns((t) => [...t, { id, patientId, q: question }])
    setText('')
    askChart(question, ctx.pageType, patientId, ctx.encounterId)
      // An answer is kept only on its own turn, and only when it is about that turn's patient.
      .then((answer) => setTurns((t) => t.map((x) => (x.id === id && answer.patientId === x.patientId ? { ...x, answer } : x))))
      // Any refusal or failure (AI off, model down, budget used up, network) is said on this turn;
      // the drawer stays open and the next question can be asked.
      .catch(() => setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: AI_UNAVAILABLE } : x))))
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    ask(text)
  }
  const open = (patientId: string, src: Parameters<typeof routeForAiSource>[1]) => {
    onSourceOpened?.()
    navigate(routeForAiSource(patientId, src))
  }

  if (!ctx.patientId) {
    return <p className="px-[18px] py-[12px] text-[14px] text-sh-text-2">Open a patient&rsquo;s record or visit to ask about their chart.</p>
  }

  return (
    <>
      <div className="sh-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pb-[12px]">
        {turns.length === 0 && starters.length > 0 && (
          <section aria-labelledby="assistant-suggested" className="flex flex-col gap-[8px]">
            <h3 id="assistant-suggested" className="mb-[2px] text-[12px] text-sh-text-3">
              Suggested · answers link to the chart
            </h3>
            {starters.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                className="flex min-h-[44px] items-center gap-[10px] rounded-[16px] bg-sh-inner px-[14px] py-[10px] text-left text-[14px]/[1.4] text-sh-text transition-colors duration-150 hover:bg-sh-hover-strong"
              >
                <Icon icon={CornerDownRight} size={14} className="text-sh-muted" />
                <span className="min-w-0 flex-1">{s}</span>
              </button>
            ))}
          </section>
        )}
        <ol role="log" aria-live="polite" aria-label="Conversation" className="flex flex-col gap-[12px]">
          {turns.filter((t) => t.patientId === ctx.patientId).map((t, i, shown) => (
            <li key={t.id} ref={i === shown.length - 1 ? latest : undefined} className="flex scroll-mt-[8px] flex-col gap-[8px]">
              <div className="ml-auto max-w-[88%] rounded-[18px] rounded-br-[6px] bg-sh-primary px-[14px] py-[9px] text-[14px]/[1.4] text-sh-on-primary">{t.q}</div>
              {!t.answer && !t.error && (
                <p role="status" className="text-[13px] text-sh-text-3">
                  Looking in the chart…
                </p>
              )}
              {t.error && (
                <p role="alert" className="text-[13px] text-sh-warn-fg">
                  {t.error}
                </p>
              )}
              {t.answer && (
                <div className="flex flex-col gap-[8px] rounded-[18px] rounded-bl-[6px] bg-sh-inner px-[14px] py-[10px]">
                  <PillTag tone="neu" size="xs" icon={Sparkles} className="self-start font-medium">
                    AI-generated · {t.answer.generatedBy.modelName}
                  </PillTag>
                  {t.answer.statements.length === 0 ? (
                    <p className="flex items-start gap-[8px] text-[14px] text-sh-text">
                      <Icon icon={CircleHelp} size={14} className="mt-[3px] shrink-0 text-sh-muted" />
                      Not in the chart.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-[8px]">
                      {t.answer.statements.map((st) => (
                        <li key={st.sequence} className="flex flex-col gap-[4px]">
                          <p className="text-[14px]/[1.4] text-sh-text">{st.text}</p>
                          <span className="flex flex-wrap gap-x-[10px] gap-y-[2px]">
                            {st.sources.map((src, j) => (
                              <button
                                key={`${src.resourceId}-${j}`}
                                type="button"
                                onClick={() => open(t.answer!.patientId, src)}
                                className="text-[12px] font-medium text-sh-ai underline-offset-2 hover:underline"
                                aria-label={`Source: ${aiSourceLabel(src)}`}
                              >
                                {aiSourceLabel(src)}
                              </button>
                            ))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {/* A partial answer: what the chart says, and that it doesn't say it all. */}
                  {t.answer.insufficientEvidence && t.answer.statements.length > 0 && (
                    <p className="flex items-start gap-[8px] text-[13px] text-sh-text-2">
                      <Icon icon={CircleHelp} size={13} className="mt-[2px] shrink-0 text-sh-muted" />
                      The chart doesn&rsquo;t fully answer this.
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
        {turns.length > 0 && (
          <button
            type="button"
            onClick={() => setTurns([])}
            className="mt-[12px] inline-flex min-h-[36px] items-center gap-[6px] rounded-full px-[8px] text-[13px] font-medium text-sh-ai transition-colors duration-150 hover:bg-sh-hover"
          >
            <Icon icon={RotateCcw} size={13} />
            New question
          </button>
        )}
      </div>
      <form onSubmit={submit} className="px-[14px] pb-[14px] pt-[6px]">
        <div className="flex h-[46px] items-center gap-[6px] rounded-full bg-sh-inner pl-[16px] pr-[5px]">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={turns.length > 0 ? 'Ask a follow-up…' : 'Ask about this chart…'}
            aria-label="Ask the assistant"
            className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-sh-text outline-none placeholder:text-sh-muted"
          />
          <RoundButton icon={ArrowUp} label="Ask" variant="primary" size={36} iconSize={16} strokeWidth={2.2} type="submit" disabled={text.trim().length < 3} />
        </div>
      </form>
    </>
  )
}

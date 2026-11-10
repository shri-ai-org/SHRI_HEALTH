/**
 * S-28-02 · Clinician assistant — `/assistant/clinician`, and
 * S-28-09 · Stroke command assistant — `/assistant/stroke`
 * (`src/screens/m28/AssistantScreen.tsx`). ARC-21: "the archetype IS the AI."
 *
 * The conversation surfaces the bubble is the entry point to. One assistant
 * per portal rather than one bot with a role switch — "'What can I usefully
 * ask' differs completely by portal" (§M-28.1) — so the two screens share this
 * surface but not their prompts, scope or examples. Every answer is the old
 * build's `resolveAnswer`, drawn by the one `AnswerView`.
 */

import { BookOpen, Check, CornerDownRight, Globe, Send, ShieldCheck, User, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { FORCEABLE_OUTCOMES, promptsFor, resolveAnswer, type AssistantAnswer } from '@/data/assistant'
import { patient } from '@/data/kit'
import { useSession } from '@/store/session'
import { useUI } from '@/store/ui'

import { ScreenFrame } from '../app/ScreenFrame'
import { useLiveContext, useOpenSource } from '../logic/assistant'
import { useAiActive } from '../state/ai'
import { Why } from '../ui/Disclosure'
import { Card, Diamond, Icon, Pill, PillTag } from '../ui/primitives'

import { AnswerView } from './AnswerView'

interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
  answer?: AssistantAnswer
  reported?: boolean
}

function AssistantScreen({ screenId, title, covers, patientId }: { screenId: string; title: string; covers: string[]; patientId: string }) {
  const aiActive = useAiActive()
  const language = useSession((s) => s.language)
  const toast = useUI((s) => s.toast)
  const live = useLiveContext()
  const openSource = useOpenSource()
  const [thread, setThread] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const composer = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)

  const p = patient(patientId)
  const prompts = promptsFor(screenId)

  useEffect(() => {
    if (thread.length > 0) end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [thread.length])

  function ask(q: string) {
    const question = q.trim()
    if (question.length < 3) return
    const answer = resolveAnswer(question, { screenId, patientId, patientScoped: true, live })
    setThread((t) => [...t, { id: `u${t.length}`, role: 'user', text: question }, { id: `a${t.length}`, role: 'assistant', text: answer.body, answer }])
    setDraft('')
    composer.current?.focus()
  }

  return (
    <ScreenFrame
      screenId={screenId}
      patient={p}
      chips={
        <>
          <PillTag tone="pend" size="sm">
            <Diamond />
            AI-911
          </PillTag>
          <PillTag tone="neu" size="sm" icon={ShieldCheck}>
            scope: {p.name}
          </PillTag>
          <PillTag tone="neu" size="sm" icon={Globe}>
            {language}
          </PillTag>
        </>
      }
      rail={
        <div className="flex flex-col gap-[12px]">
          <Why label="What this covers, and what it will not do">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">This covers</p>
            <ul className="flex flex-col gap-[6px]">
              {covers.map((c) => (
                <li key={c} className="flex gap-[8px]">
                  <Icon icon={Check} size={13} className="mt-[3px] text-sh-norm-fg" />
                  {c}
                </li>
              ))}
            </ul>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-warn-fg">Will not do</p>
            <ul className="flex flex-col gap-[6px]">
              {[
                'Answer a clinical question. Those route to the capability that owns them, under its own gate.',
                'Show you a patient you have not opened.',
                'Extrapolate a policy this hospital has not written.',
              ].map((t) => (
                <li key={t} className="flex gap-[8px]">
                  <Icon icon={X} size={13} className="mt-[3px] text-sh-warn-fg" />
                  {t}
                </li>
              ))}
            </ul>
          </Why>
          {/* Dev-only demo: the five refusal outcomes, each reachable in one click. */}
          {import.meta.env.DEV && aiActive && (
            <Why label="Demo · every outcome, in one click">
              <p className="text-sh-text-3">A refusal taxonomy that only exists on paper is not a refusal taxonomy. Try each one.</p>
              <div className="flex flex-col gap-[6px]">
                {FORCEABLE_OUTCOMES.map((o) => (
                  <button
                    key={o.kind}
                    type="button"
                    onClick={() => ask(o.example)}
                    className="flex min-h-[44px] w-full items-start gap-[8px] rounded-[12px] bg-sh-inner px-[12px] py-[8px] text-left transition-colors duration-150 hover:bg-sh-hover-strong"
                  >
                    <Icon icon={CornerDownRight} size={12} className="mt-[4px] text-sh-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-sh-text">{o.label}</span>
                      <span className="block text-[12px] text-sh-text-3">&ldquo;{o.example}&rdquo;</span>
                    </span>
                  </button>
                ))}
              </div>
            </Why>
          )}
        </div>
      }
      railTitle="Scope"
      actionBar={
        <div className="flex w-full items-end gap-[8px]">
          <textarea
            ref={composer}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                ask(draft)
              }
            }}
            placeholder={aiActive ? 'Ask about process, policy or how this works…' : 'The assistant is off'}
            aria-label="Ask the assistant"
            disabled={!aiActive}
            className="max-h-[128px] min-h-[46px] flex-1 resize-none rounded-[23px] bg-sh-inner px-[16px] py-[12px] leading-snug text-sh-text outline-none placeholder:text-sh-muted focus-visible:inset-ring-2 focus-visible:inset-ring-(--ai) disabled:opacity-50"
          />
          <Pill variant="primary" size="xl" icon={Send} disabled={!aiActive || draft.trim().length < 3} onClick={() => ask(draft)}>
            Ask
          </Pill>
        </div>
      }
    >
      <div className="mx-auto w-full max-w-[768px]">
        {!aiActive ? (
          <Card className="items-center p-[32px] text-center">
            <p className="text-[18px] font-medium">The assistant is switched off</p>
            <p className="mx-auto mt-[8px] max-w-[448px] text-sh-text-2">
              Every screen in the product still works. The static help centre and the service desk on extension 4400 remain available — no task here requires the assistant to
              complete.
            </p>
            <Pill
              variant="control"
              size="lg"
              icon={BookOpen}
              className="mt-[16px]"
              onClick={() => toast({ tone: 'info', title: 'Help centre', detail: 'Static help lives on the hospital intranet and is not part of this build. The service desk is on extension 4400.' })}
            >
              Open the help centre
            </Pill>
          </Card>
        ) : (
          <>
            {/* EMPTY is never a blank box. */}
            {thread.length === 0 && (
              <div className="flex flex-col gap-[16px]">
                <Card>
                  <h2 className="flex items-center gap-[8px] text-[18px] font-semibold">
                    <Diamond className="text-[14px]" />
                    {title}
                  </h2>
                  <p className="mt-[8px] text-sh-text-2">
                    I answer from documentation, with the source cited. If nothing relevant is retrieved I say so rather than guessing — an uncited answer is not rendered at all.
                  </p>
                  <p className="mt-[10px] flex flex-wrap items-center gap-[8px] rounded-[12px] bg-sh-inner px-[12px] py-[8px] text-[13px]">
                    <Icon icon={User} size={13} className="text-sh-text-3" />
                    Scoped to <strong>{p.name}</strong>, because you have them open. I cannot reach a patient you have not.
                  </p>
                </Card>
                <div>
                  <p className="mb-[8px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">Try one of these</p>
                  <ul className="grid gap-[8px] sm:grid-cols-2">
                    {prompts.map((q) => (
                      <li key={q}>
                        <button
                          type="button"
                          onClick={() => ask(q)}
                          className="flex min-h-[48px] w-full items-center gap-[10px] rounded-[16px] bg-sh-card px-[14px] py-[12px] text-left transition-colors duration-150 hover:bg-sh-hover"
                        >
                          <Icon icon={CornerDownRight} size={14} className="text-sh-muted" />
                          <span className="min-w-0 flex-1">{q}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* The thread. role="log" so answers announce without stealing focus. */}
            <div role="log" aria-live="polite" aria-label="Conversation" className="flex flex-col gap-[16px]">
              {thread.map((turn) =>
                turn.role === 'user' ? (
                  <div key={turn.id} className="flex justify-end">
                    <p className="max-w-[80%] rounded-[18px] rounded-br-[6px] bg-sh-primary px-[16px] py-[10px] text-sh-on-primary">{turn.text}</p>
                  </div>
                ) : (
                  <AnswerView
                    key={turn.id}
                    answer={turn.answer!}
                    reported={turn.reported}
                    onOpenSource={openSource}
                    onReport={() => setThread((t) => t.map((x) => (x.id === turn.id ? { ...x, reported: true } : x)))}
                  />
                ),
              )}
              <div ref={end} />
            </div>
          </>
        )}
      </div>
    </ScreenFrame>
  )
}

export function ClinicianAssistantPage() {
  return (
    <AssistantScreen
      screenId="S-28-02"
      title="Clinician Assistant"
      patientId="SD-P-03"
      covers={[
        'How this product works — screens, actions and what a control does',
        'Accreditation obligations and what they require of you',
        'Capability and access rules, including break-glass',
        'Clinical pathways as this hospital has written them',
        'Where a clinical question belongs instead',
      ]}
    />
  )
}

export function StrokeAssistantPage() {
  return (
    <AssistantScreen
      screenId="S-28-09"
      title="Stroke Command Assistant"
      patientId="SD-P-05"
      covers={[
        'The stroke pathway, its clocks and its targets',
        'Eligibility criteria as written, and what an unknown answer means',
        'Which timestamp source wins when two clocks disagree',
        'What the single-act reservation holds, and what happens if one resource is lost',
        'The spoke-site protocol when there is no neurologist on site',
      ]}
    />
  )
}

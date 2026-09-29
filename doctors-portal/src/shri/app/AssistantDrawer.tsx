/**
 * §6.8 — the assistant panel. 380px, floating above the bubble, no scrim; on
 * a phone a full-width bottom sheet. It answers with the old build's
 * `resolveAnswer` for the screen and patient in view (`logic/assistant.ts`),
 * opening on up to four suggestions composed for them (`suggestionsFor`), and
 * draws each answer with the one `AnswerView` the assistant screens use — so
 * an uncited answer is not rendered here either, and a citation opens its
 * source. Ported from `src/shell/Assistant.tsx` (AssistantPanel).
 */

import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, CornerDownRight, RotateCcw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useLocation } from 'react-router-dom'

import { resolveAnswer, suggestionsFor, type AssistantAnswer } from '@/data/assistant'
import { callName } from '@/data/assistant-record'
import { patientByAnyId } from '@/data/kit'

import { AnswerView } from '../assistant/AnswerView'
import { cn } from '../lib/cn'
import { popover, sheetUp } from '../lib/motion'
import { assistantOfferedAt, useAskContext, useOpenSource } from '../logic/assistant'
import { useAiActive } from '../state/ai'
import { useShri } from '../state/store'
import { useIsPhone } from '../ui/frames'
import { useFocusTrap } from '../ui/hooks'
import { AssistantIcon } from '../ui/AssistantIcon'
import { Icon, RoundButton } from '../ui/primitives'

interface Turn {
  id: number
  q: string
  answer: AssistantAnswer
  reported?: boolean
}

export function AssistantDrawer() {
  const aiOn = useAiActive()
  const { pathname } = useLocation()
  // Moving onto a screen that is not offered the assistant (a wall, a modal, an assistant screen) puts the panel away.
  const open = useShri((s) => s.assistantOpen) && aiOn && assistantOfferedAt(pathname)
  const close = useShri((s) => s.closeAssistant)
  return (
    <AnimatePresence>
      {open && <Panel key="assistant" onClose={close} />}
    </AnimatePresence>
  )
}

function Panel({ onClose }: { onClose: () => void }) {
  const context = useAskContext()
  const phone = useIsPhone()
  // On a phone the sheet would cover the page a citation opens, so it gets out of the way.
  const openSource = useOpenSource(phone ? onClose : undefined)
  const p = patientByAnyId(context.patientId)
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const ref = useFocusTrap<HTMLDivElement>(true)
  const latest = useRef<HTMLLIElement>(null)
  const suggestions = useMemo(() => (turns.length === 0 ? suggestionsFor(context) : []), [context, turns.length])

  // The newest question comes to the top with its answer under it; focus stays in the composer.
  useEffect(() => {
    if (turns.length > 0) latest.current?.scrollIntoView({ block: 'start' })
  }, [turns.length])

  function ask(q: string) {
    const question = q.trim()
    if (question.length < 3) return
    setTurns((t) => [...t, { id: t.length + 1, q: question, answer: resolveAnswer(question, context) }])
    setText('')
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    ask(text)
  }

  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-label={p ? `Assistant · ${p.name}` : 'Assistant'}
      variants={phone ? sheetUp : popover}
      initial="hidden"
      animate="shown"
      exit="exit"
      className={cn(
        'fixed z-35 flex flex-col overflow-hidden bg-sh-card shadow-sh-pop',
        phone
          ? 'inset-x-0 bottom-0 h-[88dvh] rounded-t-sh-modal pb-(--sa-b) pl-(--sa-l) pr-(--sa-r)'
          : 'bottom-[calc(100px_+_var(--sa-b))] right-[calc(26px_+_var(--sa-r))] top-[calc(var(--shell-pt)_+_68px)] w-[380px] max-w-[calc(100%-32px)] rounded-sh-modal',
      )}
    >
      <header className="flex items-center gap-[12px] px-[18px] pb-[12px] pt-[16px]">
        <span className="inline-flex size-[38px] items-center justify-center rounded-full bg-(--bubble-bg)">
          <AssistantIcon className="size-[30px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium text-sh-text">Assistant</span>
          {/* The scope of every answer: the Z3 patient and the calling screen. */}
          <span className="block truncate text-[12px] text-sh-text-3">{p ? `${p.name} · ${context.spec?.name ?? 'this screen'}` : (context.spec?.name ?? 'This screen')}</span>
        </span>
        <RoundButton icon={X} label="Close assistant" size={38} onClick={onClose} />
      </header>

      <div className="sh-scrollbar min-h-0 flex-1 overflow-y-auto px-[18px] pb-[12px]">
        {/* "A blank chat box on a clinical screen gets no use" — suggestions for starting, and only for starting. */}
        {turns.length === 0 && suggestions.length > 0 && (
          <section aria-labelledby="assistant-suggested" className="flex flex-col gap-[8px]">
            <h3 id="assistant-suggested" className="mb-[2px] text-[12px] text-sh-text-3">
              {p ? `Suggested for ${callName(p)}` : 'Suggested'} · answers come with citations
            </h3>
            {suggestions.map((s) => (
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
        {/* role="log" so answers are announced without stealing focus. */}
        <ol role="log" aria-live="polite" aria-label="Conversation" className="flex flex-col gap-[12px]">
          {turns.map((t, i) => (
            <li key={t.id} ref={i === turns.length - 1 ? latest : undefined} className="flex scroll-mt-[8px] flex-col gap-[8px]">
              <div className="ml-auto max-w-[88%] rounded-[18px] rounded-br-[6px] bg-sh-primary px-[14px] py-[9px] text-[14px]/[1.4] text-sh-on-primary">{t.q}</div>
              <AnswerView
                compact
                answer={t.answer}
                reported={t.reported}
                onOpenSource={openSource}
                onReport={() => setTurns((all) => all.map((x) => (x.id === t.id ? { ...x, reported: true } : x)))}
              />
            </li>
          ))}
        </ol>
        {/* A follow-up goes in the composer; this is the way back to a fresh start. */}
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
            placeholder={turns.length > 0 ? 'Ask a follow-up…' : p ? `Ask about ${callName(p)}…` : 'Ask a question…'}
            aria-label="Ask the assistant"
            className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-sh-text outline-none placeholder:text-sh-muted"
          />
          {/* Send enables at three characters, S-28-02's composer rule. */}
          <RoundButton icon={ArrowUp} label="Ask" variant="primary" size={36} iconSize={16} strokeWidth={2.2} type="submit" disabled={text.trim().length < 3} />
        </div>
      </form>
    </motion.div>
  )
}

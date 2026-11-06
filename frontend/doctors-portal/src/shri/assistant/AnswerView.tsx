/**
 * One assistant answer, drawn the same wherever it is asked — the assistant
 * screens (S-28-02, S-28-09) and the drawer. Ported from `src/shell/
 * Assistant.tsx` (Turn, RoutedNotice, OutOfScopeNotice, AbstainFrame) and
 * `src/screens/m28/AssistantScreen.tsx` (AnswerBlock).
 *
 * THE rule: "an uncited answer is not rendered at all." An answer with no
 * citations draws the abstain frame instead of its prose, so there is no code
 * path that shows ungrounded text. O5 (beyond access) looks identical to O4:
 * the refusal is uniform and does not confirm that a record exists.
 */

import { Check, CircleHelp, CircleSlash, CornerDownRight, ExternalLink, Flag, LifeBuoy, Stethoscope } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

import type { AssistantAnswer, Citation } from '@/data/assistant'

import { cn } from '../lib/cn'
import { AttestStrip } from '../ui/ai'
import { ConfidenceMark, Icon, PillTag } from '../ui/primitives'

/** Just enough markdown for **bold**, `code` and line breaks in the canned answers — as elements, never as HTML. */
function Markdownish({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, li) => (
        <Fragment key={li}>
          {li > 0 && <br />}
          {line.split(/(\*\*.+?\*\*|`.+?`)/g).map((part, i): ReactNode => {
            if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
            if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
              return (
                <code key={i} className="rounded-[4px] bg-sh-control px-[4px] py-[1px] font-mono text-[0.9em]">
                  {part.slice(1, -1)}
                </code>
              )
            return part
          })}
        </Fragment>
      ))}
    </>
  )
}

export function AnswerView({
  answer,
  reported,
  onReport,
  onOpenSource,
  compact,
}: {
  answer: AssistantAnswer
  reported?: boolean
  onReport: () => void
  onOpenSource: (c: Citation) => void
  /** The drawer's narrower column: one-line sources. */
  compact?: boolean
}) {
  if (answer.citations.length === 0) {
    return (
      <article className="rounded-[18px] bg-sh-warn-bg px-[16px] py-[14px] inset-ring-1 inset-ring-(--warn)/40">
        <p className="flex items-center gap-[8px] font-semibold text-sh-warn-fg">
          <Icon icon={CircleHelp} size={16} />
          {answer.body}
        </p>
        {!compact && <p className="mt-[8px] text-sh-text-2">Nothing relevant was retrieved, so there is nothing to cite — and I will not extrapolate a policy this hospital has not written.</p>}
        {answer.supportRoute && (
          <p className="mt-[10px] flex items-start gap-[8px] text-[13px] text-sh-text-2">
            <Icon icon={LifeBuoy} size={14} className="mt-[2px]" />
            {answer.supportRoute}
          </p>
        )}
        {!compact && <p className="mt-[8px] text-[12px] text-sh-text-3">AI-ABSTAIN · grounded or silent.</p>}
      </article>
    )
  }

  return (
    <article className={cn('rounded-[18px] bg-sh-inner px-[16px] py-[14px] text-sh-text', compact && 'rounded-bl-[6px]')}>
      {answer.kind === 'routed' && (
        <div className="mb-[12px]">
          <p className="flex items-center gap-[8px] font-semibold text-sh-warn-fg">
            <Icon icon={Stethoscope} size={16} />
            That is a clinical question
          </p>
          <p className="mt-[6px] leading-relaxed text-sh-text-2">{answer.body}</p>
          {answer.routedTo && (
            <div className="mt-[10px] rounded-[14px] bg-sh-card px-[12px] py-[10px] inset-ring-1 inset-ring-(--ai)/30">
              <p className="text-[13px] font-semibold text-sh-ai">
                {answer.routedTo.capability} · {answer.routedTo.name}
              </p>
              <p className="mt-[4px] text-[13px] text-sh-text-2">
                Answered on {answer.routedTo.where}, at gate <strong>{answer.routedTo.gate}</strong>.
              </p>
            </div>
          )}
        </div>
      )}

      {answer.kind === 'out-of-scope' && (
        <div className="mb-[12px]">
          <p className="flex items-center gap-[8px] font-semibold">
            <Icon icon={CircleSlash} size={16} className="text-sh-text-3" />
            Outside what I cover
          </p>
          {answer.covers && (
            <>
              <p className="mt-[6px] leading-relaxed text-sh-text-2">{answer.covers.summary}</p>
              <ul className="mt-[10px] flex flex-col gap-[6px]">
                {answer.covers.examples.map((e) => (
                  <li key={e} className="flex items-start gap-[8px] text-[13px] text-sh-text-2">
                    <Icon icon={CornerDownRight} size={13} className="mt-[3px] text-sh-muted" />
                    <span>&ldquo;{e}&rdquo;</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {answer.kind === 'cited' && (
        <div className="flex flex-col gap-[10px] leading-relaxed">
          {answer.body.split('\n\n').map((para) => (
            <p key={para} className={cn(para.startsWith('•') && 'pl-[12px]')}>
              <Markdownish text={para} />
            </p>
          ))}
        </div>
      )}

      {/* Citations: real buttons with discernible text, never a bare [1]. */}
      <div className="mt-[12px] border-t border-sh-line pt-[10px]">
        <p className="mb-[4px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">Sources</p>
        <ul>
          {answer.citations.map((c) => (
            <li key={c.n}>
              <button
                type="button"
                onClick={() => onOpenSource(c)}
                title={`${c.label} — ${c.source}`}
                className="flex min-h-[36px] w-full items-center gap-[8px] rounded-[10px] px-[6px] py-[4px] text-left text-[13px] transition-colors duration-150 hover:bg-sh-hover"
              >
                <span className="flex size-[20px] shrink-0 items-center justify-center rounded-[6px] bg-sh-pend-bg text-[11px] font-bold text-sh-pend-fg">{c.n}</span>
                {compact ? (
                  <span className="min-w-0 flex-1 truncate">
                    {c.label}
                    <span className="text-sh-text-3"> · {c.source}</span>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1">
                    <span className="block">{c.label}</span>
                    <span className="block text-[12px] text-sh-text-3">{c.source}</span>
                  </span>
                )}
                <Icon icon={ExternalLink} size={12} className="text-sh-muted" />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* A reading is a claim, so it ends in a signature rather than a full stop. */}
      {answer.attest && <AttestStrip attest={answer.attest} subject={answer.about} />}

      <footer className="mt-[10px] flex flex-wrap items-center justify-between gap-[8px]">
        <ConfidenceMark band={answer.band} />
        {reported ? (
          <PillTag tone="neu" size="sm" icon={Check}>
            Reported — thank you
          </PillTag>
        ) : (
          <button
            type="button"
            onClick={onReport}
            className="inline-flex min-h-[36px] items-center gap-[6px] rounded-full px-[8px] text-[12px] text-sh-text-3 transition-colors duration-150 hover:bg-sh-hover hover:text-sh-text"
          >
            <Icon icon={Flag} size={12} />
            Report wrong answer
          </button>
        )}
      </footer>
    </article>
  )
}

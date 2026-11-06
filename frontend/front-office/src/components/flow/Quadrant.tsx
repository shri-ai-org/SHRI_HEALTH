import type { CSSProperties, ElementType, ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../utils/cn'
import { TONE_HEX } from '../../utils/toneHex'
import type { IconTone } from '../../utils/toneHex'

/** One quarter of the full-screen appointment page (Schedule and Reschedule):
 *  a numbered heading with the current choice, and the picker below it,
 *  always open so the choice can be changed at any time. The step to do next
 *  is highlighted. On a large screen each quarter scrolls on its own. */
export function Quadrant({
  id,
  step,
  title,
  done,
  current = false,
  summary,
  allowOverflow = false,
  scrollFrom = 'lg',
  className,
  icon: Icon,
  hue,
  numbered = false,
  children,
}: {
  /** An anchor for the step rail to scroll to. */
  id?: string
  step: number
  title: string
  done: boolean
  /** This is the next thing to do. */
  current?: boolean
  summary?: string
  /** The patient search opens a dropdown that must not be clipped. */
  allowOverflow?: boolean
  /** From which width the section has a fixed height and scrolls on its own. */
  scrollFrom?: 'lg' | 'xl'
  /** Grid placement. */
  className?: string
  /** With a hue: an icon tile in that colour leads the heading, which is tinted
   *  with it — the section's own colour. Without, the plain numbered heading. */
  icon?: ElementType
  hue?: IconTone
  /** A toned heading shows its step number too, so the order reads at a glance. */
  numbered?: boolean
  children: ReactNode
}) {
  const toned = Boolean(Icon && hue)

  return (
    <section
      id={id}
      aria-label={title}
      style={toned ? ({ '--tone': TONE_HEX[hue!] } as CSSProperties) : undefined}
      className={cn(
        toned && 'overflow-hidden rounded-2xl border-t-[3px] !border-t-[var(--tone)] shadow-card-md',
        'surface-raised flex min-w-0 scroll-mt-3 flex-col rounded-xl border bg-surface-1 transition-[border-color,box-shadow] duration-300',
        scrollFrom === 'lg' ? 'lg:min-h-0' : 'xl:min-h-0',
        current
          ? 'border-primary-600/60 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-primary-500)_14%,transparent)]'
          : 'border-border-soft',
        allowOverflow && 'relative z-10',
        className,
      )}
    >
      <header
        className={cn(
          'flex items-center gap-2.5 border-b border-border-soft px-3.5 py-2.5 sm:px-4',
          toned && 'bg-[linear-gradient(100deg,color-mix(in_oklab,var(--tone)_13%,var(--color-surface-1))_0%,var(--color-surface-1)_75%)] py-3',
        )}
      >
        {toned && numbered ? (
          <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_oklab,var(--tone)_40%,transparent)] bg-surface-1 text-xs font-bold text-[var(--tone)]">
            {step}
          </span>
        ) : null}
        {toned && Icon ? (
          <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--tone)] text-white shadow-card-sm">
            <Icon size={16} strokeWidth={2} />
          </span>
        ) : null}
        {toned ? null : (
          <span
            aria-hidden="true"
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-bold',
              done
                ? 'bg-success-bg text-success-fg'
                : current
                  ? 'bg-[image:var(--gradient-primary)] text-on-primary shadow-card-sm'
                  : 'bg-surface-2 text-ink-subtle',
            )}
          >
            {done ? <Check size={13} strokeWidth={3} /> : step}
          </span>
        )}
        <h3 className={cn('font-semibold text-ink', toned ? 'text-base' : 'text-sm')}>
          <span className="sr-only">Step {step}: </span>
          {title}
          {done ? <span className="sr-only"> (done)</span> : null}
        </h3>
        {toned && done ? (
          <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-bg text-success-fg">
            <Check size={12} strokeWidth={3} />
          </span>
        ) : null}
        {summary ? <span className="ml-auto min-w-0 truncate text-sm font-medium text-ink-muted">{summary}</span> : null}
      </header>
      <div
        className={cn(
          'px-3.5 py-3.5 sm:px-4',
          scrollFrom === 'lg' ? 'lg:min-h-0 lg:flex-1' : 'xl:min-h-0 xl:flex-1',
          allowOverflow ? 'overflow-visible' : scrollFrom === 'lg' ? 'lg:overflow-y-auto lg:overscroll-contain' : 'xl:overflow-y-auto xl:overscroll-contain',
        )}
      >
        {children}
      </div>
    </section>
  )
}

export function Waiting({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border-soft px-4 py-6 text-center text-sm text-ink-subtle">{children}</p>
}

export function SummaryItem({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className={cn('truncate', value ? 'font-medium text-ink' : 'text-ink-subtle')} title={value ?? undefined}>
        {value ?? '—'}
      </dd>
    </div>
  )
}

export interface RailStep {
  label: string
  done: boolean
  current: boolean
  /** The quadrant id to jump to. */
  target: string
}

/** The flow's progress: Patient · Department · Doctor · Time, each done,
 *  current or still to come. Tapping a step brings its section into view
 *  (on a phone the sections are stacked). */
export function StepRail({ steps }: { steps: RailStep[] }) {
  return (
    <ol className="scrollbar-hide -mx-1 -mt-1 mb-2 flex items-center gap-1 overflow-x-auto overflow-y-hidden px-1 py-1" aria-label="Booking steps">
      {steps.map((step, index) => (
        <li key={step.label} className="flex shrink-0 items-center gap-1">
          {index > 0 ? <span aria-hidden="true" className={cn('h-px w-4 sm:w-8', steps[index - 1].done ? 'bg-success-fg/50' : 'bg-border')} /> : null}
          <button
            type="button"
            aria-current={step.current ? 'step' : undefined}
            onClick={() => {
              const section = document.getElementById(step.target)
              section?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              section?.querySelector<HTMLElement>('input, button:not([disabled])')?.focus({ preventScroll: true })
            }}
            className={cn(
              'focus-ring flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-semibold transition-colors',
              step.current
                ? 'border-primary-600/50 bg-primary-50 text-primary-text'
                : step.done
                  ? 'border-success-fg/25 bg-success-bg text-success-fg'
                  : 'border-border-soft bg-surface-1 text-ink-subtle hover:text-ink',
            )}
          >
            <span aria-hidden="true" className="tabular-nums">
              {step.done ? <Check size={12} strokeWidth={3} /> : index + 1}
            </span>
            {step.label}
            {step.done ? <span className="sr-only"> (done)</span> : null}
          </button>
        </li>
      ))}
    </ol>
  )
}

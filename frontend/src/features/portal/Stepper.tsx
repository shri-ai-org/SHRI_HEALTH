import { Check } from 'lucide-react'
import { cn } from '../../design-system/lib/cn'

/**
 * "Page 2 of 11: Choices" plus the old wizard's page list. Done pages can be revisited; pages
 * ahead stay locked until the current one is valid, as in the old wizard.
 */
export function Stepper({ steps, current, reached, onGo }: { steps: string[]; current: number; reached: number; onGo: (i: number) => void }) {
  return (
    <nav aria-label="Registration pages" className="lg:sticky lg:top-6">
      <p className="mb-3 text-sm font-medium text-ink-muted">
        Page {current + 1} of {steps.length}: <span className="text-ink">{steps[current]}</span>
      </p>
      <ol className="hidden space-y-0.5 lg:block">
        {steps.map((label, i) => {
          const enabled = i <= reached
          return (
            <li key={label}>
              <button
                type="button"
                disabled={!enabled}
                onClick={() => onGo(i)}
                {...(i === current ? { 'aria-current': 'step' as const } : {})}
                className={cn(
                  'flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm',
                  i === current ? 'bg-primary-50 font-semibold text-primary-700' : enabled ? 'text-ink hover:bg-surface-2' : 'text-ink-subtle',
                )}
              >
                <span aria-hidden="true" className={cn('flex size-5 shrink-0 items-center justify-center rounded-full text-2xs', i < current ? 'bg-primary-600 text-on-primary' : 'border border-border')}>
                  {i < current ? <Check size={12} /> : i + 1}
                </span>
                {label}
              </button>
            </li>
          )
        })}
      </ol>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3 lg:hidden" aria-hidden="true">
        <div className="h-full bg-primary-600" style={{ width: `${((current + 1) / steps.length) * 100}%` }} />
      </div>
    </nav>
  )
}

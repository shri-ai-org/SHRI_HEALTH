import type { CSSProperties } from 'react'
import { departmentIcon, departmentTone } from '../../utils/departments'
import { TONE_HEX } from '../../utils/toneHex'
import { cn } from '../../utils/cn'

/** The departments as large buttons, each in its own colour: tinted and raised at rest, filled when chosen. */
export function DepartmentChips({ departments, selected, onChoose }: { departments: string[]; selected: string | null; onChoose: (department: string) => void }) {
  return (
    <div className="scrollbar-hide -my-1.5 flex min-w-0 flex-1 gap-2 overflow-x-auto px-0.5 py-1.5" role="group" aria-label="Departments">
      {departments.map((dep) => {
        const chosen = dep === selected
        const Icon = departmentIcon(dep)
        return (
          <button
            key={dep}
            type="button"
            aria-pressed={chosen}
            onClick={() => onChoose(dep)}
            style={{ '--tone': TONE_HEX[departmentTone(dep)] } as CSSProperties}
            className={cn(
              'focus-ring inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border px-4 text-sm font-semibold shadow-card-sm transition-all',
              chosen
                ? 'border-transparent bg-[var(--tone)] text-white shadow-card-md'
                : 'border-[color-mix(in_oklab,var(--tone)_40%,var(--color-surface-1))] bg-[color-mix(in_oklab,var(--tone)_10%,var(--color-surface-1))] text-ink hover:-translate-y-0.5 hover:bg-[color-mix(in_oklab,var(--tone)_18%,var(--color-surface-1))] hover:shadow-card-md',
            )}
          >
            <Icon size={16} strokeWidth={2} aria-hidden="true" className={chosen ? undefined : 'text-[var(--tone)]'} />
            {dep}
          </button>
        )
      })}
    </div>
  )
}

import { AlertTriangle } from 'lucide-react'

/** An age of 100–130 is possible but rare: shown in red, and the desk ticks
 *  that they checked it with the patient before the record is saved. */
export function AgeConfirm({ age, confirmed, onConfirm }: { age: string | number; confirmed: boolean; onConfirm: (next: boolean) => void }) {
  return (
    <div role="alert" className="rounded-lg border border-critical-fg/25 bg-critical-bg px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-critical-fg">
        <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        Age {age} — confirm with the patient
      </p>
      <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => onConfirm(event.target.checked)}
          className="h-5 w-5 shrink-0 accent-[var(--color-critical-fg)]"
        />
        Age confirmed — {age} years is correct
      </label>
    </div>
  )
}

/** A field's own message, in red, read out when it appears. */
export function FieldError({ id, message }: { id?: string; message: string | null }) {
  if (!message) return null
  return (
    <p id={id} role="alert" className="mt-1 text-xs font-medium text-critical-fg">
      {message}
    </p>
  )
}

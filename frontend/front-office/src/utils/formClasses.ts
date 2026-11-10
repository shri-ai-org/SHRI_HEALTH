// The standard form field (DESIGN_SYSTEM §10.2), shared by every form so a
// field looks and behaves the same everywhere: 44px tall, a hairline edge
// that strengthens on hover, and a focus ring instead of a border jump.
export const inputClass =
  'min-h-11 w-full min-w-0 rounded-lg border border-border-soft bg-surface-1 px-3.5 py-2 text-sm text-ink placeholder:text-ink-subtle transition-colors duration-150 hover:border-border focus:border-transparent focus:outline-none focus:ring-2 focus:ring-focus/40 disabled:cursor-not-allowed disabled:opacity-60'

/** Error state. `!` so it wins over the base edge and ring wherever it is
 *  composed with `inputClass` (cn() concatenates; it does not merge). */
export const errorClass = 'border-critical-fg/50! focus:ring-critical-fg/35!'

/** The same error edge for every control inside a marked field's wrapper —
 *  for forms whose fields are drawn by a shared wrapper rather than one by one. */
export const errorWithinClass = '[&_input]:border-critical-fg/50! [&_select]:border-critical-fg/50! [&_textarea]:border-critical-fg/50!'

/** Field label, required mark and hint (§10.2). */
export const labelClass = 'mb-1.5 flex items-center gap-1 text-sm font-medium text-ink-muted'
export const hintClass = 'mt-1 text-xs text-ink-subtle'

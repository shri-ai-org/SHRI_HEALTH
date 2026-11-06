import { useCallback, useRef, useState } from 'react'
import { Check, Languages } from 'lucide-react'
import { cn } from '../../utils/cn'
import { useDismiss } from '../../hooks/useDismiss'
import { LANGUAGES, setLanguage, useLanguage } from '../../hooks/useLanguage'

// GP-08 — language switcher. UI-only: it changes a local label, it does not
// translate the app. Real localization is out of scope for this build.
export function LanguageSwitcher() {
  const [open, setOpen] = useState(false)
  const languageCode = useLanguage()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close, rootRef, triggerRef)

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Change language"
        className="focus-ring tap-target gap-1.5 rounded-lg px-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <Languages size={19} aria-hidden="true" />
        <span className="text-xs font-semibold">{languageCode.toUpperCase()}</span>
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Language"
          className="absolute right-0 top-[calc(100%+6px)] z-40 w-44 overflow-hidden rounded-xl border border-border-soft bg-surface-1 py-1 shadow-card-lg"
        >
          {LANGUAGES.map((language) => {
            const selected = language.code === languageCode
            return (
              <button
                key={language.code}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setLanguage(language.code)
                  close()
                  triggerRef.current?.focus()
                }}
                className={cn(
                  'focus-ring flex min-h-11 w-full items-center justify-between gap-2 px-3.5 text-left text-sm transition-colors hover:bg-surface-2',
                  selected ? 'bg-primary-50 font-medium text-primary-text' : 'text-ink-muted',
                )}
              >
                {language.label}
                {selected ? <Check size={15} className="shrink-0" aria-hidden="true" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

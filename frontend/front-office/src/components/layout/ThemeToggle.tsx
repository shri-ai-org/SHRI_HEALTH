import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../../hooks/useTheme'

// Two-state light/dark switch (design system §6.3). The portal's existing
// theme provider still owns the state; this is only the control's look.
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === 'dark'

  return (
    <>
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        className="focus-ring tap-target rounded-lg text-ink-muted hover:bg-surface-2 sm:hidden"
      >
        {isDark ? <Sun size={19} aria-hidden="true" /> : <Moon size={19} aria-hidden="true" />}
      </button>
      <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label="Dark mode"
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={toggleTheme}
      className="focus-ring tap-target group relative hidden items-center sm:inline-flex rounded-full border border-border bg-surface-2 transition-colors hover:border-border-strong"
    >
      <span aria-hidden="true" className="relative m-1 flex h-8 w-14 items-center rounded-full">
        <span
          className={`absolute z-10 flex h-6 w-6 items-center justify-center rounded-full bg-surface-1 shadow-card transition-transform duration-200 ease-out ${
            isDark ? 'translate-x-7' : 'translate-x-1'
          }`}
        >
          {isDark ? (
            <Moon size={13} className="text-primary-500" strokeWidth={2.5} />
          ) : (
            <Sun size={13} className="text-warning-fg" strokeWidth={2.5} />
          )}
        </span>
        <Sun size={12} className={`absolute left-1.5 text-ink-subtle transition-opacity ${isDark ? 'opacity-40' : 'opacity-0'}`} />
        <Moon size={12} className={`absolute right-1.5 text-ink-subtle transition-opacity ${isDark ? 'opacity-0' : 'opacity-40'}`} />
      </span>
    </button>
    </>
  )
}

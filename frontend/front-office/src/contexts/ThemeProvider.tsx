import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ThemeContext } from './themeContextObject'
import type { Theme } from './themeContextObject'

// Keep this in sync with the inline bootstrap script in index.html, which
// reads the same key synchronously before first paint so the correct theme
// applies immediately — no flash of the other theme on load or refresh.
export const THEME_STORAGE_KEY = 'strokeai-front-office-theme'

function readStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    // Light is the default on first visit and whenever no explicit choice is
    // stored — only an explicit, previously-saved 'dark' overrides it. The
    // OS/browser color-scheme preference is deliberately never consulted.
    return stored === 'dark' ? 'dark' : 'light'
  } catch {
    // Storage can throw in private-browsing/locked-down contexts — the
    // portal still works, it just won't remember the choice across visits.
    return 'light'
  }
}

// The light theme is the DEFAULT; the dark variant of the same design
// system is available through the theme switcher and the choice is remembered. Nothing about
// routes, data, or component behavior depends on this.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme())

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#14181F' : '#E8EDF4')
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // Non-fatal — see readStoredTheme above.
    }
  }, [theme])

  const setTheme = useCallback((next: Theme) => setThemeState(next), [])
  const toggleTheme = useCallback(() => setThemeState((current) => (current === 'light' ? 'dark' : 'light')), [])

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

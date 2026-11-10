import { createContext } from 'react'

export type Theme = 'light' | 'dark'

export interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

// The context object lives in its own module so ThemeProvider.tsx exports
// only components and stays fast-refresh friendly (same split as useToast).
export const ThemeContext = createContext<ThemeContextValue | null>(null)

import { useContext } from 'react'
import { ThemeContext } from '../contexts/themeContextObject'
import type { ThemeContextValue } from '../contexts/themeContextObject'

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within a ThemeProvider')
  return context
}

import { useCallback, useSyncExternalStore } from 'react'

// The desktop sidebar's collapsed/expanded choice, remembered in this
// browser. Below 1024px the sidebar is always the icon rail (and below 768px
// the bottom bar), so the choice only applies on a desktop-sized window.
const STORAGE_KEY = 'care-entry.sidebar'
const DESKTOP = '(min-width: 64rem)'

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'collapsed'
  } catch {
    return false
  }
}

let collapsed = readStored()
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setCollapsed(next: boolean) {
  collapsed = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? 'collapsed' : 'expanded')
  } catch {
    // Not remembered across reloads — the choice still holds for now.
  }
  listeners.forEach((listener) => listener())
}

function subscribeDesktop(listener: () => void) {
  const media = window.matchMedia(DESKTOP)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

/** `expanded` is true only on a desktop-sized window with the sidebar open. */
export function useSidebar() {
  const isCollapsed = useSyncExternalStore(subscribe, () => collapsed)
  const isDesktop = useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP).matches)
  const toggle = useCallback(() => setCollapsed(!collapsed), [])
  return { expanded: isDesktop && !isCollapsed, collapsed: isCollapsed, isDesktop, toggle }
}

import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

import { selectAiActive, useAI } from '@/store/ai'

import { assistantOfferedAt } from '../logic/assistant'
import { useShri } from '../state/store'

/** §12 keyboard: `/` search, `?` assistant, `Esc` closes the top overlay. */
export function useShriKeys() {
  const { pathname } = useLocation()
  const here = useRef(pathname)
  useEffect(() => {
    here.current = pathname
  }, [pathname])
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      const typing = t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT' || Boolean(t?.isContentEditable)
      const s = useShri.getState()
      if (e.key === 'Escape') {
        s.closeTop()
        return
      }
      if (typing) return
      if (e.key === '/') {
        e.preventDefault()
        if (!s.noteModal && !s.admitPatient) s.openSearch()
      } else if (e.key === '?') {
        e.preventDefault()
        if (selectAiActive(useAI.getState()) && assistantOfferedAt(here.current)) s.toggleAssistant()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

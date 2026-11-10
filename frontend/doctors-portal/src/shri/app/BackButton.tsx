import { ChevronLeft } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'

import { useSession } from '@/store/session'

import { parentOf } from '../logic/parent'
import { RoundButton } from '../ui/primitives'

import { landingFor } from './landing'

/**
 * The one Back control (the old build's `BackLink`, in this build's round
 * button). With an earlier screen in this tab it goes back to it; opened cold
 * it goes to the screen this one sits under, and says which. On the landing
 * itself, opened cold, there is nowhere to go and it is not drawn.
 */
export function BackButton({ className }: { className?: string }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const persona = useSession((s) => s.persona)
  // React Router numbers its own history entries; above 0 there is a screen in this app to go back to.
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
  const parent = parentOf(pathname, landingFor(persona))
  if (idx === 0 && !parent) return null
  const label = idx > 0 ? 'Back' : `Back to ${parent!.label}`
  return (
    <RoundButton
      icon={ChevronLeft}
      label={label}
      size={44}
      variant="card"
      iconSize={20}
      className={className}
      onClick={() => (idx > 0 ? navigate(-1) : navigate(parent!.to))}
    />
  )
}

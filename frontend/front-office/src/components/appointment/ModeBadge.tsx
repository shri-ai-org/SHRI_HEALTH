import { Building2, Video } from 'lucide-react'
import { Badge } from '../ui/Badge'
import type { ConsultMode } from '../../types/appointment'

/** How a consultation happens — a teleconsult is marked wherever it is
 *  listed; in person is the usual case and shows only where it is a choice. */
export function ModeBadge({ mode, showInPerson = false }: { mode: ConsultMode; showInPerson?: boolean }) {
  if (mode === 'Teleconsult') {
    return (
      <Badge tone="purple">
        <Video className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
        Teleconsult
      </Badge>
    )
  }
  if (!showInPerson) return null
  return (
    <Badge tone="neutral">
      <Building2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
      In person
    </Badge>
  )
}

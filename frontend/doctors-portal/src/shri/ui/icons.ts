/**
 * The old build's data names its icons as strings (`icon: 'Stethoscope'` on a
 * day block, a patient row's place). They resolve through the one registry,
 * `src/components/icons.ts` — the file the icon audit checks — so a name the
 * data uses is always a real lucide icon. An unknown name falls back to a dot
 * rather than rendering nothing.
 */

import { Circle, type LucideIcon } from 'lucide-react'

import { ICONS, type IconName } from '@/components/icons'

export function iconFor(name: string | undefined): LucideIcon {
  return (name && (ICONS as Record<string, LucideIcon>)[name as IconName]) || Circle
}

import type { ElementType } from 'react'
import { Bone, Brain, HeartPulse, Siren, Stethoscope } from 'lucide-react'
import type { IconTone } from './toneHex'

/** Each department's glyph — the same wherever a department is shown. */
const DEPARTMENT_ICON: Record<string, ElementType> = {
  Neurology: Brain,
  Cardiology: HeartPulse,
  'General Medicine': Stethoscope,
  Orthopedics: Bone,
  Neurosurgery: Brain,
  'Emergency': Siren,
}

/** Each department's own hue — its tile, the same everywhere it appears. */
const DEPARTMENT_TONE: Record<string, IconTone> = {
  Neurology: 'violet',
  Cardiology: 'pink',
  'General Medicine': 'teal',
  Orthopedics: 'amber',
  Neurosurgery: 'indigo',
  'Emergency': 'red',
}

export function departmentIcon(department: string): ElementType {
  return DEPARTMENT_ICON[department] ?? Stethoscope
}

export function departmentTone(department: string): IconTone {
  return DEPARTMENT_TONE[department] ?? 'blue'
}

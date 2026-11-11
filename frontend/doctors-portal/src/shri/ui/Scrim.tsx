/**
 * The dimmed layer under a scrim-backed overlay. It fades in and out with the
 * overlay, and from the moment it starts to leave it lets the pointer through,
 * so a click made while it fades lands on the page.
 */

import { motion } from 'framer-motion'

import { cn } from '../lib/cn'
import { scrim } from '../lib/motion'

import { useLeavingStyle } from './frames'

export function Scrim({ onClick, className }: { onClick?: () => void; className?: string }) {
  const leaving = useLeavingStyle()
  return (
    <motion.div
      variants={scrim}
      initial="hidden"
      animate="shown"
      exit="exit"
      onClick={onClick}
      style={leaving}
      className={cn('fixed inset-0 bg-sh-scrim', className)}
      aria-hidden="true"
    />
  )
}

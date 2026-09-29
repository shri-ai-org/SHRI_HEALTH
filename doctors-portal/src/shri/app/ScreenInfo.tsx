import { AnimatePresence, motion } from 'framer-motion'
import { Info, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ARCHETYPE_SPECS } from '@/atlas/archetypes'
import { COMPLIANCE } from '@/atlas/compliance'
import type { ScreenSpec } from '@/atlas/registry'

import { cn } from '../lib/cn'
import { popover } from '../lib/motion'
import { useOutsideClick } from '../ui/hooks'
import { Icon, RoundButton } from '../ui/primitives'

/**
 * ⓘ — the atlas trace for a screen behind one button: its id and module, the
 * one-liner, archetype, tier and density, the assistant's disposition, and the
 * compliance obligations (the old build's `ScreenInfo`, `src/shell/Screen.tsx:375`).
 * Closes on an outside pointer or Esc.
 */
export function ScreenInfo({ spec, className }: { spec: ScreenSpec; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useOutsideClick(ref, open, close)
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, close])

  const archetype = ARCHETYPE_SPECS[spec.archetype]
  const rows: [string, string][] = [
    ['Archetype', `${spec.archetype} · ${archetype.name}`],
    ['Tier', `${spec.tier} · ${spec.density}`],
    ['Assistant', spec.z7b === 'GP-17' ? 'GP-17, no deviation' : `⊘ ${spec.z7b}`],
  ]

  return (
    <div ref={ref} className={cn('relative', className)}>
      <RoundButton
        icon={Info}
        label="About this screen"
        size={44}
        variant="card"
        iconSize={20}
        className="size-[46px]"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      />
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label={`About ${spec.name}`}
            variants={popover}
            initial="hidden"
            animate="shown"
            exit="exit"
            className="sh-frosted absolute right-0 top-[calc(100%+8px)] z-20 w-[320px] max-w-[calc(100vw-32px)] rounded-[20px] p-[16px] text-left shadow-sh-pop"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">
              {spec.id} · {spec.module}
            </p>
            <p className="mt-[6px] text-[13px]/[1.45] text-sh-text">{spec.oneLiner}</p>
            <dl className="mt-[10px] grid grid-cols-[auto_1fr] gap-x-[16px] gap-y-[6px] text-[12px]/[1.35]">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-sh-text-3">{label}</dt>
                  <dd className="font-medium text-sh-text">{value}</dd>
                </div>
              ))}
            </dl>
            {spec.compliance && spec.compliance.length > 0 && (
              <>
                <p className="mt-[12px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">Compliance obligations</p>
                <ul className="mt-[6px] flex flex-wrap gap-[6px]">
                  {spec.compliance.map((id) => {
                    const cmp = COMPLIANCE[id]
                    return (
                      <li
                        key={id}
                        title={cmp ? `${cmp.obligation} — ${cmp.consequence}` : id}
                        className={cn(
                          'inline-flex h-[24px] items-center gap-[5px] rounded-full px-[9px] text-[11px] font-medium',
                          cmp?.critical ? 'bg-sh-warn-bg text-sh-warn-fg' : 'bg-sh-neu-bg text-sh-neu-fg',
                        )}
                      >
                        <Icon icon={cmp?.critical ? TriangleAlert : ShieldCheck} size={12} />
                        {id}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

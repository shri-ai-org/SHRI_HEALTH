/**
 * §4.7 — "Why this was suggested": the old build's four fixed panels, identical
 * on every screen (`src/components/ai.tsx` `ExplainPanels`), over the one
 * explain target in the old `useUI` store — so any screen's Why? opens the same
 * drawer. Panel 2 is the one that earns clinical trust: every input opens its
 * source record where this build has one. A 480px right drawer; a bottom sheet
 * on a phone. It keeps its own scrim and Esc, so it can sit over the Quick-Panel.
 */

import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDown, ArrowUp, CornerDownRight, ExternalLink, Flag, Minus, Quote, X } from 'lucide-react'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { capability } from '@/atlas/capabilities'
import type { ConfidenceBand } from '@/atlas/confidence'
import { GATE_SPECS } from '@/atlas/gates'
import { routeForSource } from '@/atlas/registry'
import { useCurrentStaff } from '@/store/session'
import { useUI, type ExplainTarget } from '@/store/ui'

import { canonical } from '../app/paths'
import { cn } from '../lib/cn'
import { useDrawerFrame } from '../ui/frames'
import { useFocusTrap } from '../ui/hooks'
import { ConfidenceMark, Icon, Pill, RoundButton } from '../ui/primitives'
import { Scrim } from '../ui/Scrim'

export function ExplainDrawer() {
  const target = useUI((s) => s.explain)
  const close = useUI((s) => s.closeExplain)
  return <AnimatePresence>{target && <Drawer key={target.touchpointId} target={target} onClose={close} />}</AnimatePresence>
}

function Drawer({ target, onClose }: { target: ExplainTarget; onClose: () => void }) {
  const frame = useDrawerFrame(480)
  const ref = useFocusTrap<HTMLElement>(true)
  const navigate = useNavigate()
  const toast = useUI((s) => s.toast)
  const staff = useCurrentStaff()
  const spec = capability(target.capabilityId)

  // While it is open this drawer owns Esc.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  /** Panel 2's promise: every input opens its source record where this build has one. */
  function openSource(label: string, source: string) {
    const route = routeForSource(source)
    if (route) {
      onClose()
      navigate(canonical(route))
    } else {
      toast({ tone: 'info', title: label, detail: `${source} — the source record is not part of this build.` })
    }
  }

  return (
    <>
      <Scrim onClick={onClose} className="z-55" />
      <motion.aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Why this was suggested"
        variants={frame.variants}
        initial="hidden"
        animate="shown"
        exit="exit"
        className={cn('z-56 flex flex-col bg-sh-card text-sh-text', frame.className)}
        style={frame.style}
      >
        <header className="flex items-center gap-[12px] px-[20px] pb-[12px] pt-[18px]">
          <div className="min-w-0 flex-1">
            <h2 className="text-[19px]/[1.2] font-medium tracking-[-0.012em]">Why this was suggested</h2>
            <p className="mt-[2px] text-[12px] text-sh-text-3">Four fixed panels, identical on every screen</p>
          </div>
          <RoundButton icon={X} label="Close" size={38} onClick={onClose} />
        </header>

        <div className="sh-scrollbar flex min-h-0 flex-1 flex-col gap-[10px] overflow-y-auto px-[20px] pb-[18px]">
          <Panel n={1} title="What this is">
            <p className="text-[14px]/[1.5]">{target.claim}</p>
            <p className="mt-[8px] flex flex-wrap items-center gap-x-[12px] gap-y-[4px]">
              <ConfidenceMark band={target.band as ConfidenceBand} />
              <span className="text-[12px] tabular-nums text-sh-text-3">{Math.round(target.confidence * 100)}% · computed {target.computedAt}</span>
            </p>
          </Panel>

          <Panel n={2} title="What it used">
            {target.inputs.length === 0 ? (
              <p className="text-[13px] text-sh-text-3">No inputs recorded.</p>
            ) : (
              <ul className="-mx-[6px] flex flex-col">
                {target.inputs.map((i) => (
                  <li key={`${i.label}-${i.source}`}>
                    <button
                      type="button"
                      onClick={() => openSource(i.label, i.source)}
                      className="flex min-h-[44px] w-full items-start gap-[8px] rounded-[12px] px-[6px] py-[6px] text-left hover:bg-sh-hover"
                    >
                      <Icon icon={CornerDownRight} size={14} className="mt-[3px] shrink-0 text-sh-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px]">{i.label}</span>
                        <span className="block text-[12px] text-sh-text-3">{i.source}</span>
                      </span>
                      <Icon icon={ExternalLink} size={13} className="mt-[3px] shrink-0 text-sh-muted" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel n={3} title="Why">
            {target.drivers && target.drivers.length > 0 ? (
              <ul className="flex flex-col gap-[8px]">
                {target.drivers.map((d) => (
                  <li key={d.label}>
                    <div className="flex items-center justify-between gap-[12px] text-[13px]">
                      <span className="flex min-w-0 items-center gap-[6px]">
                        <Icon icon={d.direction === 'up' ? ArrowUp : ArrowDown} size={13} className={d.direction === 'up' ? 'text-sh-crit-fg' : 'text-sh-pend-fg'} />
                        <span className="truncate">{d.label}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-sh-text-3">{Math.round(d.weight * 100)}%</span>
                    </div>
                    <div className="mt-[4px] h-[6px] overflow-hidden rounded-full bg-sh-control">
                      <div className="h-full rounded-full bg-sh-ai" style={{ width: `${d.weight * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : target.evidence && target.evidence.length > 0 ? (
              <ul className="flex flex-col gap-[6px] text-[13px]">
                {target.evidence.map((e) => (
                  <li key={e} className="flex gap-[8px]">
                    <Icon icon={Quote} size={13} className="mt-[3px] shrink-0 text-sh-muted" />
                    <span>{e}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-sh-text-3">
                No driver breakdown is available for this capability. Never raw feature names — if drivers cannot be stated in clinical language, they are
                not shown.
              </p>
            )}
          </Panel>

          <Panel n={4} title="Limits & provenance">
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[14px] gap-y-[6px] text-[12px]">
              <dt className="text-sh-text-3">Capability</dt>
              <dd>
                {spec.id} · {spec.name}
              </dd>
              <dt className="text-sh-text-3">Model</dt>
              <dd>{target.model}</dd>
              <dt className="text-sh-text-3">Maximum gate</dt>
              <dd>
                {spec.gate} {GATE_SPECS[spec.gate].name}
              </dd>
              <dt className="text-sh-text-3">If unavailable</dt>
              <dd>{spec.fallback}</dd>
            </dl>
            <ul className="mt-[10px] flex flex-col gap-[6px] text-[13px] text-sh-text-2">
              {target.limits.map((l) => (
                <li key={l} className="flex gap-[8px]">
                  <Icon icon={Minus} size={13} className="mt-[3px] shrink-0 text-sh-muted" />
                  <span>{l}</span>
                </li>
              ))}
            </ul>
            <p className="mt-[10px] rounded-[12px] bg-sh-warn-bg px-[12px] py-[8px] text-[13px] font-medium text-sh-warn-fg">
              This is decision support. It is not a diagnosis.
            </p>
            <Pill
              variant="ghost"
              size="lg"
              icon={Flag}
              className="mt-[8px] -ml-[8px]"
              onClick={() => {
                toast({
                  tone: 'success',
                  title: 'Reported to model governance',
                  detail: `${spec.id} · ${target.model} · by ${staff.name}. The output stays on screen; nothing is changed by reporting it.`,
                })
                onClose()
              }}
            >
              Report a problem with this output
            </Pill>
          </Panel>
        </div>
      </motion.aside>
    </>
  )
}

function Panel({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[16px] bg-sh-inner px-[14px] py-[12px]">
      <h3 className="mb-[8px] flex items-center gap-[8px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-3">
        <span className="inline-flex size-[20px] items-center justify-center rounded-full bg-sh-card text-[11px] text-sh-ai">{n}</span>
        {title}
      </h3>
      {children}
    </section>
  )
}

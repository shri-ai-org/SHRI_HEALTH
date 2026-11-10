import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Camera, CheckCircle2, LoaderCircle, QrCode, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { cn } from '../../utils/cn'
import { setAbhaScanWaiter } from '../../utils/abhaScanGate'

const SCANNED_MS = 2000
const FETCHING_MS = 3000

type Phase = 'scan' | 'scanned' | 'fetching'

/** "Scan ABHA" — a card that waits for the ABHA card's QR code, then registers or opens the patient. */
export function AbhaScanButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Camera className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        Scan ABHA
      </Button>
      {open ? <ScanCard onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function ScanCard({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('scan')
  // The page behind redraws on its clock; the card's timers must not restart with it.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })

  useEffect(() => {
    let timers: number[] = []
    setAbhaScanWaiter((run) => {
      setPhase('scanned')
      timers = [
        window.setTimeout(() => setPhase('fetching'), SCANNED_MS),
        window.setTimeout(() => {
          close.current()
          run()
        }, SCANNED_MS + FETCHING_MS),
      ]
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      setAbhaScanWaiter(null)
      timers.forEach((t) => window.clearTimeout(t))
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const done = phase === 'scanned'
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-[4px]" onClick={phase === 'scan' ? onClose : undefined}>
      <div
        role="dialog"
        aria-modal="true"
        aria-live="polite"
        onClick={(event) => event.stopPropagation()}
        className="relative flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-border-soft bg-surface-1 px-6 pb-6 pt-8 text-center shadow-modal"
      >
        {phase === 'scan' ? (
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring absolute right-2 top-2 rounded-lg p-2 text-ink-subtle hover:bg-surface-2 hover:text-ink">
            <X size={18} aria-hidden="true" />
          </button>
        ) : null}
        <span
          className={cn(
            'flex h-16 w-16 items-center justify-center rounded-2xl',
            done ? 'bg-success-bg text-success-fg' : 'bg-primary-50 text-primary-text',
          )}
          aria-hidden="true"
        >
          {phase === 'scan' ? <QrCode className="h-8 w-8" strokeWidth={1.75} /> : done ? <CheckCircle2 className="h-8 w-8" strokeWidth={2} /> : <LoaderCircle className="h-8 w-8 motion-safe:animate-spin" strokeWidth={2} />}
        </span>
        <p className="text-base font-semibold text-ink">
          {phase === 'scan' ? 'Scan the QR code on the ABHA card' : done ? 'Scanned successfully' : 'Fetching details'}
        </p>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
          {phase === 'scan' ? (
            <div className="h-full w-1/3 rounded-full bg-[image:var(--gradient-primary)] motion-safe:animate-[abhaScanSlide_1.4s_ease-in-out_infinite]" />
          ) : (
            <div
              key={phase}
              className={cn('h-full origin-left rounded-full', done ? 'bg-success-fg' : 'bg-[image:var(--gradient-primary)]')}
              style={{ animation: `ackProgress ${done ? SCANNED_MS : FETCHING_MS}ms linear forwards` }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

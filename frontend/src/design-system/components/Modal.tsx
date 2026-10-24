import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { useFocusTrap } from '../lib/useFocusTrap'
import { Button, type ButtonVariant } from './Button'

export interface ModalProps {
  open: boolean
  title: string
  /** Called on Esc, the close button or the backdrop. Omit to make the dialog require an answer. */
  onClose?: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /** `alertdialog` for urgent questions such as the idle warning (WCAG 4.1.2). */
  role?: 'dialog' | 'alertdialog'
  initialFocus?: RefObject<HTMLElement | null>
}

const SIZE: Record<NonNullable<ModalProps['size']>, string> = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' }

/** Portalled to body, traps focus, restores it on close, Esc closes, body does not scroll behind. */
export function Modal({ open, title, onClose, children, footer, size = 'md', role = 'dialog', initialFocus }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useFocusTrap(panel, open, initialFocus)

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && onClose) {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div aria-hidden="true" className="absolute inset-0 bg-scrim" onClick={onClose} />
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn('relative z-10 w-full overflow-hidden rounded-xl border border-border-soft bg-surface-1 shadow-modal', SIZE[size])}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-6">
          <h2 id={titleId} className="text-base font-semibold text-ink">
            {title}
          </h2>
          {onClose ? (
            <button type="button" onClick={onClose} aria-label="Close" className="tap-target -m-2 inline-flex items-center justify-center rounded-lg text-ink-muted hover:bg-surface-2">
              <X aria-hidden="true" size={16} />
            </button>
          ) : null}
        </div>
        <div className="px-6 py-4 text-sm text-ink-muted">{children}</div>
        {footer ? <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border-soft px-6 py-4">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}

export interface ConfirmDialogProps {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  confirmVariant?: ButtonVariant
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Small confirm for destructive or irreversible actions; Cancel gets focus first. */
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = 'Cancel', confirmVariant = 'primary', busy = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      size="sm"
      initialFocus={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  )
}

/**
 * A decision with a consequence — the old build's `ConfirmDialog`
 * (`src/components/overlays.tsx`): what will happen, named plainly, then
 * Cancel and the one action. Content can sit between (an addendum's text).
 */

import type { ReactNode } from 'react'

import { Dialog } from './Dialog'
import { Pill } from './primitives'

export function ConfirmDialog({
  open,
  title,
  consequence,
  confirmLabel,
  onConfirm,
  onCancel,
  tone = 'primary',
  confirmDisabled,
  children,
}: {
  open: boolean
  title: string
  consequence: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  tone?: 'primary' | 'destructive'
  confirmDisabled?: boolean
  children?: ReactNode
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      role="alertdialog"
      tone={tone === 'destructive' ? 'crit' : 'default'}
      footer={
        <>
          <Pill variant="control" size="lg" onClick={onCancel}>
            Cancel
          </Pill>
          <Pill variant={tone === 'destructive' ? 'crit' : 'primary'} size="lg" disabled={confirmDisabled} className="disabled:opacity-40" onClick={onConfirm}>
            {confirmLabel}
          </Pill>
        </>
      }
    >
      <p className="text-[14px]/[1.55] text-sh-text-2">{consequence}</p>
      {children && <div className="mt-[14px]">{children}</div>}
    </Dialog>
  )
}
